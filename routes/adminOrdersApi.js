// routes/adminOrdersApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { fetch } = require('undici');

const requireAdmin = require('../middleware/requireAdmin');

// -------------------- Model --------------------
let Order = null;
try {
  Order = require('../models/Order');
} catch {
  Order = null;
}

let Product = null;
try {
  Product = require('../models/Product');
} catch {
  Product = null;
}

// Optional (don’t crash other flows)
let debitSellersFromRefund = null;
try {
  ({ debitSellersFromRefund } = require('../utils/payouts/debitSellersFromRefund'));
} catch {
  debitSellersFromRefund = null;
}

const router = express.Router();

// ✅ lock ALL admin orders API
router.use(requireAdmin);

// -------------------- ENV --------------------
const BASE_CURRENCY = process.env.BASE_CURRENCY || process.env.CURRENCY || 'USD';
const upperCcy = String(BASE_CURRENCY).toUpperCase();

// -------------------- PayPal ENV + helpers --------------------
const PAYPAL_MODE = String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
const PP_API = PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function getPaypalAccessToken() {
  const clientId = mustEnv('PAYPAL_CLIENT_ID');
  const secret = mustEnv('PAYPAL_CLIENT_SECRET');
  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const r = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const text = await r.text().catch(() => '');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!r.ok) {
    const msg =
      data?.error_description || data?.message || data?.name ||
      (typeof data?.raw === 'string' ? data.raw.slice(0, 200) : '') ||
      `PayPal token error (${r.status})`;
    throw new Error(msg);
  }

  return data.access_token;
}

async function refundPaypalCaptureFull({ captureId, refundId }) {
  const token = await getPaypalAccessToken();

  // Full refund = empty payload
  const r = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',

      // ✅ PayPal idempotency key
      ...(refundId ? { 'PayPal-Request-Id': String(refundId) } : {}),
    },
    body: JSON.stringify({}),
  });

  const json = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = json?.message || json?.name || json?.details?.[0]?.issue || `PayPal refund failed (${r.status})`;
    const err = new Error(msg);
    err.details = json;
    err.status = r.status;
    throw err;
  }

  return json;
}

// -------------------- helpers --------------------
function buildOrderLookupOr(orderId) {
  const ors = [{ orderId }, { paypalOrderId: orderId }, { 'paypal.orderId': orderId }];

  // ✅ only query _id if it’s a real ObjectId
  if (mongoose.isValidObjectId(orderId)) {
    ors.push({ _id: orderId });
  }

  return ors;
}

function moneyToNumber(m) {
  if (!m) return 0;
  if (typeof m === 'number') return m;
  if (typeof m === 'string') return Number(m);
  if (typeof m === 'object' && m.value != null) return Number(m.value);
  return 0;
}

function getCaptureIdFromOrder(doc) {
  return (
    doc?.captureId ||
    doc?.capture?.captureId ||
    doc?.capture?.id ||
    doc?.paypal?.captureId ||
    doc?.captures?.[0]?.captureId ||
    doc?.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    doc?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    null
  );
}

function toUpper(v, fallback = '') {
  const s = String(v || '').trim().toUpperCase();
  return s || fallback;
}

// -------------------- Inventory restore helpers --------------------
async function restoreOneProductStockByCustomId(productCustomId, qty) {
  if (!Product) return { ok: false, skipped: 'Product model not available' };

  const pid = String(productCustomId || '').trim();
  const q = Number(qty || 0);
  if (!pid || !Number.isFinite(q) || q <= 0) return { ok: false, skipped: 'bad-line' };

  // Your Product model uses customId (string)
  const doc = await Product.findOne({ customId: pid }).select('_id stock customId').lean();
  if (!doc) return { ok: false, skipped: 'product-not-found', productId: pid };

  // ✅ exact field from your Product.js: stock
  await Product.updateOne({ _id: doc._id }, { $inc: { stock: q } }, { strict: false });

  return { ok: true, productId: pid, inc: q };
}

async function restoreInventoryFromOrder(orderDoc) {
  const adjusted = Array.isArray(orderDoc?.inventoryAdjustedItems)
    ? orderDoc.inventoryAdjustedItems
    : [];

  if (!adjusted.length) {
    return { restored: 0, skipped: 'no-inventoryAdjustedItems' };
  }

  let restored = 0;
  const results = [];

  for (const it of adjusted) {
    const pid = String(it?.productId || '').trim();
    const qty = Number(it?.quantity || 0);
    if (!pid || !Number.isFinite(qty) || qty <= 0) continue;

    const r = await restoreOneProductStockByCustomId(pid, qty);
    results.push(r);
    if (r.ok) restored += 1;
  }

  return { restored, results };
}

