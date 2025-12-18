// routes/adminOrdersApi.js
const express = require('express');
const { fetch } = require('undici');

let Order = null;
try { Order = require('../models/Order'); } catch {
  // optional model
}

const router = express.Router();
router.use(express.json());

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
  BASE_CURRENCY = 'USD',
} = process.env;

const PP_API =
  PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const upperCcy = String(BASE_CURRENCY || 'USD').toUpperCase();

// -------------------- helpers --------------------
function moneyToNumber(m) {
  if (!m) return 0;
  if (typeof m === 'number') return m;
  if (typeof m === 'string') return Number(m);
  if (typeof m === 'object' && m.value != null) return Number(m.value);
  return 0;
}

function normalizeMoneyNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function safeStr(v, max = 255) {
  return String(v || '').trim().slice(0, max);
}

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function getCaptureIdFromOrder(doc) {
  return (
    doc?.captureId ||
    doc?.capture?.captureId ||
    doc?.capture?.id ||
    doc?.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    doc?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    null
  );
}

async function findOrderByCaptureId(captureId) {
  if (!Order) return null;
  const cid = String(captureId || '').trim();
  if (!cid) return null;

  return Order.findOne({
    $or: [
      { captureId: cid },
      { 'capture.captureId': cid },
      { 'raw.purchase_units.payments.captures.id': cid },
      { 'purchase_units.payments.captures.id': cid },
    ],
  });
}

function getCapturedAmountFromOrder(doc) {
  try {
    const pu = Array.isArray(doc?.raw?.purchase_units) ? doc.raw.purchase_units[0] : null;
    const cap = pu?.payments?.captures?.[0] || null;
    const val = cap?.amount?.value;
    const ccy = cap?.amount?.currency_code || doc?.amount?.currency || upperCcy;
    const n = normalizeMoneyNumber(val);
    return { value: n, currency: ccy };
  } catch {
    return { value: null, currency: doc?.amount?.currency || upperCcy };
  }
}

function sumRefundedFromOrder(doc) {
  try {
    const arr = Array.isArray(doc?.refunds) ? doc.refunds : [];
    let sum = 0;
    for (const r of arr) {
      const n = normalizeMoneyNumber(r?.amount?.value ?? r?.amount ?? r?.value);
      if (n != null) sum += n;
    }
    return +sum.toFixed(2);
  } catch {
    return 0;
  }
}

function wouldExceed(captured, refundedSoFar, want) {
  const remaining = captured - refundedSoFar;
  return want > remaining + 0.00001;
}

// -------------------- LIST --------------------
/**
 * GET /api/admin/orders?limit=100
 * Returns list used by orders-admin.ejs
 */
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
      const currency = o.amount?.currency || o.breakdown?.currency || 'USD';

      const captureId =
        o.captureId ||
        o.capture?.captureId ||
        o.capture?.id ||
        o.raw?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        '';

      const fee = moneyToNumber(o.capture?.sellerReceivable?.paypalFee?.value);
      const net = moneyToNumber(o.capture?.sellerReceivable?.net?.value);

      return {
        createdAt: o.createdAt,
        orderId: o.orderId || o._id?.toString(),
        status: o.status || o.state || '—',
        payerName: o.payer?.name || o.payerName || '',
        payerEmail: o.payer?.email || o.payerEmail || '',
        amount,
        currency,
        fee: Number.isFinite(fee) ? fee : null,
        net: Number.isFinite(net) ? net : null,
        captureId,
        shipment: o.shippingTracking || o.shipment || null,
      };
    });

    return res.json({ ok: true, orders });
  } catch (err) {
    console.error('[adminOrdersApi:list] error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load orders.' });
  }
});

// -------------------- CANCEL --------------------
/**
 * POST /api/admin/orders/:orderId/cancel
 */
