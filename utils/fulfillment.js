// utils/fulfillment.js

const mongoose = require('mongoose');

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  /* optional */
}

let Product = null;
try {
  Product = require('../models/Product');
} catch {
  /* should exist */
}

/**
 * Idempotent fulfillment:
 * - Ensures each order is applied once via inventory_ledger (by paypal orderId)
 * - Decrements Product.stock per item, increments soldCount and soldOrders
 * - Optionally marks Order as captured with capturedAt + paypalCaptureId
 *
 * @param {object} args
 * @param {string} args.orderId           PayPal order id you captured
 * @param {string|null} args.paypalCaptureId Optional PayPal capture id
 * @param {Array}  args.itemsFallback     Optional items array if DB not yet available
 */
async function fulfillCapturedOrder({ orderId, paypalCaptureId = null, itemsFallback = [] }) {
  if (!orderId) {return;}

  // 1) Idempotency via inventory_ledger (upsert _id = orderId)
  const coll = mongoose.connection.collection('inventory_ledger');
  const ledger = await coll.findOneAndUpdate(
    { _id: String(orderId) },
    { $setOnInsert: { appliedAt: new Date(), captureId: paypalCaptureId || null } },
    { upsert: true, returnDocument: 'before' },
  );
  if (ledger.value) {
    // already applied — nothing to do
    return;
  }

  // 2) Get items to apply: prefer fallback, else fetch from Order
  let items = Array.isArray(itemsFallback) ? itemsFallback : [];
  if ((!items || items.length === 0) && Order) {
    const doc = await Order.findOne({ paypalOrderId: String(orderId) })
      .select('items status capturedAt')
      .lean();
    if (doc && Array.isArray(doc.items)) {items = doc.items;}
  }
  if (!items || items.length === 0) {return;}

  // 3) Build bulk product updates grouped by product filter
  const opsByKey = new Map();
  for (const it of items) {
    const qty = Math.max(1, Number(it.quantity || 1));
    const productId = it.productId ? String(it.productId) : '';
    const businessId = it.businessId ? String(it.businessId) : null;
    if (!productId) {continue;}

    const isObjectId = /^[0-9a-fA-F]{24}$/.test(productId);
    const filter = isObjectId
      ? { _id: new mongoose.Types.ObjectId(productId) }
      : { customId: productId };
    if (businessId) {filter.business = businessId;}

    const key = JSON.stringify(filter);
    if (!opsByKey.has(key)) {opsByKey.set(key, { filter, dec: 0, incOrders: 0 });}
    const agg = opsByKey.get(key);
    agg.dec += qty;
    agg.incOrders += 1; // count distinct line items as orders
  }

  const bulkOps = [];
  for (const { filter, dec, incOrders } of opsByKey.values()) {
    bulkOps.push({
      updateOne: {
        filter,
        update: {
          $inc: {
            stock: -Math.abs(dec),
            soldCount: Math.abs(dec),
            soldOrders: Math.abs(incOrders),
          },
        },
      },
    });
  }

  if (bulkOps.length && Product) {
    await Product.bulkWrite(bulkOps, { ordered: false });
  }

  // 4) Mark Order as captured (if we have the model)
  if (Order) {
    await Order.updateOne(
      { paypalOrderId: String(orderId) },
      {
        $set: {
          status: 'captured',
          capturedAt: new Date(),
          paypalCaptureId: paypalCaptureId || undefined,
        },
      },
    );
  }
}

module.exports = { fulfillCapturedOrder };
