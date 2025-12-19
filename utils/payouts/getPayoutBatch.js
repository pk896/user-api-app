// utils/payouts/getPayoutBatch.js
'use strict';

const { fetch } = require('undici');
const { getPayPalBase } = require('./createPaypalPayoutBatch');

async function getPayPalAccessToken() {
  const base = getPayPalBase();
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  const auth = Buffer.from(`${id}:${secret}`).toString('base64');

  const res = await fetch(`${base}/v1/oauth2/token`, {
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

async function getPayoutBatch(batchId) {
  if (!batchId) throw new Error('batchId is required');
  const base = getPayPalBase();
  const token = await getPayPalAccessToken();

  const res = await fetch(`${base}/v1/payments/payouts/${encodeURIComponent(batchId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`PayPal get payout batch failed (${res.status}): ${json?.message || JSON.stringify(json)}`);
  }

  return json;
}

module.exports = { getPayoutBatch };