// -------------------- LIST --------------------
// GET /api/admin/orders?limit=100
router.get('/orders', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));

    const docs = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const orders = docs.map((o) => {
      const amount = moneyToNumber(o.amount?.value ?? o.amount);
      const currency = o.amount?.currency || o.breakdown?.currency || o.currency || upperCcy;

      const captureId = getCaptureIdFromOrder(o) || '';

      const refundsCount = Array.isArray(o.refunds) ? o.refunds.length : 0;
      const refundedTotal = o.refundedTotal ?? null;

      return {
        createdAt: o.createdAt,
        orderId: o.orderId || o.paypalOrderId || o._id?.toString(),

        status: String(o.status || o.state || '—').trim().toUpperCase(),

        payerName: o.payer?.name
          ? `${o.payer?.name?.given || ''} ${o.payer?.name?.surname || ''}`.trim()
          : o.payerName || '',
        payerEmail: o.payer?.email_address || o.payerEmail || o.payer?.email || '',
        amount: Number.isFinite(amount) ? amount : 0,
        currency: String(currency || upperCcy).toUpperCase(),
        captureId,

        // ✅ helpful for UI/debug
        refundsCount,
        refundedTotal,
      };
    });

    return res.json({ ok: true, orders });
  } catch (err) {
    console.error('[adminOrdersApi:list] error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load orders.' });
  }
});

