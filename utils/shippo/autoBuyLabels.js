// utils/shippo/autoBuyLabels.js
'use strict';

const Order = require('../../models/Order');
const { createLabelForOrder, createFreshShipmentRatesForOrder } = require('./createLabelForOrder');
const { sendOrderProcessingEmail } = require('../emails/orderStatusEmail');

let addTrackingToPaypalOrder = null;
try {
  ({ addTrackingToPaypalOrder } = require('../paypal/addTrackingToPaypalOrder'));
} catch {
  addTrackingToPaypalOrder = null;
}

const PAID_LIKE_STATUS = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const PAID_LIKE_PAYMENT_STATUS = ['PAID', 'COMPLETED', 'CAPTURED'];

function numEnv(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function truncate(str, max = 500) {
  return String(str || '').slice(0, max);
}

function normCarrier(v) {
  return String(v || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function inferCarrierLabelFromUrl(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return '';
  if (u.includes('dhl')) return 'DHL';
  if (u.includes('fedex')) return 'FEDEX';
  if (u.includes('ups')) return 'UPS';
  if (u.includes('usps') || u.includes('postal')) return 'USPS';
  return '';
}

function isBadCarrierLabel(v) {
  const n = normCarrier(v);
  return !n || n === 'UNKNOWN' || n === 'OTHER' || n === 'SHIPPO' || n === 'NULL';
}

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
  const want = normCarrier(desired);
  if (!want) return null;

  for (const ev of enumValues) {
    if (normCarrier(ev) === want) return ev;
  }

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
      if (normCarrier(ev) === normCarrier(fb)) return ev;
    }
  }

  return null;
}

function isExpiredOrNotPurchasableRateError(err) {
  const parts = [];

  function collect(value) {
    if (value === null || value === undefined) return;

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value).toLowerCase());
      return;
    }

    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }

    if (typeof value === 'object') {
      for (const v of Object.values(value)) collect(v);
    }
  }

  collect(err?.message);
  collect(err?.code);
  collect(err?.status);
  collect(err?.shippo);

  const combined = parts.join(' | ');

  if (combined.includes('expired')) return true;
  if (combined.includes('older than 7 days')) return true;
  if (combined.includes("can't be purchased")) return true;
  if (combined.includes('cannot be purchased')) return true;
  if (combined.includes('cannot purchase')) return true;

  if (combined.includes('selected rate not found')) return true;
  if (combined.includes('rate') && combined.includes('not found')) return true;
  if (combined.includes('invalid rate')) return true;

  if (combined.includes('shipment date')) return true;
  if (combined.includes('within 7 days')) return true;

  return false;
}

