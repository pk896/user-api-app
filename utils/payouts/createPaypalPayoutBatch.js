// utils/payouts/createPaypalPayoutBatch.js
'use strict';

const { fetch } = require('undici');

function getPayPalMode() {
  return String(process.env.PAYPAL_MODE || 'sandbox').trim().toLowerCase() === 'live'
    ? 'live'
    : 'sandbox';
}

function getPayPalBase() {
  return getPayPalMode() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function mustEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clampStr(value, max) {
  const text = String(value || '').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function toMoneyString(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error(`Invalid payout amount: ${value}`);
  }

  const rounded = Math.round(numeric * 100) / 100;
  if (rounded <= 0) {
    throw new Error(`Payout amount must be greater than 0. Got: ${value}`);
  }

  return rounded.toFixed(2);
}

function buildPayPalErrorMessage(prefix, status, json, rawText) {
  const name = json?.name ? String(json.name) : '';
  const message = json?.message ? String(json.message) : '';
  const debugId = json?.debug_id ? String(json.debug_id) : '';

  const details = Array.isArray(json?.details)
    ? json.details
        .map((detail) => {
          const issue = detail?.issue ? String(detail.issue) : '';
          const description = detail?.description ? String(detail.description) : '';
          const field = detail?.field ? String(detail.field) : '';
          return [issue, description, field ? `field: ${field}` : ''].filter(Boolean).join(' - ');
        })
        .filter(Boolean)
        .join(' | ')
    : '';

  return [
    `${prefix} (${status})`,
    name,
    message,
    details,
    debugId ? `debug_id: ${debugId}` : '',
    rawText && !message ? String(rawText).slice(0, 500) : '',
  ]
    .filter(Boolean)
    .join(' | ');
}

async function fetchWithTimeout(url, options = {}, label = 'PayPal request') {
  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(process.env.PAYPAL_HTTP_TIMEOUT_MS || 30000));

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    const causeMessage =
      error?.cause?.message ||
      error?.cause?.code ||
      error?.code ||
      error?.message ||
      'Unknown network error';

    const err = new Error(
      `${label} failed before PayPal responded. API=${getPayPalBase()}. mode=${getPayPalMode()}. reason=${causeMessage}`
    );

    err.status = 'NETWORK_ERROR';
    err.paypal = {
      apiBase: getPayPalBase(),
      mode: getPayPalMode(),
      reason: String(causeMessage || ''),
      originalMessage: String(error?.message || ''),
      causeCode: String(error?.cause?.code || error?.code || ''),
    };

    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* -----------------------------
 * OAuth token cache
 * --------------------------- */

let cachedToken = null;
let cachedTokenExpiresAtMs = 0;
const EXPIRY_SKEW_MS = 60 * 1000;

async function fetchAccessToken() {
  const clientId = mustEnv('PAYPAL_CLIENT_ID');
  const clientSecret = mustEnv('PAYPAL_CLIENT_SECRET');

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetchWithTimeout(
    `${getPayPalBase()}/v1/oauth2/token`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    },
    'PayPal OAuth token request'
  );

  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = new Error(buildPayPalErrorMessage('PayPal token error', res.status, json, text));
    err.status = res.status;
    err.paypal = json;
    throw err;
  }

  const token = String(json.access_token || '').trim();
  const expiresInSeconds = Number(json.expires_in || 0);

  if (!token) {
    throw new Error('PayPal token response did not include access_token.');
  }

  cachedToken = token;
  cachedTokenExpiresAtMs = Date.now() + (expiresInSeconds > 0 ? expiresInSeconds : 480) * 1000;

  return token;
}

async function getAccessToken() {
  if (
    cachedToken &&
    cachedTokenExpiresAtMs &&
    Date.now() < cachedTokenExpiresAtMs - EXPIRY_SKEW_MS
  ) {
    return cachedToken;
  }

  return fetchAccessToken();
}

/* -----------------------------
 * Public functions
 * --------------------------- */

async function createPayoutBatch({ senderBatchId, emailSubject, emailMessage, items }) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('No payout items were provided.');
  }

  const normalizedItems = items.map((item, index) => {
    const receiver = String(item?.receiver || '').trim().toLowerCase();
    const currency = String(item?.currency || '').trim().toUpperCase() || getBaseCurrency();
    const senderItemId = clampStr(item?.senderItemId || '', 127);
    const note = clampStr(item?.note || '', 255);

    if (!isValidEmail(receiver)) {
      throw new Error(`Invalid PayPal receiver email at item[${index}]: "${receiver}"`);
    }

    if (!senderItemId) {
      throw new Error(`Missing senderItemId at payout item[${index}].`);
    }

    return {
      recipient_type: 'EMAIL',
      receiver,
      amount: {
        value: toMoneyString(item?.amount),
        currency,
      },
      note,
      sender_item_id: senderItemId,
    };
  });

  const token = await getAccessToken();

  const body = {
    sender_batch_header: {
      sender_batch_id: clampStr(senderBatchId || `payout-${Date.now()}`, 127),
      email_subject: clampStr(emailSubject || 'You have received a payout', 255),
      email_message: clampStr(emailMessage || '', 1000),
    },
    items: normalizedItems,
  };

  const res = await fetchWithTimeout(
    `${getPayPalBase()}/v1/payments/payouts`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    },
    'PayPal create payout batch request'
  );

  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = new Error(
      buildPayPalErrorMessage('PayPal payout batch create error', res.status, json, text)
    );
    err.status = res.status;
    err.paypal = json;
    throw err;
  }

  return json;
}

async function getPayoutBatch(payoutBatchId) {
  const batchId = String(payoutBatchId || '').trim();

  if (!batchId) {
    throw new Error('Missing payoutBatchId.');
  }

  const token = await getAccessToken();

  const res = await fetchWithTimeout(
    `${getPayPalBase()}/v1/payments/payouts/${encodeURIComponent(batchId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    'PayPal get payout batch request'
  );

  const text = await res.text();

  let json = {};
  try {
    json = JSON.parse(text || '{}');
  } catch {
    json = {};
  }

  if (!res.ok) {
    const err = new Error(
      buildPayPalErrorMessage('PayPal get payout batch error', res.status, json, text)
    );
    err.status = res.status;
    err.paypal = json;
    throw err;
  }

  return json;
}

async function paypalHealthCheck() {
  const token = await getAccessToken();

  return {
    ok: true,
    mode: getPayPalMode(),
    apiBase: getPayPalBase(),
    hasToken: !!token,
    tokenPreview: token ? `${token.slice(0, 8)}...` : '',
    baseCurrency: getBaseCurrency(),
  };
}

module.exports = {
  createPayoutBatch,
  getPayoutBatch,
  getPayPalBase,
  paypalHealthCheck,
};