router.post('/orders/:orderId/cancel', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const { orderId } = req.params;
    const doc = await Order.findOne({
      $or: [{ orderId }, { paypalOrderId: orderId }, { _id: orderId }],
    });

    if (!doc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    const current = String(doc.status || '').toLowerCase();
    if (current === 'delivered') {
      return res.status(400).json({ ok: false, message: 'Delivered orders cannot be cancelled.' });
    }

    doc.status = 'Cancelled';
    doc.cancelledAt = new Date();
    doc.cancelReason = String(req.body?.reason || 'Admin cancelled');
    await doc.save();

    return res.json({ ok: true });
  } catch (err) {
    console.error('[adminOrdersApi:cancel] error:', err);
    return res.status(500).json({ ok: false, message: 'Cancel failed.' });
  }
});

// -------------------- REFUND (ORDER) --------------------
/**
 * POST /api/admin/orders/:orderId/refund
 * body: { amount?: number|string, note?: string }
 * - amount omitted => full remaining refund
 */
router.post('/orders/:orderId/refund', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const orderId = String(req.params.orderId || '').trim();
    const doc = await Order.findOne({
      $or: [{ orderId }, { paypalOrderId: orderId }, { _id: orderId }],
    });

    if (!doc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    const captureId = getCaptureIdFromOrder(doc);
    if (!captureId) {
      return res.status(400).json({ ok: false, message: 'No captureId found on this order (cannot refund).' });
    }

    // optional partial amount
    const amountNum = normalizeMoneyNumber(req.body?.amount);
    if (amountNum !== null && (!Number.isFinite(amountNum) || amountNum <= 0)) {
      return res.status(400).json({ ok: false, message: 'Amount must be a positive number, or omit for full refund.' });
    }

    // guardrail (if we can calculate captured)
    const captured = getCapturedAmountFromOrder(doc);
    const refundedSoFar = sumRefundedFromOrder(doc);

    let finalRefundAmount = amountNum; // null => full
    if (captured.value != null) {
      const remaining = +(captured.value - refundedSoFar).toFixed(2);
      const want = amountNum === null ? remaining : amountNum;

      if (want <= 0) return res.status(400).json({ ok: false, message: 'Nothing left to refund for this capture.' });
      if (wouldExceed(captured.value, refundedSoFar, want)) {
        return res.status(400).json({
          ok: false,
          message: `Refund exceeds remaining refundable amount (${remaining.toFixed(2)}).`,
        });
      }
      if (amountNum === null) finalRefundAmount = remaining;
    }

    const currency = (doc.amount?.currency || doc.breakdown?.currency || upperCcy).toUpperCase();

    const payload = {};
    if (finalRefundAmount !== null) {
      payload.amount = { value: Number(finalRefundAmount).toFixed(2), currency_code: currency };
    }

    const note = safeStr(req.body?.note, 255);
    if (note) payload.note_to_payer = note;

    const token = await getAccessToken();
    const ppRes = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const refundJson = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error('PayPal refund error:', ppRes.status, refundJson);
      return res.status(502).json({
        ok: false,
        message: refundJson?.message || `PayPal refund failed (${ppRes.status}).`,
        details: refundJson,
      });
    }

    // best-effort: persist audit trail on order
    try {
      doc.refunds = Array.isArray(doc.refunds) ? doc.refunds : [];
      doc.refunds.push({
        refundId: refundJson.id || null,
        captureId,
        status: refundJson.status || null,
        amount: {
          value: refundJson?.amount?.value ?? (finalRefundAmount != null ? String(Number(finalRefundAmount).toFixed(2)) : null),
          currency: refundJson?.amount?.currency_code ?? currency,
        },
        createdAt: new Date(),
        raw: refundJson,
      });

      const newRefundedSoFar = sumRefundedFromOrder(doc);
      if (captured.value != null) {
        if (newRefundedSoFar >= captured.value - 0.00001) doc.status = 'REFUNDED';
        else if (newRefundedSoFar > 0) doc.status = 'PARTIALLY_REFUNDED';
      } else {
        doc.status = 'REFUND_SUBMITTED';
      }

      await doc.save();
    } catch (e) {
      console.warn('Refund saved to PayPal but failed to persist to DB:', e?.message || e);
    }

    return res.json({ ok: true, refund: refundJson });
  } catch (err) {
    console.error('[adminOrdersApi:refund] error:', err?.stack || err);
    return res.status(500).json({ ok: false, message: 'Server error refunding payment.' });
  }
});