function rateAmountNumber(rate) {
  const n = Number(String(rate?.amount ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function chooseCheapestAvailableRate(rates, payerRateId) {
  const payerId = String(payerRateId || '').trim();

  return (
    (Array.isArray(rates) ? rates : [])
      .filter((rate) => {
        const rateId = String(rate?.object_id || '').trim();
        const amount = rateAmountNumber(rate);

        if (!rateId) return false;
        if (amount === null) return false;

        // ✅ The fallback is for another available rate only.
        // If payerRateId is still available, strict payer purchase should have worked first.
        if (payerId && rateId === payerId) return false;

        return true;
      })
      .sort((a, b) => rateAmountNumber(a) - rateAmountNumber(b))[0] || null
  );
}

async function buyPayerRateOrCheapestFallback(order, payerRateId, savedRate) {
  try {
    const result = await createLabelForOrder(order, {
      rateId: payerRateId,
      chooseRate: 'payer',
      savedRate,
      strictRateId: true,
    });

    return {
      result,
      fallbackUsed: false,
      fallbackReason: '',
      fallbackShipmentId: '',
    };
  } catch (payerErr) {
    const canFallback = isExpiredOrNotPurchasableRateError(payerErr);

    // ✅ Very important:
    // Only fallback when the payer selected rate is expired / no longer purchasable.
    // For all other errors, stop and keep the failure.
    if (!canFallback) {
      throw payerErr;
    }

    console.warn(
      '[auto-buy] payerRateId expired/not purchasable; creating fresh shipment for cheapest fallback:',
      {
        orderId: order?.orderId,
        payerRateId,
        reason: payerErr?.message || '',
        code: payerErr?.code || '',
      },
    );

    const {
      shipment: freshShipment,
      rates,
      oldShipmentId,
      freshShipmentId,
    } = await createFreshShipmentRatesForOrder(order);

    const cheapest = chooseCheapestAvailableRate(rates, '');

    if (!cheapest?.object_id) {
      const err = new Error(
        'Payer rate is not purchasable and no cheapest rate is available on the fresh Shippo shipment.',
      );
      err.code = 'SHIPPO_NO_CHEAPEST_FRESH_FALLBACK_RATE';
      err.shippo = {
        payerRateId,
        oldShipmentId,
        freshShipmentId,
        rateCount: Array.isArray(rates) ? rates.length : 0,
        payerError: payerErr?.message || '',
      };
      throw err;
    }

    const fallbackRateId = String(cheapest.object_id).trim();

    console.warn('[auto-buy] buying cheapest fallback rate from fresh shipment:', {
      orderId: order?.orderId,
      payerRateId,
      oldShipmentId,
      freshShipmentId,
      fallbackRateId,
      provider: cheapest?.provider || '',
      service: cheapest?.servicelevel?.name || cheapest?.servicelevel?.token || '',
      amount: cheapest?.amount || '',
      currency: cheapest?.currency || '',
    });

    // ✅ IMPORTANT:
    // createLabelForOrder strict mode checks order.shippo.payerShipmentId.
    // For fallback, we create a safe temporary clone and point it to the fresh shipment only.
    // We do NOT overwrite the real order.payerShipmentId.
    const orderForFallback = order.toObject ? order.toObject() : JSON.parse(JSON.stringify(order));

    orderForFallback.shippo = orderForFallback.shippo || {};
    orderForFallback.shippo.payerShipmentId = freshShipment?.object_id || freshShipmentId;
    orderForFallback.shippo.shipmentId = freshShipment?.object_id || freshShipmentId;

    const fallbackResult = await createLabelForOrder(orderForFallback, {
      rateId: fallbackRateId,
      strictRateId: true,
    });

    return {
      result: fallbackResult,
      fallbackUsed: true,
      fallbackReason: `Payer rate was expired/not purchasable: ${payerErr?.message || 'expired/not found'}`,
      fallbackShipmentId: freshShipment?.object_id || freshShipmentId || '',
    };
  }
}

function buildEligibleQuery({ cutoff, retryProcessingCutoff }) {
  return {
    createdAt: { $lte: cutoff },

    $and: [
      { 'shippo.payerRateId': { $exists: true, $ne: '' } },
      { 'shippo.payerShipmentId': { $exists: true, $ne: '' } },

      {
        $or: [
          { 'shippo.labelUrl': { $exists: false } },
          { 'shippo.labelUrl': '' },
          { 'shippo.labelUrl': null },
        ],
      },
      {
        $or: [
          { 'shippo.transactionId': { $exists: false } },
          { 'shippo.transactionId': '' },
          { 'shippo.transactionId': null },
        ],
      },

      {
        $or: [{ 'shippo.autoBuyEnabled': { $exists: false } }, { 'shippo.autoBuyEnabled': true }],
      },

      {
        $or: [
          { status: { $in: PAID_LIKE_STATUS } },
          { paymentStatus: { $in: PAID_LIKE_PAYMENT_STATUS } },
          { paymentStatus: { $in: PAID_LIKE_PAYMENT_STATUS.map((s) => s.toLowerCase()) } },
        ],
      },

      {
        $or: [
          { 'shippo.autoBuyStatus': { $exists: false } },
          { 'shippo.autoBuyStatus': null },
          { 'shippo.autoBuyStatus': 'PENDING' },

          // ✅ Retry normal failed jobs.
          { 'shippo.autoBuyStatus': 'FAILED' },

          // ✅ Recover jobs stuck in PROCESSING after a server restart/crash.
          {
            'shippo.autoBuyStatus': 'PROCESSING',
            'shippo.autoBuyAttemptedAt': { $lte: retryProcessingCutoff },
          },
        ],
      },
    ],
  };
}

async function pushTrackingToPaypalIfPossible(order) {
  if (typeof addTrackingToPaypalOrder !== 'function') return;

  const captureId =
    String(order?.paypal?.captureId || '').trim() ||
    String(order?.captures?.[0]?.captureId || '').trim() ||
    '';

  const trackingNumber = String(order?.shippingTracking?.trackingNumber || '').trim();

  const carrierInput =
    String(order?.shippingTracking?.carrierToken || '').trim() ||
    String(order?.shippingTracking?.carrier || '').trim() ||
    String(order?.shippingTracking?.carrierLabel || '').trim() ||
    String(order?.shippo?.carrier || '').trim() ||
    'OTHER';

  if (!captureId || !trackingNumber) {
    console.warn('[auto-buy] PayPal tracking skipped: missing captureId or trackingNumber', {
      orderId: order?.orderId,
      hasCaptureId: !!captureId,
      hasTrackingNumber: !!trackingNumber,
    });
    return;
  }

  try {
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
      },
    );
  } catch (e) {
    const msg = truncate(e?.message || String(e), 500);

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          'shippo.paypalTrackingLastError': msg,
        },
      },
    ).catch(() => {});

    console.warn('[auto-buy] PayPal tracking push failed (non-fatal):', {
      orderId: order?.orderId,
      msg,
    });
  }
}

