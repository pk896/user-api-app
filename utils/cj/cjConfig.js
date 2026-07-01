// utils/cj/cjConfig.js
'use strict';

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

function maskSecret(value, visibleStart = 4, visibleEnd = 4) {
  const secret = String(value || '').trim();

  if (!secret) {
    return '';
  }

  if (secret.length <= visibleStart + visibleEnd) {
    return '*'.repeat(secret.length);
  }

  const hiddenLength = Math.max(
    8,
    secret.length - visibleStart - visibleEnd,
  );

  return (
    secret.slice(0, visibleStart) +
    '*'.repeat(hiddenLength) +
    secret.slice(-visibleEnd)
  );
}

const CJ_API_ENABLED = booleanFromEnv(
  process.env.CJ_API_ENABLED,
  false,
);

const CJ_API_KEY = String(
  process.env.CJ_API_KEY || '',
).trim();

const CJ_API_BASE_URL =
  normalizeBaseUrl(process.env.CJ_API_BASE_URL) ||
  'https://developers.cjdropshipping.com/api2.0/v1';

const CJ_API_TIMEOUT_MS = boundedInteger(
  process.env.CJ_API_TIMEOUT_MS,
  15000,
  3000,
  60000,
);

const CJ_ACCESS_TOKEN_REFRESH_BUFFER_MS = boundedInteger(
  process.env.CJ_ACCESS_TOKEN_REFRESH_BUFFER_MS,
  5 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000,
);

function assertCjConfigured() {
  if (!CJ_API_ENABLED) {
    const error = new Error('CJ API integration is disabled.');
    error.code = 'CJ_API_DISABLED';
    throw error;
  }

  if (!CJ_API_KEY) {
    const error = new Error('CJ_API_KEY is missing.');
    error.code = 'CJ_API_KEY_MISSING';
    throw error;
  }

  if (!/^https:\/\//i.test(CJ_API_BASE_URL)) {
    const error = new Error(
      'CJ_API_BASE_URL must use HTTPS.',
    );

    error.code = 'CJ_API_BASE_URL_INVALID';
    throw error;
  }

  return true;
}

module.exports = {
  CJ_API_ENABLED,
  CJ_API_KEY,
  CJ_API_BASE_URL,
  CJ_API_TIMEOUT_MS,
  CJ_ACCESS_TOKEN_REFRESH_BUFFER_MS,
  assertCjConfigured,
  maskSecret,
};
