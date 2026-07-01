// utils/cj/cjClient.js
'use strict';

const { fetch } = require('undici');

const CjApiCredential = require('../../models/CjApiCredential');

const {
  CJ_API_BASE_URL,
  CJ_API_TIMEOUT_MS,
  assertCjConfigured,
} = require('./cjConfig');

const {
  parseCjResponse,
  resolveAccessToken,
  requestNewAccessToken,
} = require('./cjTokenManager');

function safeString(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = CJ_API_TIMEOUT_MS,
) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildUrl(pathname, query = {}) {
  const cleanPath = String(pathname || '').trim();

  if (!cleanPath.startsWith('/')) {
    const error = new Error('CJ API path must begin with "/".');
    error.code = 'CJ_API_PATH_INVALID';
    throw error;
  }

  const url = new URL(`${CJ_API_BASE_URL}${cleanPath}`);

  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        url.searchParams.append(key, String(entry));
      });

      return;
    }

    url.searchParams.set(key, String(value));
  });

  return url;
}

async function recordSuccessfulRequest(body) {
  try {
    await CjApiCredential.findOneAndUpdate(
      { provider: 'CJ' },
      {
        $set: {
          lastSuccessfulRequestAt: new Date(),
          lastRequestId: safeString(body?.requestId, 200),
          lastErrorCode: '',
          lastErrorMessage: '',
        },
        $setOnInsert: {
          provider: 'CJ',
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (error) {
    console.warn(
      '[CJ client] Failed to save successful request state:',
      error?.message || error,
    );
  }
}

async function performRequest({
  pathname,
  method,
  query,
  body,
  headers,
  accessToken,
}) {
  const cleanAccessToken = safeString(accessToken, 1000);

  if (!cleanAccessToken) {
    const error = new Error('CJ access token is empty.');
    error.code = 'CJ_ACCESS_TOKEN_EMPTY';
    throw error;
  }

  const requestHeaders = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'CJ-Access-Token': cleanAccessToken,
    ...headers,
  };

  const requestBody =
    body === undefined ? undefined : JSON.stringify(body);

  const response = await fetchWithTimeout(
    buildUrl(pathname, query),
    {
      method,
      headers: requestHeaders,
      body: requestBody,
    },
  );

  return parseCjResponse(response);
}

function isAuthenticationFailure(error) {
  const code = String(error?.code || '').trim();

  return (
    Number(error?.status) === 401 ||
    code === '1600001' ||
    code === '1600002' ||
    code === '1600003'
  );
}

async function cjRequest(
  pathname,
  {
    method = 'GET',
    query = {},
    body,
    headers = {},
    retryAuthentication = true,
  } = {},
) {
  assertCjConfigured();

  const normalizedMethod = String(method || 'GET')
    .trim()
    .toUpperCase();

  const accessToken = await resolveAccessToken();

  try {
    const parsed = await performRequest({
      pathname,
      method: normalizedMethod,
      query,
      body,
      headers,
      accessToken,
    });

    await recordSuccessfulRequest(parsed);

    return parsed;
  } catch (firstError) {
    if (
      !retryAuthentication ||
      !isAuthenticationFailure(firstError)
    ) {
      throw firstError;
    }

    console.warn(
      '[CJ client] Stored CJ token was rejected. Obtaining a new token with the API key.',
    );

    /*
     * Important:
     * Do not attempt refresh here.
     *
     * CJ may reject the stored refresh token with code 1600003.
     * Reauthenticate directly with the private API key instead.
     */
    const authenticatedCredential =
      await requestNewAccessToken();

    const replacementToken = safeString(
      authenticatedCredential?.accessToken,
      1000,
    );

    if (!replacementToken) {
      const error = new Error(
        'CJ authentication did not return a replacement access token.',
      );

      error.code = 'CJ_REPLACEMENT_TOKEN_MISSING';
      throw error;
    }

    /*
     * CJ limits authentication endpoints to one request per second.
     * Leave a small gap before using the newly issued token.
     */
    await new Promise((resolve) => {
      setTimeout(resolve, 1200);
    });

    const retryParsed = await performRequest({
      pathname,
      method: normalizedMethod,
      query,
      body,
      headers,
      accessToken: replacementToken,
    });

    await recordSuccessfulRequest(retryParsed);

    return retryParsed;
  }
}

module.exports = {
  cjRequest,
};
