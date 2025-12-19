// utils/payouts/createPaypalPayoutBatch.js
'use strict';

const { fetch } = require('undici');

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
} = process.env;

const PP_API =
  String(PAYPAL_MODE).toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

function mustEnv(name, v) {
  const s = String(v || '').trim();
  if (!s) throw new Error(`Missing env: ${name}`);
  return s;
}

async function getAccessToken() {
  const cid = mustEnv('PAYPAL_CLIENT_ID', PAYPAL_CLIENT_ID);
  const sec = mustEnv('PAYPAL_CLIENT_SECRET', PAYPAL_CLIENT_SECRET);

  const auth = Buffer.from(`${cid}:${sec}`).toString('base64');

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

function toMoneyStringFrom(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.00';
  return n.toFixed(2);
}

/**
 * Create a payout batch:
 * items: [{ receiver, amount, currency, note, senderItemId }]
 */
async function createPayoutBatch({
  senderBatchId,
  emailSubject,
  emailMessage,
  items,
}) {
  if (!Array.isArray(items) || !items.length) throw new Error('No payout items');

  const token = await getAccessToken();

  const body = {
    sender_batch_header: {
      sender_batch_id: String(senderBatchId || `payout-${Date.now()}`),
      email_subject: String(emailSubject || 'You have a payout'),
      email_message: String(emailMessage || ''),
    },
    items: items.map((it) => ({
      recipient_type: 'EMAIL',
      receiver: String(it.receiver || '').trim(),
      amount: {
        value: toMoneyStringFrom(it.amount),
        currency: String(it.currency || 'USD').toUpperCase(),
      },
      note: String(it.note || '').slice(0, 255),
      sender_item_id: String(it.senderItemId || '').slice(0, 127),
    })),
  };

  const res = await fetch(`${PP_API}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `PayPal payouts create failed (${res.status})`);
  return json;
}

async function getPayoutBatch(payoutBatchId) {
  const token = await getAccessToken();

  const res = await fetch(
    `${PP_API}/v1/payments/payouts/${encodeURIComponent(String(payoutBatchId))}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || `PayPal payouts fetch failed (${res.status})`);
  return json;
}

function getPayPalBase() {
  return PP_API;
}

module.exports = {
  createPayoutBatch,
  getPayoutBatch,
  getPayPalBase,
};
