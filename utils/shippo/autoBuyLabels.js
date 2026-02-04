// utils/shippo/autoBuyLabels.js
'use strict';

const Order = require('../../models/Order');
const { createLabelForOrder } = require('./createLabelForOrder');

const PAID_LIKE = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];

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

  const hours = numEnv('SHIPPO_AUTO_BUY_AFTER_HOURS', 30); // default 30h
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
      { $or: [{ status: { $in: PAID_LIKE } }, { paymentStatus: { $in: PAID_LIKE } }] },
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

    try {
      const savedRate = order?.shippo?.chosenRate || null;

      // ✅ STRICT ONLY: buy exact payerRateId or stop
      const result = await createLabelForOrder(order, {
        rateId: payerRateId,
        chooseRate: 'payer',
        savedRate,
        strictRateId: true,
      });

      if (!result) throw new Error('Auto-buy failed: no result returned from createLabelForOrder()');

      const { shipment, chosenRate, transaction, carrierToken } = result;

      // ✅ persist result (same structure your admin route uses)
      order.shippo = order.shippo || {};
      order.shippo.shipmentId = shipment?.object_id || order.shippo.shipmentId || null;
      order.shippo.transactionId = transaction?.object_id || null;
      order.shippo.rateId = chosenRate?.object_id || null;
      order.shippo.labelUrl = transaction?.label_url || null;
      order.shippo.trackingStatus = transaction?.tracking_status || null;
      order.shippo.carrier = carrierToken || null;

      order.shippo.autoBuyStatus = 'SUCCESS';
      order.shippo.autoBuyLastError = '';
      order.shippo.autoBuyLastSuccessAt = new Date();

      // ✅ Save chosen rate snapshot for UI (does NOT change payerRateId)
      order.shippo.chosenRate = {
        provider: String(chosenRate?.provider || '').trim() || null,
        service:
          String(chosenRate?.servicelevel?.name || chosenRate?.servicelevel?.token || '').trim() ||
          null,
        amount: chosenRate?.amount != null ? String(chosenRate.amount) : null,
        currency: String(chosenRate?.currency || '').trim() || null,
        estimatedDays: chosenRate?.estimated_days != null ? Number(chosenRate.estimated_days) : null,
        durationTerms: String(chosenRate?.duration_terms || '').trim() || null,
      };

      if (order.fulfillmentStatus === 'PAID' || order.fulfillmentStatus === 'PENDING') {
        order.fulfillmentStatus = 'LABEL_CREATED';
      }

      await order.save();
      success++;
    } catch (e) {
      const expired = isExpiredOrNotPurchasableRateError(e);

      try {
        order.shippo = order.shippo || {};
        order.shippo.autoBuyAttemptedAt = new Date();
        order.shippo.autoBuyStatus = expired ? 'SKIPPED' : 'FAILED';
        order.shippo.autoBuyLastError = truncate(
          e?.message || (expired ? 'Rate expired / not found' : 'Auto-buy failed'),
          500
        );
        await order.save();
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
      30
    )}h`
  );

  setTimeout(() => runAutoBuyOnce().catch(() => {}), 15 * 1000);
  setInterval(() => runAutoBuyOnce().catch(() => {}), ms);
}

module.exports = { startAutoBuyLoop, runAutoBuyOnce };