async function runAutoBuyOnce() {
  const enabled = boolEnv('SHIPPO_AUTO_BUY_ENABLED', false);
  if (!enabled) return { ok: true, ran: false, reason: 'disabled' };

  const hours = numEnv('SHIPPO_AUTO_BUY_AFTER_HOURS', 23);
  const maxPerRun = numEnv('SHIPPO_AUTO_BUY_MAX_PER_RUN', 5);
  const retryProcessingMinutes = numEnv('SHIPPO_AUTO_BUY_RETRY_PROCESSING_AFTER_MINUTES', 10);

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const retryProcessingCutoff = new Date(Date.now() - retryProcessingMinutes * 60 * 1000);

  const query = buildEligibleQuery({ cutoff, retryProcessingCutoff });

  const orders = await Order.find(query).sort({ createdAt: 1 }).limit(maxPerRun);

  let success = 0;
  let failed = 0;
  let skipped = 0;
  let claimed = 0;

  for (const order of orders) {
    const payerRateId = String(order?.shippo?.payerRateId || '').trim();
    const payerShipmentId = String(order?.shippo?.payerShipmentId || '').trim();

    if (!payerRateId || !payerShipmentId) {
      skipped++;
      continue;
    }

    const claim = await Order.updateOne(
      {
        _id: order._id,

        $and: [
          {
            $or: [
              { 'shippo.autoBuyStatus': { $exists: false } },
              { 'shippo.autoBuyStatus': null },
              { 'shippo.autoBuyStatus': 'PENDING' },
              { 'shippo.autoBuyStatus': 'FAILED' },
              {
                'shippo.autoBuyStatus': 'PROCESSING',
                'shippo.autoBuyAttemptedAt': { $lte: retryProcessingCutoff },
              },
            ],
          },
          {
            $or: [
              { 'shippo.transactionId': { $exists: false } },
              { 'shippo.transactionId': '' },
              { 'shippo.transactionId': null },
            ],
          },
          {
            $or: [
              { 'shippo.labelUrl': { $exists: false } },
              { 'shippo.labelUrl': '' },
              { 'shippo.labelUrl': null },
            ],
          },
        ],
      },
      {
        $set: {
          'shippo.autoBuyStatus': 'PROCESSING',
          'shippo.autoBuyAttemptedAt': new Date(),
          'shippo.autoBuyLastError': '',
        },
      },
    );

    if (!claim || claim.modifiedCount !== 1) {
      continue;
    }

    claimed++;

    const freshOrder = await Order.findById(order._id);
    if (!freshOrder) {
      skipped++;
      continue;
    }

    try {
      const savedRate = freshOrder?.shippo?.chosenRate || null;

      const { result, fallbackUsed, fallbackReason, fallbackShipmentId } =
        await buyPayerRateOrCheapestFallback(freshOrder, payerRateId, savedRate);

      if (!result) {
        throw new Error('Auto-buy failed: no result returned from label purchase flow.');
      }

      const { shipment, chosenRate, transaction, trackingNumber, carrierToken } = result;

      if (!transaction?.label_url) {
        throw new Error('Auto-buy failed: Shippo transaction did not return label_url.');
      }

      freshOrder.shippo = freshOrder.shippo || {};
      freshOrder.shippingTracking = freshOrder.shippingTracking || {};

      if (fallbackUsed && fallbackShipmentId) {
        freshOrder.shippo.shipmentId = fallbackShipmentId;
      } else if (!freshOrder.shippo.shipmentId) {
        freshOrder.shippo.shipmentId = shipment?.object_id || payerShipmentId || null;
      }

      freshOrder.shippo.transactionId = transaction?.object_id || null;
      freshOrder.shippo.rateId = chosenRate?.object_id || payerRateId || null;
      freshOrder.shippo.labelUrl = transaction?.label_url || null;
      freshOrder.shippo.trackingNumber = trackingNumber || transaction?.tracking_number || null;
      freshOrder.shippo.trackingStatus = transaction?.tracking_status || null;
      freshOrder.shippo.carrier = carrierToken || null;
      freshOrder.shippo.labelCreatedAt = new Date();

      freshOrder.shippo.autoBuyStatus = 'SUCCESS';
      freshOrder.shippo.autoBuyLastError = fallbackUsed ? fallbackReason : '';
      freshOrder.shippo.autoBuyLastSuccessAt = new Date();

      freshOrder.shippo.chosenRate = {
        provider: String(chosenRate?.provider || '').trim() || null,
        service:
          String(chosenRate?.servicelevel?.name || chosenRate?.servicelevel?.token || '').trim() ||
          null,
        amount: chosenRate?.amount != null ? String(chosenRate.amount) : null,
        currency: String(chosenRate?.currency || '').trim() || null,
        estimatedDays:
          chosenRate?.estimated_days != null ? Number(chosenRate.estimated_days) : null,
        durationTerms: String(chosenRate?.duration_terms || '').trim() || null,
      };

      freshOrder.shippingTracking.trackingNumber = String(
        trackingNumber || transaction?.tracking_number || '',
      ).trim();

      freshOrder.shippingTracking.trackingUrl = String(
        transaction?.tracking_url_provider || '',
      ).trim();

      freshOrder.shippingTracking.labelUrl = String(transaction?.label_url || '').trim();
      freshOrder.shippingTracking.carrierToken = carrierToken || null;

      const rawProvider =
        String(chosenRate?.provider || '').trim() ||
        String(transaction?.provider || '').trim() ||
        '';

      const finalCarrierLabel =
        (!isBadCarrierLabel(rawProvider) ? rawProvider : '') ||
        inferCarrierLabelFromUrl(freshOrder.shippingTracking.trackingUrl) ||
        (carrierToken ? String(carrierToken).replace(/_/g, ' ').toUpperCase().trim() : '') ||
        '';

      freshOrder.shippingTracking.carrierLabel = finalCarrierLabel || '';

      const trackingEnums = getTrackingStatusEnumValues(freshOrder);
      const safeTrackingStatus = mapToEnum('PROCESSING', trackingEnums);
      if (safeTrackingStatus) {
        freshOrder.shippingTracking.status = safeTrackingStatus;
      }

      const fulfillmentEnums = getFulfillmentEnumValues(freshOrder);
      const safeFulfillmentStatus = mapToEnum('LABEL_CREATED', fulfillmentEnums);
      if (safeFulfillmentStatus) {
        freshOrder.fulfillmentStatus = safeFulfillmentStatus;
      }

      await freshOrder.save();

      try {
        await sendOrderProcessingEmail(freshOrder);
      } catch (e) {
        console.warn('[auto-buy] Order processing email failed (non-fatal):', e?.message || e);
      }

      await pushTrackingToPaypalIfPossible(freshOrder);

      success++;

      console.log('[auto-buy] label purchased successfully:', {
        orderId: freshOrder.orderId,
        payerRateId,
        boughtRateId: freshOrder.shippo?.rateId || '',
        fallbackUsed,
        fallbackShipmentId: fallbackShipmentId || '',
        transactionId: freshOrder.shippo?.transactionId || '',
        trackingNumber: freshOrder.shippingTracking?.trackingNumber || '',
      });
    } catch (e) {
      const expired = isExpiredOrNotPurchasableRateError(e);

      try {
        const failedOrder = await Order.findById(order._id);

        if (failedOrder) {
          failedOrder.shippo = failedOrder.shippo || {};
          failedOrder.shippo.autoBuyAttemptedAt = new Date();
          failedOrder.shippo.autoBuyStatus = expired ? 'SKIPPED' : 'FAILED';

          const shippoDetail =
            e?.shippo?.detail ||
            e?.shippo?.message ||
            (Array.isArray(e?.shippo?.messages) ? JSON.stringify(e.shippo.messages) : '') ||
            (Array.isArray(e?.shippo?.validation_results)
              ? JSON.stringify(e.shippo.validation_results)
              : '') ||
            '';

          failedOrder.shippo.autoBuyLastError = truncate(
            [
              e?.message || (expired ? 'Rate expired / not purchasable' : 'Auto-buy failed'),
              shippoDetail,
            ]
              .filter(Boolean)
              .join(' | '),
            500,
          );

          await failedOrder.save();
        }
      } catch {
        // Do not crash the worker if failure bookkeeping fails.
      }

      if (expired) skipped++;
      else failed++;

      console.error('[auto-buy] label failed:', {
        orderId: order?.orderId,
        expired,
        msg: e?.message,
        code: e?.code,
        shippo: e?.shippo?.detail || e?.shippo?.message || e?.shippo?.messages || null,
      });
    }
  }

  return {
    ok: true,
    ran: true,
    count: orders.length,
    claimed,
    success,
    failed,
    skipped,
  };
}

