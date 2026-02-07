// utils/paypal/addTrackingToPaypalOrder.js
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
  const secret = mustEnv('PAYPAL_CLIENT_SECRET');

  const auth = Buffer.from(`${clientId}:${secret}`).toString('base64');

  const r = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const text = await r.text().catch(() => '');
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

  if (!r.ok) {
    const msg =
      data?.error_description ||
      data?.message ||
      data?.name ||
      data?.error ||
      data?.details?.[0]?.issue ||
      (typeof data?.raw === 'string' && data.raw.trim() ? data.raw.slice(0, 200) : '') ||
      'PayPal token error';
    throw new Error(msg);
  }

  return data.access_token;
}

// Map your common carrier values -> PayPal carrier enum
function normalizePaypalCarrier(raw) {
  const v = String(raw || '').trim();

  // shippo token -> paypal carrier
  const lower = v.toLowerCase();
  if (lower.includes('dhl')) return { carrier: 'DHL' };
  if (lower.includes('fedex')) return { carrier: 'FEDEX' };
  if (lower === 'ups' || lower.startsWith('ups ') || lower.startsWith('ups_') || lower.startsWith('ups-')) return { carrier: 'UPS' };
  if (lower.includes('usps')) return { carrier: 'USPS' };

  // already enum?
  const upper = v.toUpperCase();
  if (['DHL', 'FEDEX', 'UPS', 'USPS'].includes(upper)) return { carrier: upper };

  // fallback: OTHER + carrier_name_other
  if (v) return { carrier: 'OTHER', carrier_name_other: v };
  return { carrier: 'OTHER', carrier_name_other: 'Other' };
}

/**
 * ✅ Adds tracking to PayPal using Tracking API:
 * POST /v1/shipping/trackers-batch
 *
 * NOTE: transactionId MUST be the PayPal transaction id (capture id). 
 */
async function addTrackingToPaypalOrder({
  transactionId,          // capture id
  trackingNumber,
  carrier,                // "DHL" / "FEDEX" / "UPS" / "USPS" or "dhl_express" etc
  status = 'SHIPPED',      // "SHIPPED" is the normal value. 
}) {
  if (!transactionId) throw new Error('Missing transactionId (capture id)');
  if (!trackingNumber) throw new Error('Missing trackingNumber');
  if (!carrier) throw new Error('Missing carrier');

  const token = await getAccessToken();

  const c = normalizePaypalCarrier(carrier);

  const payload = {
    trackers: [
      {
        transaction_id: String(transactionId).trim(),
        tracking_number: String(trackingNumber).trim(),
        status: ['SHIPPED', 'DELIVERED', 'CANCELLED'].includes(String(status || '').trim().toUpperCase())
          ? String(status).trim().toUpperCase()
          : 'SHIPPED',

        carrier: c.carrier,
        ...(c.carrier === 'OTHER' ? { carrier_name_other: c.carrier_name_other } : {}),
      },
    ],
  };

  const r = await fetch(`${paypalBase()}/v1/shipping/trackers-batch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await r.text().catch(() => '');
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!r.ok) {
    const msg =
      data?.message ||
      data?.name ||
      data?.details?.[0]?.issue ||
      (typeof data?.raw === 'string' && data.raw.trim() ? data.raw.slice(0, 200) : '') ||
      'PayPal add tracking failed';
    throw new Error(msg);
  }

  return data;
}

module.exports = { addTrackingToPaypalOrder };
