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

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function toUpper(v, fallback = null) {
  const s = String(v || '').trim().toUpperCase();
  return s || (fallback || getBaseCurrency());
}

function safeId(v) {
  // supports raw ObjectId, string, or populated object {_id}
  const raw = v?._id || v;
  const id = String(raw || '').trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

function toObjectId(v) {
  const id = safeId(v);
  return id ? new mongoose.Types.ObjectId(id) : null;
}

function getProductOwnerBusinessId(p) {
  // ✅ support both direct IDs and populated objects
  const candidates = [
    p?.business?._id, p?.business,
    p?.businessId?._id, p?.businessId,
    p?.seller?._id, p?.seller,
    p?.sellerId?._id, p?.sellerId,
    p?.ownerBusiness?._id, p?.ownerBusiness,
    p?.ownerBusinessId?._id, p?.ownerBusinessId,
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
  const daysRaw = Number(process.env.SELLER_PAYOUT_DELAY_DAYS ?? 2);
  const days = Number.isFinite(daysRaw) ? Math.max(0, Math.min(30, Math.trunc(daysRaw))) : 3;
  return days * 24 * 60 * 60 * 1000;
}

function normalizeItemCurrency(item, fallbackOrderCurrency) {
  // ✅ tolerate missing item currency; default to order currency (or BASE_CURRENCY)
  const raw =
    item?.price?.currency ??
    item?.currency ??
    item?.amount?.currency ??
    fallbackOrderCurrency;

  return toUpper(raw, fallbackOrderCurrency || getBaseCurrency());
}

function getItemUnitCents(item) {
  // ✅ support multiple item shapes
  const raw =
    item?.price?.value ??
    item?.price?.amount ??
    item?.unitPrice?.value ??
    item?.unitPrice ??
    item?.amount?.value ??
    item?.amount ??
    item?.price;

  const cents = moneyToCents(raw);
  return Number.isFinite(cents) ? cents : NaN;
}

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
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

  const feeBps = Math.max(0, Math.min(5000, Number(platformFeeBps || 0)));

  // ✅ Choose a safe order currency fallback
  const orderCurrency = toUpper(
    order?.amount?.currency ||
    order?.breakdown?.currency ||
    order?.capture?.amount?.currency ||
    getBaseCurrency()
  );

  // ✅ Build both customId and ObjectId candidate sets from order items
  const customIds = new Set();
  const objectIds = [];

  for (const item of items) {
    const rawPid = item?.productId?._id || item?.productId || item?.product || item?.product?._id;
    const pidStr = String(rawPid || '').trim();
    if (!pidStr) continue;

    // If it looks like ObjectId, keep it for _id lookup too
    if (mongoose.isValidObjectId(pidStr)) objectIds.push(new mongoose.Types.ObjectId(pidStr));

    // Also keep raw string for customId lookup
    customIds.add(pidStr);
  }

  if (!customIds.size && !objectIds.length) {
    return { credited: 0, skipped: 'no-productIds' };
  }

  // ✅ Find products by customId OR _id (important)
  const products = await Product.find({
    $or: [
      { customId: { $in: [...customIds] } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  })
    .select('_id customId business businessId seller sellerId ownerBusiness ownerBusinessId')
    .lean();

  if (!products.length) {
    return {
      credited: 0,
      skipped: 'products-not-found',
      debug: { customIdsCount: customIds.size, objectIdsCount: objectIds.length },
    };
  }

  // Map by both customId and _id
  const byKey = new Map();
  for (const p of products) {
    if (p?.customId) byKey.set(String(p.customId), p);
    if (p?._id) byKey.set(String(p._id), p);
  }

  // ✅ Aggregate by seller + product (professional split)
  const agg = new Map();

  // currency guard (collect stats instead of hard-failing whole order immediately)
  let mixedCurrencyDetected = false;

  for (const item of items) {
    const rawPid = item?.productId?._id || item?.productId || item?.product || item?.product?._id;
    const pidKey = String(rawPid || '').trim();
    if (!pidKey) continue;

    const product = byKey.get(pidKey);
    if (!product) continue;

    const sellerBusinessIdStr = getProductOwnerBusinessId(product);
    const sellerBusinessObjId = toObjectId(sellerBusinessIdStr);
    if (!sellerBusinessObjId) continue;

    const qtyRaw = Number(item.quantity != null ? item.quantity : 1);
    const qty = Number.isFinite(qtyRaw) ? Math.max(1, Math.trunc(qtyRaw)) : 1;

    const unitCents = getItemUnitCents(item);
    if (!Number.isFinite(unitCents) || unitCents <= 0) continue;

    const itemCurrency = normalizeItemCurrency(item, orderCurrency);
    if (itemCurrency !== orderCurrency) {
      mixedCurrencyDetected = true;
      // ✅ skip only bad line item, not whole order
      continue;
    }

    const grossCents = unitCents * qty;
    if (!Number.isFinite(grossCents) || grossCents <= 0) continue;

    const feeCents = Math.round((grossCents * feeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (!Number.isFinite(netCents) || netCents <= 0) continue;

    const productKey = String(product.customId || product._id);
    const key = `${String(sellerBusinessObjId)}:${productKey}`;

    const prev = agg.get(key) || {
      sellerBusinessObjId,
      sellerBusinessIdStr: String(sellerBusinessIdStr),
      productKey,
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

    const uniqueKey = `earn:${String(orderId)}:${row.productKey}:${row.sellerBusinessIdStr}`;

    wanted.push({
      businessId: row.sellerBusinessObjId,
      type: 'EARNING',
      amountCents: Math.trunc(row.netCents),
      currency: orderCurrency,
      availableAt: new Date(Date.now() + payoutDelayMs()),
      orderId: new mongoose.Types.ObjectId(orderId),
      note: `Net earnings for order ${order.orderId || String(orderId)} (${row.productKey})`,
      meta: {
        uniqueKey,
        productCustomId: row.productKey,
        qty: row.qty,
        grossCents: Math.trunc(row.grossCents),
        feeCents: Math.trunc(row.feeCents),
        platformFeeBps: feeBps,
      },
    });
  }

  if (!wanted.length) {
    return {
      credited: 0,
      skipped: 'no-creditable-items',
      debug: {
        mixedCurrencyDetected,
        itemsCount: items.length,
        productsFound: products.length,
      },
    };
  }

  // ✅ Idempotent write path (race-safe):
  // Use upserts keyed by businessId + type + orderId + meta.uniqueKey
  // so duplicate calls cannot create duplicate earnings.
  const ops = wanted.map((w) => ({
    updateOne: {
      filter: {
        businessId: w.businessId,
        type: 'EARNING',
        orderId: w.orderId,
        'meta.uniqueKey': w.meta.uniqueKey,
      },
      update: {
        $setOnInsert: {
          amountCents: w.amountCents,
          currency: w.currency,
          availableAt: w.availableAt,
          note: w.note,
          meta: {
            ...w.meta,
            orderPublicId: String(order.orderId || orderId),
          },
        },
      },
      upsert: true,
    },
  }));

  let upsertedCount = 0;

  try {
    const wr = await SellerBalanceLedger.bulkWrite(ops, { ordered: false });
    upsertedCount = Number(wr?.upsertedCount || 0);
  } catch (e) {
    // ✅ If another request inserted the same row first, treat as idempotent success
    if (!isDupKey(e)) throw e;

    // In duplicate-race cases, some rows may already have been inserted.
    // We count this as 0 newly credited because duplicates are harmless and expected.
    upsertedCount = 0;
  }

  if (!upsertedCount) {
    return {
      credited: 0,
      skipped: 'all-already-credited',
      debug: { wanted: wanted.length },
      currency: orderCurrency,
      feeBps,
      mixedCurrencyDetected,
    };
  }

  return {
    credited: upsertedCount,
    currency: orderCurrency,
    feeBps,
    mixedCurrencyDetected,
  };
}

module.exports = { creditSellersFromOrder };