function startAutoBuyLoop() {
  const enabled = boolEnv('SHIPPO_AUTO_BUY_ENABLED', false);

  if (!enabled) {
    console.log('[auto-buy] disabled (SHIPPO_AUTO_BUY_ENABLED=false)');
    return;
  }

  const intervalMinutes = numEnv('SHIPPO_AUTO_BUY_INTERVAL_MINUTES', 10);
  const ms = Math.max(1, intervalMinutes) * 60 * 1000;

  console.log(
    `[auto-buy] enabled. interval=${intervalMinutes}m afterHours=${numEnv(
      'SHIPPO_AUTO_BUY_AFTER_HOURS',
      23,
    )}h retryProcessingAfter=${numEnv('SHIPPO_AUTO_BUY_RETRY_PROCESSING_AFTER_MINUTES', 10)}m`,
  );

  setTimeout(() => {
    runAutoBuyOnce()
      .then((result) => console.log('[auto-buy] first run result:', result))
      .catch((e) => console.error('[auto-buy] first run crashed:', e?.message || e));
  }, 15 * 1000);

  setInterval(() => {
    runAutoBuyOnce()
      .then((result) => console.log('[auto-buy] interval result:', result))
      .catch((e) => console.error('[auto-buy] interval crashed:', e?.message || e));
  }, ms);
}

module.exports = { startAutoBuyLoop, runAutoBuyOnce };
