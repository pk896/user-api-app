// utils/payouts/creditSellersFromOrder.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

let Product = null;
try {
  Product = require('../../models/Product');
} catch {
  // if Product model path differs, adjust
}

const { moneyToCents } = require('../money');

function getProductOwnerBusinessId(p) {
  // Try common patterns used in your codebase
  const candidates = [
    p.business,           // ObjectId
    p.businessId,         // ObjectId
    p.seller,             // ObjectId
    p.sellerId,           // ObjectId
    p.ownerBusiness,      // ObjectId
    p.ownerBusinessId,    // ObjectId
  ];

  for (const c of candidates) {
    if (!c) continue;
    const id = String(c?._id || c);
    if (mongoose.isValidObjectId(id)) return id;
  }
  return null;
}

async function creditSellersFromOrder(order, opts = {}) {
  const {
    platformFeeBps = 1000, // 10% (bps = basis points). Change anytime.
    onlyIfPaidLike = true,
  } = opts;

  if (!order) return { credited: 0, skipped: 'no-order' };
  if (onlyIfPaidLike && typeof order.isPaidLike === 'function' && !order.isPaidLike()) {
    return { credited: 0, skipped: 'not-paid' };
  }

  if (order.sellerEarningsCredited) {
    return { credited: 0, skipped: 'already-credited-flag' };
  }

  if (!Product) throw new Error('Product model not available for seller crediting.');

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return { credited: 0, skipped: 'no-items' };

  const currency =
    String(order?.amount?.currency || items?.[0]?.price?.currency || 'USD').toUpperCase();

  // Fetch products by customId (your OrderItemSchema.productId is Product.customId string)
  const productIds = [...new Set(items.map(i => String(i.productId || '').trim()).filter(Boolean))];

  const products = await Product.find({ customId: { $in: productIds } })
    .select('customId business businessId seller sellerId ownerBusiness ownerBusinessId')
    .lean();

  const byCustomId = new Map(products.map(p => [String(p.customId), p]));

  let creditedCount = 0;

  for (const item of items) {
    const customId = String(item.productId || '').trim();
    if (!customId) continue;

    const product = byCustomId.get(customId);
    if (!product) continue;

    const sellerBusinessId = getProductOwnerBusinessId(product);
    if (!sellerBusinessId) continue;

    const qty = Math.max(1, Number(item.quantity || 1));

    // unit price snapshot stored as string -> cents
    const unitCents = moneyToCents(item?.price?.value);
    const grossCents = unitCents * qty;

    if (grossCents <= 0) continue;

    // fee + net (integer math)
    const feeCents = Math.round((grossCents * platformFeeBps) / 10000);
    const netCents = grossCents - feeCents;

    if (netCents <= 0) continue;

    // ✅ idempotency: unique key per order+product+seller
    const uniqueKey = `earn:${String(order._id)}:${customId}:${sellerBusinessId}`;

    const exists = await SellerBalanceLedger.findOne({
      type: 'EARNING',
      orderId: order._id,
      businessId: sellerBusinessId,
      'meta.uniqueKey': uniqueKey,
    }).select('_id').lean();

    if (exists) continue;

    await SellerBalanceLedger.create({
      businessId: sellerBusinessId,
      type: 'EARNING',
      amountCents: netCents,
      currency,
      orderId: order._id,
      note: `Net earnings for order ${order.orderId || order._id} (${customId})`,
      meta: {
        uniqueKey,
        productCustomId: customId,
        qty,
        unitCents,
        grossCents,
        feeCents,
        platformFeeBps,
      },
    });

    creditedCount += 1;
  }

  return { credited: creditedCount };
}

module.exports = { creditSellersFromOrder };
