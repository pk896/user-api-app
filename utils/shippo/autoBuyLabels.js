// utils/shippo/autoBuyLabels.js
'use strict';

const Order = require('../../models/Order');
const { createLabelForOrder } = require('./createLabelForOrder');

const PAID_LIKE_STATUS = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const PAID_LIKE_PAYMENT_STATUS = ['paid', 'completed', 'captured'];

function numEnv(name, fallback) {
  const v = Number(String(process.env[name] ?? '').trim());
  return Number.isFinite(v) ? v : fallback;
}

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function truncate(str, max = 500) {
  return String(str || '').slice(0, max);
}

// Detect “rate expired / not found / cannot purchase” type errors safely
function isExpiredOrNotPurchasableRateError(err) {
  const msg = String(err?.message || '').toLowerCase();

  const shippoMessages = []
    .concat(err?.shippo?.messages || [])
    .concat(err?.shippo?.validation_results || [])
    .concat(err?.shippo?.detail || [])
    .map((m) => String(m?.text || m?.message || m || '').toLowerCase());

  const combined = [msg, ...shippoMessages].join(' | ');

  if (combined.includes('selected rate not found')) return true;
  if (combined.includes('rate') && combined.includes('not found')) return true;
  if (combined.includes('invalid rate')) return true;
  if (combined.includes('cannot purchase')) return true;

  // Some carriers require ship-date windows (Shippo can reject late purchases)
  if (combined.includes('shipment date')) return true;
  if (combined.includes('within 7 days')) return true;

  return false;
}

