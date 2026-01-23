'use strict';

const { fetch } = require('undici');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function paypalBase() {
  const mode = String(process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  return mode === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

async function getAccessToken() {
  const clientId = mustEnv('PAYPAL_CLIENT_ID');
  const secret = mustEnv('PAYPAL_SECRET');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error_description || 'PayPal token error');
  return data.access_token;
}

// carrier must be PayPal-supported value like "USPS", "UPS", "FEDEX", "DHL" etc.
async function addTrackingToPaypalOrder({ paypalOrderId, captureId, trackingNumber, carrier, notifyPayer = true }) {
  if (!paypalOrderId) throw new Error('Missing paypalOrderId');
  if (!captureId) throw new Error('Missing captureId');
  if (!trackingNumber) throw new Error('Missing trackingNumber');
  if (!carrier) throw new Error('Missing carrier');

  const token = await getAccessToken();

  const payload = {
    capture_id: captureId,
    tracking_number: trackingNumber,
    carrier,
    notify_payer: !!notifyPayer,
  };

  const r = await fetch(`${paypalBase()}/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/track`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(data?.message || data?.name || 'PayPal add tracking failed');
  }
  return data;
}

module.exports = { addTrackingToPaypalOrder };
