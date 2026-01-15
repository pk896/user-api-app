// utils/payouts/creditSellersFromOrder.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

let Product = null;
try {
  Product = require('../../models/Product');
} catch {
  // optional
}

const { moneyToCents } = require('../money');

function toUpper(v, fallback = 'USD') {
  const s = String(v || '').trim().toUpperCase();
  return s || fallback;
}

function safeId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

// ✅ NEW: ObjectId helper (important for ledger consistency)
function toObjectId(v) {
  const id = safeId(v);
  return id ? new mongoose.Types.ObjectId(id) : null;
}

function getProductOwnerBusinessId(p) {
  const candidates = [
    p.business,
    p.businessId,
    p.seller,
    p.sellerId,
    p.ownerBusiness,
    p.ownerBusinessId,
  ];

  for (const c of candidates) {
    const id = safeId(c);
    if (id) return id;
  }
  return null;
}

function isPaidLikeNormalized(order) {
  const s = String(order?.status || '').trim();
  if (!s) return false;

  const up = s.toUpperCase();
  if (['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'].includes(up)) return true;

  if (typeof order?.isPaidLike === 'function') {
    try {
      return !!order.isPaidLike();
    } catch {
      return false;
    }
  }

  return false;
}

function payoutDelayMs() {
  const daysRaw = Number(process.env.SELLER_PAYOUT_DELAY_DAYS ?? 3);
  const days = Number.isFinite(daysRaw) ? Math.max(0, Math.min(30, Math.trunc(daysRaw))) : 3;
  return days * 24 * 60 * 60 * 1000;
}

async function creditSellersFromOrder(order, opts = {}) {
  const {
    platformFeeBps = 1000, // 10%
    onlyIfPaidLike = false,
  } = opts;

  if (!order) return { credited: 0, skipped: 'no-order' };

  if (onlyIfPaidLike && !isPaidLikeNormalized(order)) {
    return { credited: 0, skipped: 'not-paid' };
  }

  if (!Product) return { credited: 0, skipped: 'product-model-missing' };

  const orderId = safeId(order?._id);
  if (!orderId) return { credited: 0, skipped: 'missing-order-_id' };

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return { credited: 0, skipped: 'no-items' };

  // ✅ clamp fee bps (protect against bad config)
  const feeBps = Math.max(0, Math.min(5000, Number(platformFeeBps || 0)));

  // ✅ enforce single currency per order (safer)
  const currency = toUpper(order?.amount?.currency || 'USD');

  for (const item of items) {
    const itemCcy = toUpper(item?.price?.currency || currency);
    if (itemCcy !== currency) {
      return { credited: 0, skipped: `mixed-currency:${currency}:${itemCcy}` };
    }
  }

  const productIds = [
    ...new Set(items.map((i) => String(i.productId || '').trim()).filter(Boolean)),
  ];
  if (!productIds.length) return { credited: 0, skipped: 'no-productIds' };

  const products = await Product.find({ customId: { $in: productIds } })
    .select('customId business businessId seller sellerId ownerBusiness ownerBusinessId')
    .lean();

  const byCustomId = new Map(products.map((p) => [String(p.customId), p]));

  // ✅ Aggregate per seller + productCustomId to avoid duplicate uniqueKey under-crediting
  const agg = new Map();

  for (const item of items) {
    const customId = String(item.productId || '').trim();
    if (!customId) continue;

    const product = byCustomId.get(customId);
    if (!product) continue;

    const sellerBusinessIdStr = getProductOwnerBusinessId(product);
    const sellerBusinessObjId = toObjectId(sellerBusinessIdStr);
    if (!sellerBusinessObjId) continue;

    const qtyRaw = Number(item.quantity != null ? item.quantity : 1);
    const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.trunc(qtyRaw)) : 1;

    const unitCents = moneyToCents(item?.price?.value);
    if (!Number.isFinite(unitCents) || unitCents <= 0) continue;

    const grossCents = unitCents * qty;
    if (!Number.isFinite(grossCents) || grossCents <= 0) continue;

    const feeCents = Math.round((grossCents * feeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (!Number.isFinite(netCents) || netCents <= 0) continue;

    const key = `${String(sellerBusinessObjId)}:${customId}`;

    const prev = agg.get(key) || {
      sellerBusinessObjId,
      sellerBusinessIdStr: String(sellerBusinessIdStr),
      customId,
      qty: 0,
      grossCents: 0,
      feeCents: 0,
      netCents: 0,
    };

    prev.qty += qty;
    prev.grossCents += grossCents;
    prev.feeCents += feeCents;
    prev.netCents += netCents;

    agg.set(key, prev);
  }

    const wanted = [];

  for (const row of agg.values()) {
    if (!row.netCents || row.netCents <= 0) continue;

    const uniqueKey = `earn:${String(orderId)}:${row.customId}:${row.sellerBusinessIdStr}`;

    wanted.push({
      businessId: row.sellerBusinessObjId,
      type: 'EARNING',
      amountCents: Math.trunc(row.netCents),
      currency,

      // ✅ pending window before it becomes "AVAILABLE"
      availableAt: new Date(Date.now() + payoutDelayMs()),

      orderId: new mongoose.Types.ObjectId(orderId),
      note: `Net earnings for order ${order.orderId || String(orderId)} (${row.customId})`,
      meta: {
        uniqueKey,
        productCustomId: row.customId,
        qty: row.qty,
        grossCents: Math.trunc(row.grossCents),
        feeCents: Math.trunc(row.feeCents),
        platformFeeBps: feeBps,
      },
    });
  }

  if (!wanted.length) return { credited: 0, skipped: 'no-creditable-items' };

  const keys = wanted.map((w) => w.meta.uniqueKey);
  const existing = await SellerBalanceLedger.find({
    type: 'EARNING',
    orderId: new mongoose.Types.ObjectId(orderId),
    'meta.uniqueKey': { $in: keys },
  })
    .select('meta.uniqueKey')
    .lean();

  const existingKeys = new Set(existing.map((e) => String(e?.meta?.uniqueKey || '')));
  const toCreate = wanted.filter((w) => !existingKeys.has(w.meta.uniqueKey));

  if (!toCreate.length) return { credited: 0, skipped: 'all-already-credited' };

  try {
    await SellerBalanceLedger.insertMany(toCreate, { ordered: false });
  } catch (e) {
    const msg = String(e?.message || '');
    if (!msg.includes('E11000')) throw e;
  }

  return {
    credited: toCreate.length,
    currency,
    feeBps,
  };
}

module.exports = { creditSellersFromOrder };