// -------------------- REFUND + DEBIT SELLERS + RESTORE INVENTORY --------------------
// POST /api/admin/orders/:orderId/refund
//
// Body (JSON):
// {
//   "refundId": "your-idempotency-key",   // REQUIRED (string)
// "amount" is NOT allowed (FULL refund only). If sent, request is rejected.
//   "currency": "CURRENCY",                   // OPTIONAL
//   "reason": "Admin refund",            // OPTIONAL
//   "allowWhenUnpaid": true              // OPTIONAL (default true)
// }
//
// ✅ Does NOT touch payment.js
router.post('/orders/:orderId/refund', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });
    if (!debitSellersFromRefund) {
      return res.status(500).json({
        ok: false,
        message: 'Refund debit util not available (utils/payouts/debitSellersFromRefund.js).',
      });
    }

    const orderIdParam = String(req.params.orderId || '').trim();
    const refundId = String(req.body?.refundId || '').trim();

    if (!refundId) {
      return res.status(400).json({ ok: false, message: 'refundId is required (idempotency key).' });
    }

    // ✅ FULL REFUND ONLY: do NOT allow partial refunds via amount
    const amount = req.body?.amount;

    // If client sends amount in any form, reject it.
    if (amount != null && String(amount).trim() !== '') {
      return res.status(400).json({
        ok: false,
        message: 'This endpoint is FULL REFUND ONLY. Do not send "amount".',
      });
    }

    const currency =
      toUpper(req.body?.currency) ||
      toUpper(req.body?.ccy) ||
      toUpper(req.body?.curr) ||
      upperCcy;

    const allowWhenUnpaid =
      typeof req.body?.allowWhenUnpaid === 'boolean' ? req.body.allowWhenUnpaid : true;

    const reason = String(req.body?.reason || 'Admin refund').trim();

    const orderDoc = await Order.findOne({ $or: buildOrderLookupOr(orderIdParam) });
    if (!orderDoc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    const st = String(orderDoc.status || '').trim().toUpperCase();
    if (st === 'REFUNDED') {
      return res.status(400).json({ ok: false, message: 'Order is already REFUNDED.' });
    }

    // ✅ Idempotency FIRST: if refundId already exists on order, do nothing
    const existingRefund = Array.isArray(orderDoc.refunds)
      ? orderDoc.refunds.find((r) => String(r?.refundId || '').trim() === refundId)
      : null;

    if (existingRefund) {
      return res.json({
        ok: true,
        message: 'Refund already recorded for this refundId (idempotent).',
        refund: existingRefund,
      });
    }

    // ✅ PAYPAL REFUND (FULL) — THIS is what updates PayPal
    const captureId = getCaptureIdFromOrder(orderDoc);
    if (!captureId) {
      return res.status(400).json({
        ok: false,
        message: 'This order has no captureId saved, so PayPal refund cannot be performed.',
      });
    }

    let paypalRefund = null;
    try {
      paypalRefund = await refundPaypalCaptureFull({ captureId, refundId });
    } catch (e) {
      console.error('[adminOrdersApi:refund] PayPal refund failed:', e?.message || e, e?.details || '');
      return res.status(502).json({
        ok: false,
        message: e?.message || 'PayPal refund failed.',
        details: String(process.env.NODE_ENV || '').toLowerCase() === 'production'
          ? undefined
          : e?.details,
      });
    }

    // ✅ Re-check idempotency AFTER PayPal (handles double-click / race)
    const freshOrder = await Order.findOne({ _id: orderDoc._id }).lean();

    const existingAfterPaypal = Array.isArray(freshOrder?.refunds)
      ? freshOrder.refunds.find((r) => String(r?.refundId || '').trim() === refundId)
      : null;

    if (existingAfterPaypal) {
      // ✅ If PayPal already refunded + refund record exists,
      // but DB status is not REFUNDED, fix DB now (no seller debit, no inventory).
      const dbStatusNow = String(freshOrder?.status || '').trim().toUpperCase();
      if (dbStatusNow !== 'REFUNDED') {
        await Order.updateOne(
          { _id: orderDoc._id },
          {
            $set: {
              status: 'REFUNDED',
              paymentStatus: 'REFUNDED',
              refundedAt: existingAfterPaypal?.createdAt || freshOrder?.refundedAt || new Date(),
            },
          },
          { strict: false },
        );
      }

      return res.json({
        ok: true,
        message: 'Refund already recorded for this refundId (idempotent).',
        refund: existingAfterPaypal,
        paypalRefundId: paypalRefund?.id || null,
        paypalRefundStatus: paypalRefund?.status || null,
        dbFixed: dbStatusNow !== 'REFUNDED',
      });
    }

    // 1) Debit sellers (NET) using your util (idempotent by uniqueKey inside ledger)
    const debitResult = await debitSellersFromRefund(orderDoc, {
      refundId,
      amount: null, // ✅ FULL REFUND ONLY
      currency,
      allowWhenUnpaid,
      platformFeeBps:
        Number(orderDoc.platformFeeBps ?? process.env.PLATFORM_FEE_BPS ?? 1000) || 1000,
    });

    // 2) Update Order refund fields (DB evidence)
    const prevRefunded = Number(orderDoc.refundedTotal || '0');
    const prevRefundedSafe = Number.isFinite(prevRefunded) ? prevRefunded : 0;

    const orderGross = moneyToNumber(orderDoc.amount?.value ?? orderDoc.amount);
    const orderGrossSafe = Number.isFinite(orderGross) ? orderGross : 0;

    // ✅ Prefer PayPal-confirmed refund amount when available
    const paypalValue = Number(paypalRefund?.amount?.value ?? null);
    const paypalAmountSafe = Number.isFinite(paypalValue) ? paypalValue : null;

    const addGross = paypalAmountSafe !== null
      ? paypalAmountSafe
      : (orderGrossSafe - prevRefundedSafe);

    const addGrossSafe = Number.isFinite(addGross) ? Math.max(0, addGross) : 0;

    // new refunded total (cap at order amount)
    const nextRefunded = Math.min(orderGrossSafe, prevRefundedSafe + addGrossSafe);

    // ✅ FULL REFUND ONLY: after lock, this should always resolve to REFUNDED
    const isFullRefund = true;
    const newStatus = 'REFUNDED';

    // Push refund record
    orderDoc.refunds = Array.isArray(orderDoc.refunds) ? orderDoc.refunds : [];
    orderDoc.refunds.push({
      refundId,
      status: String(paypalRefund?.status || 'SUBMITTED').toUpperCase(),
      amount: String(addGrossSafe.toFixed(2)),
      currency,
      source: `admin:${reason}`,
      createdAt: new Date(),
    });

    orderDoc.refundedTotal = String(nextRefunded.toFixed(2));
    orderDoc.refundedAt = new Date();

    orderDoc.status = newStatus;
    orderDoc.paymentStatus = newStatus;

    // 3) Restore inventory ONLY on full refund, and only once
    let invRestore = { skipped: 'not-run-yet' };
    if (isFullRefund) {
      if (orderDoc.inventoryRestored === true) {
        invRestore = { skipped: 'inventory-already-restored' };
      } else {
        invRestore = await restoreInventoryFromOrder(orderDoc);
        // mark restored even if some products missing: prevents double restores
        orderDoc.inventoryRestored = true;
      }
    }

    await orderDoc.save();

    return res.json({
      ok: true,
      message: 'Refund recorded (full) + PayPal refunded + inventory restored.',
      refundId,
      currency,
      status: newStatus,
      refundedTotal: orderDoc.refundedTotal,
      paypalRefundId: paypalRefund?.id || null,
      paypalRefundStatus: paypalRefund?.status || null,
      debitResult,
      invRestore,
    });
  } catch (err) {
    console.error('[adminOrdersApi:refund] error:', err);
    return res.status(500).json({ ok: false, message: 'Refund failed.' });
  }
});

// -------------------- DELETE (DB only) --------------------
// DELETE /api/admin/orders/:orderId
router.delete('/orders/:orderId', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const orderId = String(req.params.orderId || '').trim();

    const doc = await Order.findOne({
      $or: buildOrderLookupOr(orderId),
    });

    if (!doc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    // Safety: don’t allow deleting delivered orders
    const st = String(doc.status || '').toLowerCase();
    if (st === 'delivered') {
      return res.status(400).json({ ok: false, message: 'Delivered orders cannot be deleted.' });
    }

    await Order.deleteOne({ _id: doc._id });

    return res.json({ ok: true });
  } catch (err) {
    console.error('[adminOrdersApi:delete] error:', err);
    return res.status(500).json({ ok: false, message: 'Delete failed.' });
  }
});

module.exports = router;
