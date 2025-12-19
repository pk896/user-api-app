// routes/paypalWebhooks.js
'use strict';

const express = require('express');
const { fetch } = require('undici');

const Payout = require('../models/Payout');
const SellerBalanceLedger = require('../models/SellerBalanceLedger');

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
  PAYPAL_WEBHOOK_ID,
} = process.env;

const PP_API =
  String(PAYPAL_MODE).toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const router = express.Router();

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

function normalizeTxStatus(s) {
  const v = String(s || '').trim().toUpperCase();
  return v || 'PENDING';
}

function mapToItemStatus(txStatus) {
  const v = normalizeTxStatus(txStatus);
  if (v === 'SUCCESS') return 'SENT';
  if (v === 'FAILED' || v === 'RETURNED' || v === 'BLOCKED') return 'FAILED';
  return 'PENDING';
}

async function verifyWebhookSignature(headers, rawBody) {
  // If you haven't set PAYPAL_WEBHOOK_ID yet, accept but log (dev-friendly)
  if (!String(PAYPAL_WEBHOOK_ID || '').trim()) return { ok: true, skipped: 'no-webhook-id' };

  const token = await getAccessToken();

  const body = {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: PAYPAL_WEBHOOK_ID,
    webhook_event: JSON.parse(rawBody.toString('utf8')),
  };

  const res = await fetch(`${PP_API}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `Webhook verify failed (${res.status})`);

  return {
    ok: String(json?.verification_status || '').toUpperCase() === 'SUCCESS',
    verification_status: json?.verification_status,
  };
}

// ✅ PayPal requires RAW body for verification
router.post(
  '/paypal',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const rawBody = req.body; // Buffer
      const headers = {};
      for (const [k, v] of Object.entries(req.headers || {})) headers[k.toLowerCase()] = v;

      const verified = await verifyWebhookSignature(headers, rawBody);
      if (!verified.ok) {
        return res.status(401).json({ ok: false, message: 'Invalid webhook signature' });
      }

      const event = JSON.parse(rawBody.toString('utf8'));
      const eventType = String(event?.event_type || '').trim();

      // Payout webhooks of interest:
      // PAYOUTS-ITEM.SUCCEEDED / FAILED / BLOCKED / RETURNED / UNCLAIMED
      const resource = event?.resource || {};
      const batchId =
        resource?.payout_batch_id ||
        resource?.batch_header?.payout_batch_id ||
        resource?.payout_batch_id ||
        null;

      const payoutItemId =
        resource?.payout_item_id ||
        resource?.payout_item?.payout_item_id ||
        null;

      const txStatus =
        resource?.transaction_status ||
        resource?.payout_item?.transaction_status ||
        resource?.transaction_status ||
        null;

      if (!batchId) {
        return res.json({ ok: true, ignored: true, reason: 'no-batchId' });
      }

      const payout = await Payout.findOne({ batchId: String(batchId).trim() });
      if (!payout) {
        return res.json({ ok: true, ignored: true, reason: 'payout-not-found' });
      }

      // update one item if payoutItemId present
      if (payoutItemId) {
        const items = Array.isArray(payout.items) ? payout.items : [];
        const idx = items.findIndex((it) => String(it.paypalItemId || '') === String(payoutItemId));
        // if paypalItemId wasn't stored yet, we can also try receiver+amount matching later (optional)
        if (idx >= 0) {
          const nextStatus = mapToItemStatus(txStatus);
          items[idx].status = nextStatus;
          payout.items = items;

          // auto credit-back on FAILED (idempotent), same as your sync route
          if (nextStatus === 'FAILED') {
            const uniqueKey = `creditback:${String(payout._id)}:${String(items[idx].businessId)}:${String(payoutItemId)}`;

            const exists = await SellerBalanceLedger.findOne({
              payoutId: payout._id,
              type: 'ADJUSTMENT',
              'meta.uniqueKey': uniqueKey,
            }).select('_id').lean();

            if (!exists) {
              await SellerBalanceLedger.create({
                businessId: items[idx].businessId,
                type: 'ADJUSTMENT',
                amountCents: Math.abs(items[idx].amountCents),
                currency: String(items[idx].currency || payout.currency || 'USD').toUpperCase(),
                payoutId: payout._id,
                note: `Auto credit-back for failed payout (${payout.batchId})`,
                meta: { uniqueKey, webhookEventType: eventType, payoutItemId, txStatus },
              });
            }
          }

          await payout.save();
        }
      }

      return res.json({ ok: true });
    } catch (e) {
      console.error('PayPal webhook error:', e?.message || e);
      return res.status(500).json({ ok: false });
    }
  }
);

module.exports = router;
