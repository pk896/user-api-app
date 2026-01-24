// routes/adminShippo.js
'use strict';

const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const { createLabelForOrder, getRatesForOrder } = require('../utils/shippo/createLabelForOrder');
const { addTrackingToPaypalOrder } = require('../utils/paypal/addTrackingToPaypalOrder');

function inferCarrierLabelFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return '';
  if (u.includes('dhl')) return 'DHL';
  if (u.includes('fedex')) return 'FEDEX';
  if (u.includes('ups')) return 'UPS';
  if (u.includes('usps') || u.includes('postal')) return 'USPS';
  return '';
}

// ======================================================
// ✅ Carrier enum-safe mapping (prevents Mongoose enum errors)
// ======================================================
function _normCarrier(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getCarrierEnumValues(orderDoc) {
  const p =
    orderDoc?.schema?.path('shippingTracking.carrier') ||
    orderDoc?.constructor?.schema?.path('shippingTracking.carrier');

  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function mapShippoProviderToCarrierEnum(providerName, enumValues) {
  const want = _normCarrier(providerName);
  if (!want) return null;

  // 1) Exact/normalized match against allowed enum values
  for (const ev of enumValues) {
    if (_normCarrier(ev) === want) return ev;
  }

  
  // 2) Common synonyms (if your enum uses different naming)
  const synonyms = {
    USPS: ['USPS', 'US_POSTAL_SERVICE', 'USPOSTALSERVICE', 'POSTAL', 'POSTOFFICE'],
    UPS: ['UPS', 'UNITED_PARCEL_SERVICE', 'UNITEDPARCELSERVICE'],
    FEDEX: ['FEDEX', 'FEDERAL_EXPRESS', 'FEDERALEXPRESS'],
    DHL: ['DHL', 'DHL_EXPRESS', 'DHLEXPRESS', 'DHLWORLDWIDE', 'DHL_ECOMMERCE'],
  };

  // If want is "DHLEXPRESS", still match the DHL synonym group
  const synonymKey =
    want.startsWith('DHL') ? 'DHL' :
    want.startsWith('FEDEX') ? 'FEDEX' :
    want.startsWith('UPS') ? 'UPS' :
    want.startsWith('USPS') ? 'USPS' :
    want;

  for (const cand of (synonyms[synonymKey] || [])) {
    const c = _normCarrier(cand);
    for (const ev of enumValues) {
      if (_normCarrier(ev) === c) return ev;
    }
  }

  // 3) Last-resort fallbacks if your enum has these
  const fallbacks = ['SHIPPO', 'OTHER', 'UNKNOWN'];
  for (const fb of fallbacks) {
    for (const ev of enumValues) {
      if (_normCarrier(ev) === fb) return ev;
    }
  }

  // 4) No safe enum value found
  return null;
}

let requireAdmin = null;
try {
  requireAdmin = require('../middleware/requireAdmin');
} catch {
  requireAdmin = (req, res, next) =>
    req.session?.admin ? next() : res.status(401).json({ ok: false, message: 'Unauthorized' });
}

// ======================================================
// ✅ Tracking STATUS enum-safe mapping (prevents enum errors)
// ======================================================
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
  const want = _normCarrier(desired); // reuse your normalizer (upper + strip non alnum)
  if (!want) return null;

  // 1) exact normalized match
  for (const ev of enumValues) {
    if (_normCarrier(ev) === want) return ev;
  }

  // 2) common fallbacks in “best effort” order
  const fallbackOrder = [
    'PROCESSING',
    'PRE_TRANSIT',
    'PENDING',
    'SHIPPED',
    'IN_TRANSIT',
    'CREATED',
    'UNKNOWN',
  ];

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
      .select('_id orderId createdAt amount paymentStatus fulfillmentStatus status shippingTracking shippo shipping paypal')
      .lean();

    // Show only paid-like orders on the dashboard
    const paidLike = orders.filter((o) => {
      const ps = String(o.paymentStatus || '').toUpperCase();
      return ps === 'COMPLETED' || ps === 'PAID' || ps === 'CAPTURED';
    });

    // ✅ Backfill carrierLabel for already-created labels (DHL/UPS/USPS/FEDEX)
    // This fixes old orders where carrierLabel was never saved.
    for (const o of paidLike) {
      const hasLabel = !!(o?.shippo?.labelUrl);
      const hasTracking = !!(o?.shippingTracking?.trackingNumber || o?.shippingTracking?.trackingUrl);
      const missingLabel = !String(o?.shippingTracking?.carrierLabel || '').trim();

      if (hasLabel && hasTracking && missingLabel) {
        const rawProvider =
          String(o?.shippo?.chosenRate?.provider || '').trim() ||
          '';

        const badProvider =
          !rawProvider ||
          ['UNKNOWN', 'OTHER', 'SHIPPO'].includes(_normCarrier(rawProvider));

        const inferred =
          inferCarrierLabelFromUrl(o?.shippingTracking?.trackingUrl) ||
          (badProvider ? '' : rawProvider) ||
          (o?.shippo?.carrier ? String(o.shippo.carrier).replace(/_/g, ' ').toUpperCase().trim() : '') ||
          (o?.shippingTracking?.carrierToken ? String(o.shippingTracking.carrierToken).replace(/_/g, ' ').toUpperCase().trim() : '');

        if (inferred) {
          // save to DB
          await Order.updateOne(
            { _id: o._id },
            { $set: { 'shippingTracking.carrierLabel': inferred } }
          );

          // also update in-memory so the page shows it immediately without refresh
          o.shippingTracking = o.shippingTracking || {};
          o.shippingTracking.carrierLabel = inferred;
        }
      }
    }

    return res.render('admin-shippo', {
      layout: 'layout',
      title: 'Shippo Labels',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      orders: paidLike,
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

    const { shipment, rates } = await getRatesForOrder(order);
    order.shippo = order.shippo || {};
    order.shippo.shipmentId = shipment?.object_id || null;
    order.shippo.lastRatesAt = new Date();
    await order.save();

    // Return a clean, UI-friendly list
    const cleanRates = rates.map(r => ({
      id: r.object_id,
      object_id: r.object_id,
      provider: r.provider,
      service: r.servicelevel?.name || r.servicelevel?.token || '',
      amount: r.amount,
      currency: r.currency,
      estimatedDays: r.estimated_days ?? null,
      durationTerms: r.duration_terms ?? '',
    }))
    .sort((a, b) => Number(a.amount) - Number(b.amount));

    return res.json({
      ok: true,
      shipmentId: shipment?.object_id || null,
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

    // Only for paid-like orders (uses your model method)
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

    // Create label via Shippo helper
    let shipment, chosenRate, transaction, carrierToken;
    try {
      const rateId = req.body?.rateId ? String(req.body.rateId) : null;
      const chooseRate = req.body?.chooseRate ? String(req.body.chooseRate) : 'cheapest';

      ({ shipment, chosenRate, transaction, carrierToken } =
        await createLabelForOrder(order, { rateId, chooseRate })
      );
    } catch (e) {
      const shippo = e?.shippo || e?.details || null;

      console.error('❌ Shippo createLabelForOrder error:', {
        message: e?.message,
        shippo,
      });

      return res.status(502).json({
        ok: false,
        message: e?.message || 'Shippo failed',
        shippo,
        debug: {
          orderId: order.orderId,
          shipping: order.shipping || null,
          paypalShipping: order.paypal?.purchase_units?.[0]?.shipping || null,
        },
      });
    }

    // Shippo must return label_url
    if (!transaction || !transaction.label_url) {
      const status = transaction?.status || transaction?.tracking_status || 'UNKNOWN';
      const messages = transaction?.messages || transaction?.meta || null;

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
    // ✅ Save Shippo info + Tracking info on the Order (ENUM SAFE)
    // ======================================================
    order.shippo = {
      shipmentId: shipment?.object_id || null,
      transactionId: transaction?.object_id || null,
      rateId: chosenRate?.object_id || null,
      labelUrl: transaction?.label_url || null,
      trackingStatus: transaction?.tracking_status || null,

      // Shippo carrier token (lowercase) — useful for /tracks/{carrier}/{trackingNumber}
      carrier: carrierToken || null,

      // ✅ Save chosen rate details for admin display
      chosenRate: {
        provider: String(chosenRate?.provider || '').trim() || null,              // e.g. "USPS"
        service: String(chosenRate?.servicelevel?.name || chosenRate?.servicelevel?.token || '').trim() || null,
        amount: chosenRate?.amount != null ? String(chosenRate.amount) : null,    // numeric string from Shippo
        currency: String(chosenRate?.currency || '').trim() || null,             // e.g. "USD"
        estimatedDays: chosenRate?.estimated_days != null ? Number(chosenRate.estimated_days) : null,
        durationTerms: String(chosenRate?.duration_terms || '').trim() || null,
      },
    };

    order.shippingTracking = order.shippingTracking || {};
    order.shippingTracking.trackingNumber = String(transaction?.tracking_number || '').trim();
    order.shippingTracking.trackingUrl = String(transaction?.tracking_url_provider || '').trim();
    order.shippingTracking.labelUrl = String(transaction?.label_url || '').trim();

    // ✅ IMPORTANT: carrier is an ENUM in your Order schema.
    // We will ONLY save a value that exists in the enum to prevent validation errors.
    const carrierEnums = getCarrierEnumValues(order);
    const safeCarrierEnum = mapShippoProviderToCarrierEnum(chosenRate?.provider, carrierEnums);

    if (safeCarrierEnum) {
      order.shippingTracking.carrier = safeCarrierEnum;
    } else {
      // ✅ Only set a fallback that actually exists in your enum
      const fallbackEnum =
        carrierEnums.find(v => _normCarrier(v) === 'OTHER') ||
        carrierEnums.find(v => _normCarrier(v) === 'UNKNOWN') ||
        carrierEnums.find(v => _normCarrier(v) === 'SHIPPO') ||
        null;

      if (fallbackEnum) order.shippingTracking.carrier = fallbackEnum;
      else order.shippingTracking.carrier = undefined; // leave unset if no safe enum exists
    }

    // ✅ Keep Shippo token separately (lowercase "usps") for Shippo tracking endpoint usage
    order.shippingTracking.carrierToken = carrierToken || null;

    // ✅ Always store a human carrier label for UI + PayPal (NO "UNKNOWN")
    // If Shippo sends provider "UNKNOWN/OTHER/SHIPPO", ignore it and infer from URL/token.
    const rawProvider =
      String(chosenRate?.provider || '').trim() ||
      String(transaction?.provider || '').trim() ||
      '';

    const badProvider =
      !rawProvider ||
      ['UNKNOWN', 'OTHER', 'SHIPPO'].includes(_normCarrier(rawProvider));

    const finalCarrierLabel =
      (badProvider ? '' : rawProvider) ||
      inferCarrierLabelFromUrl(order.shippingTracking.trackingUrl) ||
      (carrierToken ? String(carrierToken).replace(/_/g, ' ').toUpperCase().trim() : '') ||
      '';


    if (finalCarrierLabel) {
      order.shippingTracking.carrierLabel = finalCarrierLabel;
    } else {
      // If we truly can't infer it, leave it empty (UI should just not show it)
      order.shippingTracking.carrierLabel = undefined;
    }

    // ✅ shippingTracking.status must match its enum
    const statusEnums = getTrackingStatusEnumValues(order);
    const safeTrackingStatus = mapToEnum('LABEL_CREATED', statusEnums);

    // If your enum doesn't support LABEL_CREATED, we fallback automatically (PROCESSING / PENDING / SHIPPED...)
    if (safeTrackingStatus) {
      order.shippingTracking.status = safeTrackingStatus;
    }

    // ✅ fulfillmentStatus might also be an enum — set only if allowed
    const fulfillEnums = getFulfillmentEnumValues(order);
    const safeFulfillment = mapToEnum('LABEL_CREATED', fulfillEnums);

    if (safeFulfillment) {
      order.fulfillmentStatus = safeFulfillment;
    }

    await order.save();

    // ======================================================
    // ✅ Send tracking + carrier to PayPal (non-fatal if it fails)
    // ======================================================
    try {
      const paypalOrderId = order.orderId; // your app uses this as PayPal order id

      // Capture id can be in different places depending on how you saved PayPal payload
      const captureId =
        order.paypal?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
        order.paypal?.captureId ||
        order.paypal?.capture?.id ||
        null;

      // Only send to PayPal if we have what PayPal needs
      const paypalCarrier =
        (order.shippingTracking?.carrierLabel && String(order.shippingTracking.carrierLabel).trim()) ||
        (chosenRate?.provider && String(chosenRate.provider).trim()) ||
        (order.shippingTracking?.carrierToken && String(order.shippingTracking.carrierToken).trim()) ||
        null;

      if (
        paypalOrderId &&
        captureId &&
        order.shippingTracking?.trackingNumber &&
        paypalCarrier
      ) {
        await addTrackingToPaypalOrder({
          paypalOrderId,
          captureId,
          trackingNumber: order.shippingTracking.trackingNumber,
          carrier: paypalCarrier,
          notifyPayer: true,
        });
      } else {
        console.warn('⚠️ Skipping PayPal tracking update (missing fields):', {
          paypalOrderId: !!paypalOrderId,
          captureId: !!captureId,
          trackingNumber: !!order.shippingTracking?.trackingNumber,
          paypalCarrier: !!paypalCarrier,
        });
      }
    } catch (e) {
      console.warn('⚠️ PayPal tracking update failed (non-fatal):', e.message);
    }

    return res.json({
      ok: true,
      labelUrl: transaction.label_url,
      trackingNumber: transaction.tracking_number,
      trackingUrl: transaction.tracking_url_provider,
      shipmentId: shipment.object_id,
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

    // Only update fields Shippo needs
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
