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

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function mustEnv(name, v) {
  const s = String(v || '').trim();
  if (!s) throw new Error(`Missing env: ${name}`);
  return s;
}

function isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function clampStr(s, max) {
  const v = String(s || '');
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * PayPal expects amount.value as a string with 2 decimals.
 * We must never silently send 0.00 unless caller asked.
 */
function toMoneyString(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${value}`);
  const rounded = Math.round(n * 100) / 100;
  if (rounded <= 0) throw new Error(`Amount must be > 0 (got ${value})`);
  return rounded.toFixed(2);
}

/* -----------------------------
 * OAuth token caching
 * --------------------------- */
let cachedToken = null;
let cachedTokenExpMs = 0;

// Refresh a bit early (60s) to avoid edge expiry mid-request
const EXP_SKEW_MS = 60 * 1000;

async function fetchAccessToken() {
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

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PayPal token error: ${res.status} ${text}`);
  }

  const json = JSON.parse(text || '{}');
  const token = String(json.access_token || '').trim();
  const expiresIn = Number(json.expires_in || 0); // seconds
  const safeExpiresIn = expiresIn > 0 ? expiresIn : 8 * 60; // fallback: 8 minutes

  if (!token) throw new Error('PayPal token missing in response');

  // Cache with expiry
  const now = Date.now();
  cachedToken = token;
  cachedTokenExpMs = now + (safeExpiresIn * 1000);

  return token;
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedTokenExpMs && now < (cachedTokenExpMs - EXP_SKEW_MS)) {
    return cachedToken;
  }
  return fetchAccessToken();
}

/* -----------------------------
 * Payout calls
 * --------------------------- */

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

  const normalizedItems = items.map((it, idx) => {
    const receiver = String(it?.receiver || '').trim().toLowerCase();
    const currency = String(it?.currency || getBaseCurrency()).toUpperCase().trim() || getBaseCurrency();
    const note = clampStr(it?.note || '', 255);
    const senderItemId = clampStr(it?.senderItemId || '', 127);

    if (!isValidEmail(receiver)) {
      throw new Error(`Invalid receiver email at item[${idx}]: "${receiver}"`);
    }
    if (!senderItemId) {
      throw new Error(`Missing senderItemId at item[${idx}]`);
    }

    return {
      recipient_type: 'EMAIL',
      receiver,
      amount: {
        value: toMoneyString(it?.amount),
        currency,
      },
      note,
      sender_item_id: senderItemId,
    };
  });

  const token = await getAccessToken();

  const body = {
    sender_batch_header: {
      sender_batch_id: clampStr(String(senderBatchId || `payout-${Date.now()}`), 127),
      email_subject: String(emailSubject || 'You have received a payout'),
      email_message: String(emailMessage || ''),
    },
    items: normalizedItems,
  };

  const res = await fetch(`${PP_API}/v1/payments/payouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {};
    }
  })();

  if (!res.ok) {
    const msg = json?.message || json?.name || `PayPal payouts create failed (${res.status})`;
    throw new Error(msg);
  }

  return json;
}

async function getPayoutBatch(payoutBatchId) {
  const id = String(payoutBatchId || '').trim();
  if (!id) throw new Error('Missing payoutBatchId');

  const token = await getAccessToken();

  const res = await fetch(
    `${PP_API}/v1/payments/payouts/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  const text = await res.text();
  const json = (() => {
    try {
      return JSON.parse(text || '{}');
    } catch {
      return {};
    }
  })();

  if (!res.ok) {
    const msg = json?.message || json?.name || `PayPal payouts fetch failed (${res.status})`;
    throw new Error(msg);
  }

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