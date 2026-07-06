// utils/paypal/paypalClient.js
'use strict';

const crypto = require('crypto');
const { fetch } = require('undici');

function safeString(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function getPaypalMode() {
  return String(process.env.PAYPAL_MODE || 'sandbox')
    .trim()
    .toLowerCase() === 'live'
    ? 'live'
    : 'sandbox';
}

function getPaypalBaseUrl() {
  return getPaypalMode() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function getPaypalClientId() {
  return safeString(process.env.PAYPAL_CLIENT_ID, 500);
}

function getPaypalClientSecret() {
  return safeString(process.env.PAYPAL_CLIENT_SECRET, 1000);
}

function getTimeoutMs() {
  const value = Number.parseInt(String(process.env.PAYPAL_API_TIMEOUT_MS || '20000').trim(), 10);

  if (!Number.isFinite(value)) {
    return 20000;
  }

  return Math.max(5000, Math.min(120000, value));
}

function assertPaypalConfigured() {
  if (!getPaypalClientId()) {
    const error = new Error('PAYPAL_CLIENT_ID is missing.');

    error.code = 'PAYPAL_CLIENT_ID_MISSING';

    throw error;
  }

  if (!getPaypalClientSecret()) {
    const error = new Error('PAYPAL_CLIENT_SECRET is missing.');

    error.code = 'PAYPAL_CLIENT_SECRET_MISSING';

    throw error;
  }

  return true;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = getTimeoutMs()) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('PayPal API request timed out.');

      timeoutError.code = 'PAYPAL_REQUEST_TIMEOUT';

      timeoutError.status = 504;

      timeoutError.cause = error;

      throw timeoutError;
    }

    const networkMessage = safeString(error?.message || error, 1000).toLowerCase();

    if (
      networkMessage.includes('fetch failed') ||
      networkMessage.includes('network') ||
      networkMessage.includes('socket') ||
      networkMessage.includes('timeout') ||
      error?.code ||
      error?.cause?.code
    ) {
      const networkError = new Error(
        'PayPal API could not be reached. The payment status must be verified before continuing.',
      );

      networkError.code = 'PAYPAL_NETWORK_ERROR';

      networkError.status = 503;

      networkError.cause = error;

      throw networkError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePaypalErrorMessage(body, fallback) {
  const details = Array.isArray(body?.details) ? body.details : [];

  const detailMessage = details
    .map((detail) => safeString(detail?.description || detail?.issue, 500))
    .filter(Boolean)
    .join(' ');

  return (
    detailMessage ||
    safeString(body?.message, 1000) ||
    safeString(body?.error_description, 1000) ||
    safeString(body?.error, 500) ||
    safeString(body?.name, 500) ||
    fallback
  );
}

async function parsePaypalResponse(response) {
  const rawText = await response.text().catch(() => '');

  let body = {};

  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    body = {
      raw: rawText.slice(0, 2000),
    };
  }

  if (!response.ok) {
    const error = new Error(
      normalizePaypalErrorMessage(body, `PayPal API request failed with HTTP ${response.status}.`),
    );

    error.code = safeString(body?.name || body?.error || `PAYPAL_HTTP_${response.status}`, 200);

    error.status = response.status;

    error.debugId = safeString(body?.debug_id, 300);

    error.responseBody = body;

    throw error;
  }

  return body;
}

let accessTokenCache = {
  token: '',
  expiresAt: 0,
};

let accessTokenPromise = null;

function clearPaypalAccessTokenCache() {
  accessTokenCache = {
    token: '',
    expiresAt: 0,
  };
}

async function requestPaypalAccessToken() {
  assertPaypalConfigured();

  const credentials = Buffer.from(`${getPaypalClientId()}:${getPaypalClientSecret()}`).toString(
    'base64',
  );

  const response = await fetchWithTimeout(`${getPaypalBaseUrl()}/v1/oauth2/token`, {
    method: 'POST',

    headers: {
      Authorization: `Basic ${credentials}`,

      Accept: 'application/json',

      'Content-Type': 'application/x-www-form-urlencoded',
    },

    body: 'grant_type=client_credentials',
  });

  const body = await parsePaypalResponse(response);

  const accessToken = safeString(body?.access_token, 2000);

  const expiresInSeconds = Number(body?.expires_in || 0);

  if (!accessToken) {
    const error = new Error('PayPal did not return an access token.');

    error.code = 'PAYPAL_ACCESS_TOKEN_MISSING';

    throw error;
  }

  const usableLifetimeMs =
    Number.isFinite(expiresInSeconds) && expiresInSeconds > 0
      ? Math.max(60000, expiresInSeconds * 1000 - 5 * 60 * 1000)
      : 5 * 60 * 1000;

  accessTokenCache = {
    token: accessToken,

    expiresAt: Date.now() + usableLifetimeMs,
  };

  return accessToken;
}

async function getPaypalAccessToken({ forceRefresh = false } = {}) {
  if (!forceRefresh && accessTokenCache.token && accessTokenCache.expiresAt > Date.now()) {
    return accessTokenCache.token;
  }

  if (accessTokenPromise) {
    return accessTokenPromise;
  }

  accessTokenPromise = requestPaypalAccessToken();

  try {
    return await accessTokenPromise;
  } finally {
    accessTokenPromise = null;
  }
}

function createRequestId(prefix = 'paypal') {
  return [
    safeString(prefix, 40) || 'paypal',

    Date.now().toString(36),

    crypto.randomBytes(12).toString('hex'),
  ]
    .join('-')
    .slice(0, 108);
}

async function paypalRequest(
  pathname,
  { method = 'GET', body, requestId = '', headers = {}, retryAuthentication = true } = {},
) {
  assertPaypalConfigured();

  const cleanPath = safeString(pathname, 1000);

  if (!cleanPath.startsWith('/')) {
    const error = new Error('PayPal API path must start with "/".');

    error.code = 'PAYPAL_API_PATH_INVALID';

    throw error;
  }

  const normalizedMethod = safeString(method, 20).toUpperCase() || 'GET';

  const accessToken = await getPaypalAccessToken();

  const requestHeaders = {
    Authorization: `Bearer ${accessToken}`,

    Accept: 'application/json',

    'Content-Type': 'application/json',

    Prefer: 'return=representation',

    ...headers,
  };

  const cleanRequestId = safeString(requestId, 108);

  if (cleanRequestId) {
    requestHeaders['PayPal-Request-Id'] = cleanRequestId;
  }

  try {
    const response = await fetchWithTimeout(`${getPaypalBaseUrl()}${cleanPath}`, {
      method: normalizedMethod,

      headers: requestHeaders,

      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return await parsePaypalResponse(response);
  } catch (firstError) {
    if (!retryAuthentication || Number(firstError?.status) !== 401) {
      throw firstError;
    }

    clearPaypalAccessTokenCache();

    const replacementToken = await getPaypalAccessToken({
      forceRefresh: true,
    });

    const retryHeaders = {
      ...requestHeaders,

      Authorization: `Bearer ${replacementToken}`,
    };

    const retryResponse = await fetchWithTimeout(`${getPaypalBaseUrl()}${cleanPath}`, {
      method: normalizedMethod,

      headers: retryHeaders,

      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return parsePaypalResponse(retryResponse);
  }
}

async function createPaypalOrder({ payload, requestId = '' }) {
  if (!payload || typeof payload !== 'object') {
    const error = new Error('A PayPal create-order payload is required.');

    error.code = 'PAYPAL_CREATE_PAYLOAD_REQUIRED';

    throw error;
  }

  return paypalRequest('/v2/checkout/orders', {
    method: 'POST',

    body: payload,

    requestId: requestId || createRequestId('paypal-create'),
  });
}

async function getPaypalOrder(paypalOrderId) {
  const cleanOrderId = safeString(paypalOrderId, 100);

  if (!cleanOrderId) {
    const error = new Error('PayPal order ID is required.');

    error.code = 'PAYPAL_ORDER_ID_REQUIRED';

    throw error;
  }

  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(cleanOrderId)}`, {
    method: 'GET',
  });
}

async function capturePaypalOrder({ paypalOrderId, requestId = '' }) {
  const cleanOrderId = safeString(paypalOrderId, 100);

  if (!cleanOrderId) {
    const error = new Error('PayPal order ID is required.');

    error.code = 'PAYPAL_ORDER_ID_REQUIRED';

    throw error;
  }

  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(cleanOrderId)}/capture`, {
    method: 'POST',

    body: {},

    requestId: requestId || createRequestId('paypal-capture'),
  });
}

function findPaypalLink(response, relation) {
  const wantedRelation = safeString(relation, 100).toLowerCase();

  const links = Array.isArray(response?.links) ? response.links : [];

  return links.find((link) => safeString(link?.rel, 100).toLowerCase() === wantedRelation) || null;
}

function getPaypalApprovalUrl(response) {
  return safeString(findPaypalLink(response, 'approve')?.href, 2000);
}

function getPaypalCapture(captureResponse) {
  const purchaseUnits = Array.isArray(captureResponse?.purchase_units)
    ? captureResponse.purchase_units
    : [];

  for (const purchaseUnit of purchaseUnits) {
    const captures = Array.isArray(purchaseUnit?.payments?.captures)
      ? purchaseUnit.payments.captures
      : [];

    if (captures.length) {
      return captures[0];
    }
  }

  return null;
}

module.exports = {
  getPaypalMode,
  getPaypalBaseUrl,
  assertPaypalConfigured,

  getPaypalAccessToken,
  clearPaypalAccessTokenCache,

  createRequestId,
  paypalRequest,

  createPaypalOrder,
  getPaypalOrder,
  capturePaypalOrder,

  findPaypalLink,
  getPaypalApprovalUrl,
  getPaypalCapture,
};
