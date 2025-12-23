// routes/paypalWebhooks.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Payout = require('../models/Payout');

const { verifyWebhookSignature } = require('../utils/paypal/verifyWebhookSignature');

// We reuse your existing sync logic by importing it safely:
let runSyncPayoutById = null;
try {
  // Export runSyncPayoutById from adminPayouts.js or move it into utils.
  // Recommended: move to utils/payouts/syncPayout.js
  ({ runSyncPayoutById } = require('../utils/payouts/syncPayout'));
} catch (e) {
  // If you don’t have it yet, do it now (see section 2 below).
}

const router = express.Router();

/**
 * PayPal requires RAW body for signature verification.
 * Mount this route with express.raw({ type: 'application/json' })
 */
router.post('/paypal', async (req, res) => {
  try {
    const raw = req.body; // Buffer
    const eventBody = JSON.parse(raw.toString('utf8'));

    const ver = await verifyWebhookSignature(req, eventBody);
    if (!ver.ok) {
      return res.status(400).json({ ok: false, reason: ver.reason, verification_status: ver.verification_status });
    }

    const eventType = String(eventBody?.event_type || '').toUpperCase();

    // We only care about payout-related events
    const isPayoutEvent =
      eventType.includes('PAYOUTS') ||
      eventType.includes('PAYOUT') ||
      eventType.includes('PAYMENT.PAYOUTS');

    if (!isPayoutEvent) {
      return res.json({ ok: true, ignored: true, eventType });
    }

    // Try to find payout by batch id in resource
    const batchId =
      String(eventBody?.resource?.batch_header?.payout_batch_id || eventBody?.resource?.payout_batch_id || '').trim();

    if (!batchId) {
      // Still respond OK to prevent retries; log for debugging
      console.warn('PayPal webhook payout event missing batchId:', eventType);
      return res.json({ ok: true, ignored: true, reason: 'missing-batchId', eventType });
    }

    const payout = await Payout.findOne({ batchId }).select('_id batchId status').lean();
    if (!payout) {
      return res.json({ ok: true, ignored: true, reason: 'payout-not-found', batchId, eventType });
    }

    if (!runSyncPayoutById) {
      return res.status(500).json({ ok: false, error: 'sync handler not available (runSyncPayoutById)' });
    }

    // Sync to update items and auto-credit back failed
    const out = await runSyncPayoutById(payout._id);

    return res.json({ ok: true, eventType, batchId, payoutId: String(payout._id), sync: out });
  } catch (err) {
    console.error('PayPal webhook error:', err);
    // respond 200 to reduce retries if it’s non-critical
    return res.status(200).json({ ok: false, error: err.message });
  }
});

module.exports = router;
