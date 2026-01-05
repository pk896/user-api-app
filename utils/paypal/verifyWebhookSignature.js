// utils/paypal/verifyWebhookSignature.js
'use strict';

const { fetch } = require('undici');

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

function safeStr(v, max = 500) {
  return String(v || '').trim().slice(0, max);
}

function assertEnv() {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET for webhook verification.');
  }
  if (!PAYPAL_WEBHOOK_ID) {
    throw new Error('Missing PAYPAL_WEBHOOK_ID (set it from your PayPal webhook config).');
  }
}

async function getAccessToken() {
  assertEnv();
  const auth = Buffer.from(`${String(PAYPAL_CLIENT_ID).trim()}:${String(PAYPAL_CLIENT_SECRET).trim()}`).toString('base64');

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

function getHeader(req, name) {
  // Express lowercases header keys
  const key = String(name || '').toLowerCase();
  const v = req?.headers?.[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Verify PayPal webhook signature.
 *
 * IMPORTANT:
 * - This does NOT need the raw body string; PayPal accepts the parsed webhook_event object.
 * - Your server MUST mount the webhook route with express.raw(...) BEFORE express.json().
 *
 * Returns:
 *   { ok: true, verification_status: 'SUCCESS', raw }
 *   { ok: false, reason, ... }
 */
async function verifyWebhookSignature(req, eventBody) {
  try {
    // PayPal requires these headers
    const transmissionId = getHeader(req, 'paypal-transmission-id');
    const transmissionTime = getHeader(req, 'paypal-transmission-time');
    const certUrl = getHeader(req, 'paypal-cert-url');
    const authAlgo = getHeader(req, 'paypal-auth-algo');
    const transmissionSig = getHeader(req, 'paypal-transmission-sig');

    if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
      return {
        ok: false,
        reason: 'missing-required-headers',
        missing: {
          transmissionId: !transmissionId,
          transmissionTime: !transmissionTime,
          certUrl: !certUrl,
          authAlgo: !authAlgo,
          transmissionSig: !transmissionSig,
        },
      };
    }

    // webhook id must exist
    if (!PAYPAL_WEBHOOK_ID) {
      return { ok: false, reason: 'missing-webhook-id' };
    }

    const token = await getAccessToken();

    const payload = {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: eventBody,
    };

    const res = await fetch(`${PP_API}/v1/notifications/verify-webhook-signature`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        ok: false,
        reason: `verify-call-failed-${res.status}`,
        status: res.status,
        details: json,
      };
    }

    const status = String(json?.verification_status || '').toUpperCase();
    return {
      ok: status === 'SUCCESS',
      verification_status: status,
      raw: json,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'verify-exception',
      error: safeStr(e?.message || e, 500),
    };
  }
}

module.exports = { verifyWebhookSignature };
