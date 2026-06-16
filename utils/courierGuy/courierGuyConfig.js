// utils/courierGuy/courierGuyConfig.js
'use strict';

function normalizeMode(value) {
  const mode = String(value || 'sandbox')
    .trim()
    .toLowerCase();

  return mode === 'live' ? 'live' : 'sandbox';
}

function removeTrailingSlashes(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function getCourierGuyConfig() {
  const mode = normalizeMode(process.env.COURIER_GUY_MODE);

  const enabled = String(process.env.COURIER_GUY_ENABLED || 'false')
    .trim()
    .toLowerCase() === 'true';

  const sandboxBaseUrl = removeTrailingSlashes(
    process.env.COURIER_GUY_SANDBOX_API_BASE ||
      'https://api.shiplogic.com'
  );

  const liveBaseUrl = removeTrailingSlashes(
    process.env.COURIER_GUY_LIVE_API_BASE ||
      'https://api.shiplogic.com'
  );

  const sandboxApiKey = String(
    process.env.COURIER_GUY_SANDBOX_API_KEY || ''
  ).trim();

  const liveApiKey = String(
    process.env.COURIER_GUY_LIVE_API_KEY || ''
  ).trim();

  const baseUrl =
    mode === 'live'
      ? liveBaseUrl
      : sandboxBaseUrl;

  const apiKey =
    mode === 'live'
      ? liveApiKey
      : sandboxApiKey;

  const timeoutValue = Number(
    process.env.COURIER_GUY_TIMEOUT_MS || 30000
  );

  const timeoutMs = Number.isFinite(timeoutValue)
    ? Math.max(5000, Math.min(120000, Math.floor(timeoutValue)))
    : 30000;

  return {
    enabled,
    mode,
    baseUrl,
    apiKey,
    timeoutMs,
  };
}

function requireCourierGuyConfig() {
  const config = getCourierGuyConfig();

  if (!config.enabled) {
    const error = new Error(
      'The Courier Guy integration is disabled.'
    );

    error.code = 'COURIER_GUY_DISABLED';
    throw error;
  }

  if (!config.baseUrl) {
    const error = new Error(
      'The Courier Guy API base URL is missing.'
    );

    error.code = 'COURIER_GUY_BASE_URL_MISSING';
    throw error;
  }

  if (!config.apiKey) {
    const variableName =
      config.mode === 'live'
        ? 'COURIER_GUY_LIVE_API_KEY'
        : 'COURIER_GUY_SANDBOX_API_KEY';

    const error = new Error(
      `${variableName} is missing from the environment.`
    );

    error.code = 'COURIER_GUY_API_KEY_MISSING';
    throw error;
  }

  return config;
}

module.exports = {
  getCourierGuyConfig,
  requireCourierGuyConfig,
};
