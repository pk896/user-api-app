// utils/cj/cjTokenManager.js
'use strict';

const { fetch } = require('undici');

const CjApiCredential = require('../../models/CjApiCredential');

const {
  CJ_API_KEY,
  CJ_API_BASE_URL,
  CJ_API_TIMEOUT_MS,
  CJ_ACCESS_TOKEN_REFRESH_BUFFER_MS,
  assertCjConfigured,
} = require('./cjConfig');

const {
  scheduleCjApiCall,
} = require('./cjApiRateLimiter');

let tokenPromise = null;

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function parseDateOrNull(value) {
  if (!value) return null;

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
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

async function parseCjResponse(response) {
  const rawText = await response.text().catch(() => '');

  let body = {};

  try {
    body = rawText ? JSON.parse(rawText) : {};
  } catch {
    body = {
      raw: rawText.slice(0, 1000),
    };
  }

  const responseCode = Number(body?.code ?? response.status);

  const cjSuccess =
    response.ok &&
    body?.result !== false &&
    body?.success !== false &&
    responseCode === 200;

  if (!cjSuccess) {
    const error = new Error(
      safeString(
        body?.message ||
          body?.error ||
          body?.raw ||
          `CJ API request failed with HTTP ${response.status}`,
      ),
    );

    error.code = safeString(
      body?.code || body?.errorCode || `CJ_HTTP_${response.status}`,
      100,
    );

    error.status = response.status;
    error.requestId = safeString(body?.requestId, 200);
    error.responseBody = body;

    throw error;
  }

  return body;
}

async function getCredentialDocumentWithSecrets() {
  return CjApiCredential.findOne({ provider: 'CJ' }).select(
    '+accessToken +refreshToken +openId',
  );
}

async function recordCredentialFailure(error) {
  try {
    await CjApiCredential.findOneAndUpdate(
      { provider: 'CJ' },
      {
        $set: {
          lastErrorCode: safeString(error?.code, 100),
          lastErrorMessage: safeString(error?.message),
          lastRequestId: safeString(error?.requestId, 200),
        },
        $setOnInsert: {
          provider: 'CJ',
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      },
    );
  } catch (saveError) {
    console.error(
      '[CJ token] Failed to record credential error:',
      saveError?.message || saveError,
    );
  }
}

async function saveTokenResponse(data, mode) {
  const tokenData = data || {};

  const accessToken = safeString(tokenData.accessToken, 1000);
  const refreshToken = safeString(tokenData.refreshToken, 1000);
  const openId = safeString(tokenData.openId, 500);

  const accessTokenExpiresAt = parseDateOrNull(
    tokenData.accessTokenExpiryDate ||
      tokenData.accessTokenExpiresAt ||
      tokenData.accessTokenExpiry,
  );

  const refreshTokenExpiresAt = parseDateOrNull(
    tokenData.refreshTokenExpiryDate ||
      tokenData.refreshTokenExpiresAt ||
      tokenData.refreshTokenExpiry,
  );

  if (!accessToken) {
    const error = new Error('CJ did not return an access token.');
    error.code = 'CJ_ACCESS_TOKEN_MISSING';
    throw error;
  }

  const now = new Date();

  const update = {
    accessToken,
    accessTokenExpiresAt,
    lastErrorCode: '',
    lastErrorMessage: '',
    lastRequestId: '',
  };

  if (refreshToken) {
    update.refreshToken = refreshToken;
  }

  if (refreshTokenExpiresAt) {
    update.refreshTokenExpiresAt = refreshTokenExpiresAt;
  }

  if (openId) {
    update.openId = openId;
  }

  if (mode === 'AUTHENTICATE') {
    update.lastAuthenticatedAt = now;
  }

  if (mode === 'REFRESH') {
    update.lastRefreshedAt = now;
  }

  return CjApiCredential.findOneAndUpdate(
    { provider: 'CJ' },
    {
      $set: update,
      $setOnInsert: {
        provider: 'CJ',
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    },
  ).select('+accessToken +refreshToken +openId');
}

async function requestNewAccessToken() {
  assertCjConfigured();

  const response =
    await scheduleCjApiCall(() => {
      return fetchWithTimeout(
        `${CJ_API_BASE_URL}/authentication/getAccessToken`,
        {
          method: 'POST',

          headers: {
            Accept:
              'application/json',

            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            apiKey: CJ_API_KEY,
          }),
        },
      );
    });

  const body = await parseCjResponse(response);

  return saveTokenResponse(body?.data, 'AUTHENTICATE');
}

async function refreshExistingAccessToken(refreshToken) {
  assertCjConfigured();

  const cleanRefreshToken = safeString(refreshToken, 1000);

  if (!cleanRefreshToken) {
    const error = new Error('CJ refresh token is unavailable.');
    error.code = 'CJ_REFRESH_TOKEN_MISSING';
    throw error;
  }

  const response =
    await scheduleCjApiCall(() => {
      return fetchWithTimeout(
        `${CJ_API_BASE_URL}/authentication/refreshAccessToken`,
        {
          method: 'POST',

          headers: {
            Accept:
              'application/json',

            'Content-Type':
              'application/json',
          },

          body: JSON.stringify({
            refreshToken:
              cleanRefreshToken,
          }),
        },
      );
    });

  const body = await parseCjResponse(response);

  return saveTokenResponse(body?.data, 'REFRESH');
}

async function resolveAccessToken({ forceRefresh = false } = {}) {
  assertCjConfigured();

  if (tokenPromise) {
    return tokenPromise;
  }

  tokenPromise = (async () => {
    try {
      const credential = await getCredentialDocumentWithSecrets();

      const accessTokenStillUsable =
        credential?.accessToken &&
        credential?.accessTokenExpiresAt &&
        credential.accessTokenExpiresAt.getTime() -
          CJ_ACCESS_TOKEN_REFRESH_BUFFER_MS >
          Date.now();

      if (!forceRefresh && accessTokenStillUsable) {
        return safeString(credential.accessToken, 1000);
      }

      const refreshTokenStillUsable =
        credential?.refreshToken &&
        credential?.refreshTokenExpiresAt &&
        credential.refreshTokenExpiresAt.getTime() > Date.now();

      if (forceRefresh) {
        if (!refreshTokenStillUsable) {
          const error = new Error(
            'CJ refresh token is unavailable or expired. Obtain a new access token instead.',
          );
          error.code = 'CJ_REFRESH_TOKEN_UNAVAILABLE';
          throw error;
        }

        const refreshed = await refreshExistingAccessToken(
          credential.refreshToken,
        );

        return safeString(refreshed.accessToken, 1000);
      }

      if (refreshTokenStillUsable) {
        try {
          const refreshed = await refreshExistingAccessToken(
            credential.refreshToken,
          );

          return safeString(refreshed.accessToken, 1000);
        } catch (refreshError) {
          console.warn(
            '[CJ token] Automatic refresh failed; obtaining token with API key:',
            refreshError?.message || refreshError,
          );
        }
      }

      const authenticated = await requestNewAccessToken();

      return safeString(authenticated.accessToken, 1000);
    } catch (error) {
      await recordCredentialFailure(error);
      throw error;
    } finally {
      tokenPromise = null;
    }
  })();

  return tokenPromise;
}

async function forceRefreshAccessToken() {
  return resolveAccessToken({ forceRefresh: true });
}

module.exports = {
  parseCjResponse,
  resolveAccessToken,
  forceRefreshAccessToken,
  requestNewAccessToken,
};