// -------------------- REFUND (CAPTURE ID) --------------------
/**
 * POST /api/admin/refunds
 * body: { captureId: string, amount?: number|string, currency?: string, orderId?: string, note?: string }
 */
router.post('/refunds', async (req, res) => {
  try {
    const captureId = safeStr(req.body?.captureId, 128);
    if (!captureId) return res.status(400).json({ ok: false, message: 'captureId is required.' });

    const amountNum = normalizeMoneyNumber(req.body?.amount);
    if (amountNum !== null && (!Number.isFinite(amountNum) || amountNum <= 0)) {
      return res.status(400).json({ ok: false, message: 'Amount must be a positive number, or omit for full refund.' });
    }

    const currency = safeStr(req.body?.currency || upperCcy, 8).toUpperCase();
    const note = safeStr(req.body?.note, 255);

    let orderDoc = null;
    if (Order) {
      orderDoc = await findOrderByCaptureId(captureId);

      const bodyOrderId = safeStr(req.body?.orderId, 64);
      if (bodyOrderId && orderDoc) {
        const dbOrderId = String(orderDoc.orderId || orderDoc.paypalOrderId || orderDoc._id);
        if (dbOrderId !== bodyOrderId) {
          return res.status(400).json({ ok: false, message: 'captureId does not match the provided orderId.' });
        }
      }
    }

    // guardrail if we found an order
    if (orderDoc) {
      const captured = getCapturedAmountFromOrder(orderDoc);
      const refundedSoFar = sumRefundedFromOrder(orderDoc);
      if (captured.value != null) {
        const remaining = +(captured.value - refundedSoFar).toFixed(2);
        const want = amountNum === null ? remaining : amountNum;

        if (want <= 0) return res.status(400).json({ ok: false, message: 'Nothing left to refund for this capture.' });
        if (wouldExceed(captured.value, refundedSoFar, want)) {
          return res.status(400).json({
            ok: false,
            message: `Refund exceeds remaining refundable amount (${remaining.toFixed(2)}).`,
          });
        }
      }
    }

    const payload = {};
    if (amountNum !== null) payload.amount = { value: amountNum.toFixed(2), currency_code: currency };
    if (note) payload.note_to_payer = note;

    const token = await getAccessToken();
    const ppRes = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const refundJson = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error('PayPal refund error:', ppRes.status, refundJson);
      return res.status(502).json({
        ok: false,
        message: refundJson?.message || `PayPal refund failed (${ppRes.status}).`,
        details: refundJson,
      });
    }

    // best-effort persist
    try {
      if (orderDoc) {
        orderDoc.refunds = Array.isArray(orderDoc.refunds) ? orderDoc.refunds : [];
        orderDoc.refunds.push({
          refundId: refundJson.id || null,
          captureId,
          status: refundJson.status || null,
          amount: {
            value: refundJson?.amount?.value ?? (amountNum !== null ? amountNum.toFixed(2) : null),
            currency: refundJson?.amount?.currency_code ?? currency,
          },
          createdAt: new Date(),
          raw: refundJson,
        });

        const captured = getCapturedAmountFromOrder(orderDoc);
        const refundedSoFar = sumRefundedFromOrder(orderDoc);

        if (captured.value != null) {
          if (refundedSoFar >= captured.value - 0.00001) orderDoc.status = 'REFUNDED';
          else if (refundedSoFar > 0) orderDoc.status = 'PARTIALLY_REFUNDED';
        } else {
          orderDoc.status = 'REFUND_SUBMITTED';
        }

        await orderDoc.save();
      }
    } catch (e) {
      console.warn('Refund saved to PayPal but failed to persist to DB:', e?.message || e);
    }

    return res.json({ ok: true, refund: refundJson });
  } catch (err) {
    console.error('[adminOrdersApi:refunds] error:', err?.stack || err);
    return res.status(500).json({ ok: false, message: 'Server error refunding payment.' });
  }
});

module.exports = router;
