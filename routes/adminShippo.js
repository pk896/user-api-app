// routes/adminShippo.js
'use strict';

const express = require('express');
const router = express.Router();
const { fetch } = require('undici');

const Order = require('../models/Order');
const { createLabelForOrder } = require('../utils/shippo/createLabelForOrder');
const { addTrackingToPaypalOrder } = require('../utils/paypal/addTrackingToPaypalOrder');

// ------------------------------------------------------
// Small helpers (safe + simple)
// ------------------------------------------------------
function inferCarrierLabelFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return '';
  if (u.includes('dhl')) return 'DHL';
  if (u.includes('fedex')) return 'FEDEX';
  if (u.includes('ups')) return 'UPS';
  if (u.includes('usps') || u.includes('postal')) return 'USPS';
  return '';
}

function _normCarrier(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ------------------------------------------------------
// Shippo direct fetch helpers (NO parcel/customs building)
// ------------------------------------------------------
const SHIPPO_BASE = 'https://api.goshippo.com';
function getShippoToken() {
  return String(process.env.SHIPPO_TOKEN || '').trim();
}

function mustShippoToken() {
  const tok = getShippoToken();
  if (!tok) {
    const err = new Error('SHIPPO_TOKEN is missing in .env');
    err.code = 'SHIPPO_NOT_CONFIGURED';
    throw err;
  }
  return tok;
}

function shippoHeaders() {
  const tok = mustShippoToken();
  return {
    Authorization: `ShippoToken ${tok}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function shippoGetJson(path, { timeoutMs = 20000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(`${SHIPPO_BASE}${path}`, {
      method: 'GET',
      headers: shippoHeaders(),
      signal: ac.signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.detail || json?.message || JSON.stringify(json);
      const err = new Error(`Shippo GET ${path} failed (${res.status}): ${msg}`);
      err.code = 'SHIPPO_GET_FAILED';
      err.shippo = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// Poll shipment until rates exist (Shippo can be slow)
async function shippoPollShipmentRates(shipmentId, { tries = 10, delayMs = 1500 } = {}) {
  const sid = String(shipmentId || '').trim();
  if (!sid) throw new Error('Missing shipmentId for Shippo poll.');

  for (let i = 0; i < tries; i++) {
    const shipment = await shippoGetJson(`/shipments/${encodeURIComponent(sid)}/`, { timeoutMs: 25000 });
    const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];

    // Shippo sometimes uses object_status to indicate readiness/errors
    const st = String(shipment?.object_status || '').toUpperCase();
    if (st === 'ERROR') {
      const err = new Error(`Shippo shipment object_status=ERROR: ${JSON.stringify(shipment?.messages || [])}`);
      err.code = 'SHIPPO_SHIPMENT_OBJECT_ERROR';
      err.shippo = shipment;
      throw err;
    }

    if (rates.length) return { shipment, rates };
    await sleep(delayMs);
  }

  const last = await shippoGetJson(`/shipments/${encodeURIComponent(sid)}/`, { timeoutMs: 25000 });
  return { shipment: last, rates: Array.isArray(last?.rates) ? last.rates : [] };
}

// ------------------------------------------------------
// Admin guard (PROD SAFE)
// ------------------------------------------------------
let requireAdmin = null;
try {
  requireAdmin = require('../middleware/requireAdmin');
} catch {
  requireAdmin = (req, res, next) =>
    req.session?.admin ? next() : res.status(401).json({ ok: false, message: 'Unauthorized' });
}

// ------------------------------------------------------
// Enum-safe mapping for shippingTracking.status + fulfillmentStatus
// (we keep this because those fields can still be enums)
// ------------------------------------------------------
function getTrackingStatusEnumValues(orderDoc) {
  const p =
    orderDoc?.schema?.path('shippingTracking.status') ||
    orderDoc?.constructor?.schema?.path('shippingTracking.status');
  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function getFulfillmentEnumValues(orderDoc) {
  const p =
    orderDoc?.schema?.path('fulfillmentStatus') ||
    orderDoc?.constructor?.schema?.path('fulfillmentStatus');
  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function mapToEnum(desired, enumValues) {
  const want = _normCarrier(desired);
  if (!want) return null;

  // 1) exact normalized match
  for (const ev of enumValues) {
    if (_normCarrier(ev) === want) return ev;
  }

  // 2) fallbacks in best-effort order
  const fallbackOrder = ['PROCESSING', 'PRE_TRANSIT', 'PENDING', 'SHIPPED', 'IN_TRANSIT', 'CREATED', 'UNKNOWN'];
  for (const fb of fallbackOrder) {
    for (const ev of enumValues) {
      if (_normCarrier(ev) === _normCarrier(fb)) return ev;
    }
  }

  return null;
}

// ======================================================
// ✅ Admin page: Shippo labels dashboard
// GET /admin/shippo
// ======================================================
router.get('/admin/shippo', requireAdmin, async (req, res) => {
  try {
    const orders = await Order.find({})
      .sort({ createdAt: -1 })
      .limit(50)
      .select('_id orderId createdAt amount paymentStatus fulfillmentStatus status shippingTracking shippo shipping paypal'); // ✅ no lean

    // ✅ Use model method for one-source-of-truth paid-like check
    const paidLike = orders.filter((o) => (typeof o.isPaidLike === 'function' ? o.isPaidLike() : false));

    // ✅ Backfill carrierLabel for old orders (UI only)
    for (const o of paidLike) {
      const hasLabel = !!(o?.shippo?.labelUrl);
      const hasTracking = !!(o?.shippingTracking?.trackingNumber || o?.shippingTracking?.trackingUrl);
      const missingLabel = !String(o?.shippingTracking?.carrierLabel || '').trim();

      if (hasLabel && hasTracking && missingLabel) {
        const rawProvider = String(o?.shippo?.chosenRate?.provider || '').trim() || '';

        const badProvider = !rawProvider || ['UNKNOWN', 'OTHER', 'SHIPPO'].includes(_normCarrier(rawProvider));

        const inferred =
          inferCarrierLabelFromUrl(o?.shippingTracking?.trackingUrl) ||
          (badProvider ? '' : rawProvider) ||
          (o?.shippo?.carrier ? String(o.shippo.carrier).replace(/_/g, ' ').toUpperCase().trim() : '') ||
          (o?.shippingTracking?.carrierToken
            ? String(o.shippingTracking.carrierToken).replace(/_/g, ' ').toUpperCase().trim()
            : '');

        if (inferred) {
          // ✅ update DB and the in-memory doc so the page shows immediately
          await Order.updateOne({ _id: o._id }, { $set: { 'shippingTracking.carrierLabel': inferred } });
          o.shippingTracking = o.shippingTracking || {};
          o.shippingTracking.carrierLabel = inferred;
        }
      }
    }

    // ✅ IMPORTANT: render needs plain objects (EJS is happiest with them)
    const paidLikeLean = paidLike.map((o) => o.toObject({ virtuals: true }));

    return res.render('admin-shippo', {
      layout: 'layout',
      title: 'Shippo Labels',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      orders: paidLikeLean,
      success: req.flash('success') || [],
      error: req.flash('error') || [],
    });
  } catch (e) {
    console.error('Admin Shippo page error:', e);
    req.flash('error', e.message || 'Could not load Shippo page');
    return res.redirect('/admin');
  }
});

// ======================================================
// ✅ Get rates for an order (ADMIN)
// GET /admin/orders/:orderId/shippo/rates
// ======================================================
router.get('/admin/orders/:orderId/shippo/rates', requireAdmin, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const order = await Order.findOne({ orderId });
    if (!order) return res.status(404).json({ ok: false, message: 'Order not found' });

    if (typeof order.isPaidLike === 'function' && !order.isPaidLike()) {
      return res.status(400).json({ ok: false, message: 'Order is not paid-like yet' });
    }

    // ✅ STRICT: use payerShipmentId only (NO building parcels/customs)
    const payerShipmentId = String(order?.shippo?.payerShipmentId || '').trim() || null;
    const payerRateId = String(order?.shippo?.payerRateId || '').trim() || null;

    if (!payerShipmentId) {
      return res.status(400).json({
        ok: false,
        message: 'Missing payerShipmentId on order. Cannot fetch rates without rebuilding shipments (blocked by policy).',
        debug: { orderId: order.orderId },
      });
    }

    const { shipment, rates } = await shippoPollShipmentRates(payerShipmentId, {
      tries: 10,
      delayMs: 1500,
    });

    const cleanRates = (Array.isArray(rates) ? rates : [])
      .map((r) => ({
        id: r.object_id,
        object_id: r.object_id,
        provider: r.provider,
        service: r.servicelevel?.name || r.servicelevel?.token || '',
        amount: r.amount,
        currency: r.currency,
        estimatedDays: r.estimated_days ?? null,
        durationTerms: r.duration_terms ?? '',
      }))
      .filter((r) => r.object_id && r.amount != null)
      .sort((a, b) => Number(a.amount) - Number(b.amount));

    const payerRecorded = !!payerRateId;

    const payerInThisList = payerRateId
      ? cleanRates.some((r) => String(r?.object_id || '').trim() === payerRateId)
      : false;

    return res.json({
      ok: true,

      // ✅ show payer shipment
      shipmentId: shipment?.object_id || payerShipmentId,

      // ✅ payer choice from order (trusted)
      payerRateId,
      payerRecorded,
      payerInThisList,

      // ✅ no hints needed now (we rely on payerRateId)
      payerHint: null,

      rates: cleanRates,
    });
  } catch (e) {
    console.error('Shippo rates error:', e);
    return res.status(500).json({ ok: false, message: e.message || 'Shippo rates error' });
  }
});

// ======================================================
// ✅ Create label for a specific paid order (ADMIN)
// POST /admin/orders/:orderId/shippo/create-label
// ======================================================
router.post('/admin/orders/:orderId/shippo/create-label', requireAdmin, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const order = await Order.findOne({ orderId });

    if (!order) return res.status(404).json({ ok: false, message: 'Order not found' });

    if (typeof order.isPaidLike === 'function' && !order.isPaidLike()) {
      return res.status(400).json({ ok: false, message: 'Order is not paid-like yet' });
    }

    // ✅ idempotent: don't buy twice
    if (order.shippo?.transactionId && order.shippo?.labelUrl) {
      return res.json({
        ok: true,
        labelUrl: order.shippo.labelUrl,
        trackingNumber: order.shippingTracking?.trackingNumber || '',
        trackingUrl: order.shippingTracking?.trackingUrl || '',
        carrierEnum: order.shippingTracking?.carrier || null,
        carrierToken: order.shippingTracking?.carrierToken || null,
      });
    }

    // ======================================================
    // ✅ STRICT MODE (NO FALLBACKS):
    // MUST buy payerRateId from payerShipmentId only
    // ======================================================
    let shipment, chosenRate, transaction, carrierToken;

    const bodyRateId = req.body?.rateId ? String(req.body.rateId).trim() : null;

    const payerRateId = String(order?.shippo?.payerRateId || '').trim() || null;
    const payerShipmentId = String(order?.shippo?.payerShipmentId || '').trim() || null;

    if (!payerRateId) {
      return res.status(400).json({
        ok: false,
        message: 'Missing payerRateId on order. payment.js must save payerRateId.',
        debug: { orderId: order.orderId },
      });
    }

    if (!payerShipmentId) {
      return res.status(400).json({
        ok: false,
        message: 'Missing payerShipmentId on order. payment.js must save payerShipmentId.',
        debug: { orderId: order.orderId, payerRateId },
      });
    }

    if (bodyRateId && bodyRateId !== payerRateId) {
      return res.status(409).json({
        ok: false,
        message: 'This order must be bought using the payer-selected rateId only.',
        debug: { payerRateId, bodyRateId },
      });
    }

    try {
      ({ shipment, chosenRate, transaction, carrierToken } = await createLabelForOrder(order, {
        rateId: payerRateId,
        shipmentId: payerShipmentId,
        strictRateId: true,
      }));
    } catch (e) {
      const shippo = e?.shippo || e?.details || null;

      console.error('❌ Shippo STRICT payer purchase failed:', {
        message: e?.message,
        code: e?.code,
        payerRateId,
        payerShipmentId,
        shippo,
      });

      return res.status(502).json({
        ok: false,
        message: e?.message || 'Shippo failed (strict payer rate)',
        shippo,
        debug: { orderId: order.orderId, payerRateId, payerShipmentId },
      });
    }

    if (String(chosenRate?.object_id || '').trim() !== payerRateId) {
      return res.status(409).json({
        ok: false,
        message: 'Strict mismatch: Shippo did not buy payerRateId.',
        debug: {
          payerRateId,
          chosenRateId: String(chosenRate?.object_id || '').trim() || null,
          payerShipmentId,
          shipmentId: shipment?.object_id || null,
        },
      });
    }

    // ======================================================
    // ✅ Shippo must return label_url
    // ======================================================
    if (!transaction || !transaction.label_url) {
      const status = transaction?.status || transaction?.tracking_status || 'UNKNOWN';
      const messages =
        (Array.isArray(transaction?.messages) && transaction.messages.length ? transaction.messages : null) ||
        transaction?.meta ||
        null;

      console.error('❌ Shippo transaction missing label_url:', {
        status,
        messages,
        transactionId: transaction?.object_id,
        rateId: chosenRate?.object_id,
        provider: chosenRate?.provider,
        servicelevel: chosenRate?.servicelevel?.token,
      });

      return res.status(502).json({
        ok: false,
        message: 'Shippo did not return a label_url.',
        shippo: {
          status,
          messages,
          transactionId: transaction?.object_id || '',
          rateId: chosenRate?.object_id || '',
          provider: chosenRate?.provider || '',
          servicelevel: chosenRate?.servicelevel?.token || '',
        },
      });
    }

    // ======================================================
    // ✅ Save Shippo info + Tracking info on the Order
    // ======================================================
    order.shippo = order.shippo || {};
    order.shippingTracking = order.shippingTracking || {};

    // ✅ DO NOT overwrite shipmentId (keep history stable)
    if (!order.shippo.shipmentId) {
      order.shippo.shipmentId = shipment?.object_id || null;
    }

    // ✅ DO NOT overwrite payer fields (they must stay as saved by payment.js)
    // payerRateId and payerShipmentId are already on the order

    order.shippo.transactionId = transaction?.object_id || null;
    order.shippo.rateId = chosenRate?.object_id || null;
    order.shippo.labelUrl = transaction?.label_url || null;
    order.shippo.trackingStatus = transaction?.tracking_status || null;

    order.shippo.carrier = carrierToken || null;

    order.shippo.chosenRate = {
      provider: String(chosenRate?.provider || '').trim() || null,
      service: String(chosenRate?.servicelevel?.name || chosenRate?.servicelevel?.token || '').trim() || null,
      amount: chosenRate?.amount != null ? String(chosenRate.amount) : null,
      currency: String(chosenRate?.currency || '').trim() || null,
      estimatedDays: chosenRate?.estimated_days != null ? Number(chosenRate.estimated_days) : null,
      durationTerms: String(chosenRate?.duration_terms || '').trim() || null,
    };

    order.shippingTracking.trackingNumber = String(transaction?.tracking_number || '').trim();
    order.shippingTracking.trackingUrl = String(transaction?.tracking_url_provider || '').trim();
    order.shippingTracking.labelUrl = String(transaction?.label_url || '').trim();

    // ✅ Do NOT write enum-unsafe carrier values
    order.shippingTracking.carrierToken = carrierToken || null;

    const rawProvider =
      String(chosenRate?.provider || '').trim() ||
      String(transaction?.provider || '').trim() ||
      '';

    const badProvider = !rawProvider || ['UNKNOWN', 'OTHER', 'SHIPPO'].includes(_normCarrier(rawProvider));

    const finalCarrierLabel =
      (badProvider ? '' : rawProvider) ||
      inferCarrierLabelFromUrl(order.shippingTracking.trackingUrl) ||
      (carrierToken ? String(carrierToken).replace(/_/g, ' ').toUpperCase().trim() : '') ||
      '';

    order.shippingTracking.carrierLabel = finalCarrierLabel || '';

    const statusEnums = getTrackingStatusEnumValues(order);
    const safeTrackingStatus = mapToEnum('LABEL_CREATED', statusEnums);
    if (safeTrackingStatus) order.shippingTracking.status = safeTrackingStatus;

    const fulfillEnums = getFulfillmentEnumValues(order);
    const safeFulfillment = mapToEnum('LABEL_CREATED', fulfillEnums);
    if (safeFulfillment) order.fulfillmentStatus = safeFulfillment;

    await order.save();

    // ======================================================
    // ✅ Send tracking to PayPal immediately after label purchase (non-fatal)
    // ======================================================
    try {
      // ✅ Your schema stores captureId here
      const captureId =
        String(order?.paypal?.captureId || '').trim() ||
        String(order?.captures?.[0]?.captureId || '').trim() ||
        '';

      // ✅ tracking number from Shippo transaction
      const trackingNumber = String(order?.shippingTracking?.trackingNumber || '').trim();

      // ✅ carrier best-effort: your util will normalize again, so pass a decent value
      const carrierInput =
      String(order?.shippingTracking?.carrierToken || '').trim() ||
      String(order?.shippingTracking?.carrier || '').trim() ||
      String(order?.shippingTracking?.carrierLabel || '').trim() ||
      String(rawProvider || '').trim() ||
      inferCarrierLabelFromUrl(order?.shippingTracking?.trackingUrl) ||
      'OTHER';

    if (captureId && trackingNumber) {
      const paypalResp = await addTrackingToPaypalOrder({
        transactionId: captureId,
        trackingNumber,
        carrier: carrierInput,
        status: 'SHIPPED',
      });

      await Order.updateOne(
        { _id: order._id },
        {
          $set: {
            'shippo.paypalTrackingPushedAt': new Date(),
            'shippo.paypalTrackingLastError': '',
            'shippo.paypalTrackingLastResponse': paypalResp || null,
          },
        }
      ).catch(() => {});
    } else {
      console.warn('⚠️ Skipping PayPal tracking update (missing fields):', {
        captureId: !!captureId,
        trackingNumber: !!trackingNumber,
        carrierInput: !!carrierInput,
      });
    }
    } catch (e) {
      console.warn('⚠️ PayPal tracking update failed (non-fatal):', e.message);

      // ✅ store last error (optional)
        await Order.updateOne(
          { _id: order._id },
          { $set: { 'shippo.paypalTrackingLastError': String(e?.message || 'PayPal tracking error') } }
        ).catch(() => {});
    }

    return res.json({
      ok: true,
      labelUrl: transaction.label_url,
      trackingNumber: transaction.tracking_number,
      trackingUrl: transaction.tracking_url_provider,
      shipmentId: shipment?.object_id || null,
      transactionId: transaction.object_id,
      carrierEnum: order.shippingTracking?.carrier || null,
      carrierToken: order.shippingTracking?.carrierToken || null,
    });
  } catch (e) {
    console.error('Shippo label error:', e);
    return res.status(500).json({ ok: false, message: e.message || 'Shippo error' });
  }
});

// ======================================================
// ✅ Update address for an order (ADMIN)
// POST /admin/orders/:orderId/shippo/update-address
// ======================================================
router.post('/admin/orders/:orderId/shippo/update-address', requireAdmin, async (req, res) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    const order = await Order.findOne({ orderId });

    if (!order) return res.status(404).json({ ok: false, message: 'Order not found' });

    const b = req.body || {};
    order.shipping = order.shipping || {};

    order.shipping.address_line_1 = String(b.street1 || '').trim();
    order.shipping.address_line_2 = String(b.street2 || '').trim();
    order.shipping.admin_area_2 = String(b.city || '').trim();
    order.shipping.admin_area_1 = String(b.state || '').trim();
    order.shipping.postal_code = String(b.zip || '').trim();
    order.shipping.country_code = String(b.country || '').trim().toUpperCase();

    await order.save();
    return res.json({ ok: true });
  } catch (e) {
    console.error('Update address failed:', e);
    return res.status(500).json({ ok: false, message: e.message || 'Update address failed' });
  }
});

module.exports = router;