async function runAutoBuyOnce() {
  const enabled = boolEnv('SHIPPO_AUTO_BUY_ENABLED', false);
  if (!enabled) return { ok: true, ran: false, reason: 'disabled' };

  const hours = numEnv('SHIPPO_AUTO_BUY_AFTER_HOURS', 23); // default 23h
  const maxPerRun = numEnv('SHIPPO_AUTO_BUY_MAX_PER_RUN', 5);

  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  // ✅ only orders with payerRateId, no label yet, old enough, paid-like
  const query = {
    createdAt: { $lte: cutoff },
    $and: [
      { 'shippo.payerRateId': { $exists: true, $ne: '' } },

      { $or: [{ 'shippo.labelUrl': { $exists: false } }, { 'shippo.labelUrl': '' }, { 'shippo.labelUrl': null }] },
      { $or: [{ 'shippo.transactionId': { $exists: false } }, { 'shippo.transactionId': '' }, { 'shippo.transactionId': null }] },

      { $or: [{ 'shippo.autoBuyStatus': { $exists: false } }, { 'shippo.autoBuyStatus': 'PENDING' }, { 'shippo.autoBuyStatus': null }] },
      { $or: [{ 'shippo.autoBuyEnabled': { $exists: false } }, { 'shippo.autoBuyEnabled': true }] },

      // paid-like by status OR paymentStatus
      { $or: [{ status: { $in: PAID_LIKE_STATUS } }, { paymentStatus: { $in: PAID_LIKE_PAYMENT_STATUS } }] },
    ],
  };

  const orders = await Order.find(query).sort({ createdAt: 1 }).limit(maxPerRun);

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (const order of orders) {
    const payerRateId = String(order?.shippo?.payerRateId || '').trim();
    if (!payerRateId) continue;

    // ✅ multi-instance safety: claim the job atomically (PENDING -> PROCESSING)
    const claim = await Order.updateOne(
      {
        _id: order._id,
        $and: [
          {
            $or: [
              { 'shippo.autoBuyStatus': { $exists: false } },
              { 'shippo.autoBuyStatus': null },
              { 'shippo.autoBuyStatus': 'PENDING' },
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
        },
      }
    );

    // Someone else already claimed it
    if (!claim || claim.modifiedCount !== 1) continue;

    // ✅ Re-read fresh doc after claim (avoids stale document saves)
    const freshOrder = await Order.findById(order._id);
    if (!freshOrder) continue;

    try {
      const savedRate = freshOrder?.shippo?.chosenRate || null;

      // ✅ STRICT ONLY: buy exact payerRateId or stop
      const result = await createLabelForOrder(freshOrder, {
        rateId: payerRateId,
        chooseRate: 'payer',
        savedRate,
        strictRateId: true,
      });

      if (!result) throw new Error('Auto-buy failed: no result returned from createLabelForOrder()');

      const { shipment, chosenRate, transaction, trackingNumber, carrierToken } = result;

      // ✅ persist result (same structure your admin route uses)
      freshOrder.shippo = freshOrder.shippo || {};
      freshOrder.shippo.shipmentId = shipment?.object_id || freshOrder.shippo.shipmentId || null;
      freshOrder.shippo.transactionId = transaction?.object_id || null;
      freshOrder.shippo.rateId = chosenRate?.object_id || null;
      freshOrder.shippo.labelUrl = transaction?.label_url || null;
      freshOrder.shippo.trackingNumber = trackingNumber || transaction?.tracking_number || null;
      freshOrder.shippo.trackingStatus = transaction?.tracking_status || null;
      freshOrder.shippo.carrier = carrierToken || null;
      freshOrder.shippo.labelCreatedAt = new Date();

      freshOrder.shippo.autoBuyStatus = 'SUCCESS';
      freshOrder.shippo.autoBuyLastError = '';
      freshOrder.shippo.autoBuyLastSuccessAt = new Date();

      // ✅ Save chosen rate snapshot for UI (does NOT change payerRateId)
      freshOrder.shippo.chosenRate = {
        provider: String(chosenRate?.provider || '').trim() || null,
        service:
          String(chosenRate?.servicelevel?.name || chosenRate?.servicelevel?.token || '').trim() ||
          null,
        amount: chosenRate?.amount != null ? String(chosenRate.amount) : null,
        currency: String(chosenRate?.currency || '').trim() || null,
        estimatedDays: chosenRate?.estimated_days != null ? Number(chosenRate.estimated_days) : null,
        durationTerms: String(chosenRate?.duration_terms || '').trim() || null,
      };

      if (freshOrder.fulfillmentStatus === 'PAID' || freshOrder.fulfillmentStatus === 'PENDING') {
        freshOrder.fulfillmentStatus = 'LABEL_CREATED';
      }

      await freshOrder.save();
      success++;
    } catch (e) {
      const expired = isExpiredOrNotPurchasableRateError(e);

      try {
        // ✅ re-read again in catch so we don't overwrite unrelated newer changes
        const failedOrder = await Order.findById(order._id);
        if (failedOrder) {
          failedOrder.shippo = failedOrder.shippo || {};
          failedOrder.shippo.autoBuyAttemptedAt = new Date();
          failedOrder.shippo.autoBuyStatus = expired ? 'SKIPPED' : 'FAILED';

          const shippoDetail =
            e?.shippo?.detail ||
            e?.shippo?.message ||
            (Array.isArray(e?.shippo?.messages) ? JSON.stringify(e.shippo.messages) : '') ||
            '';

          failedOrder.shippo.autoBuyLastError = truncate(
            [e?.message || (expired ? 'Rate expired / not found' : 'Auto-buy failed'), shippoDetail]
              .filter(Boolean)
              .join(' | '),
            500
          );

          await failedOrder.save();
        }
      } catch {
        // ignore
      }

      if (expired) skipped++;
      else failed++;

      console.error('AUTO-BUY label failed:', {
        orderId: order?.orderId,
        msg: e?.message,
        shippo: e?.shippo?.detail || e?.shippo?.message || e?.shippo?.messages || null,
      });
    }
  }

  return { ok: true, ran: true, count: orders.length, success, failed, skipped };
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
      23
    )}h`
  );

  setTimeout(() => runAutoBuyOnce().catch(() => {}), 15 * 1000);
  setInterval(() => runAutoBuyOnce().catch(() => {}), ms);
}

module.exports = { startAutoBuyLoop, runAutoBuyOnce };