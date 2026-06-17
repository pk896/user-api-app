// utils/courierGuy/courierGuyClient.js
'use strict';

const { fetch } = require('undici');

const { requireCourierGuyConfig } = require('./courierGuyConfig');

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value || '');
  }
}

function safeErrorMessage(data, status) {
  if (typeof data?.message === 'string' && data.message.trim()) {
    return data.message.trim();
  }

  if (typeof data?.detail === 'string' && data.detail.trim()) {
    return data.detail.trim();
  }

  if (typeof data?.error === 'string' && data.error.trim()) {
    return data.error.trim();
  }

  if (Array.isArray(data?.errors) && data.errors.length) {
    return safeJson(data.errors).slice(0, 1500);
  }

  if (data?.errors && typeof data.errors === 'object') {
    return safeJson(data.errors).slice(0, 1500);
  }

  if (Array.isArray(data?.validation_errors) && data.validation_errors.length) {
    return safeJson(data.validation_errors).slice(0, 1500);
  }

  if (data?.validation_errors && typeof data.validation_errors === 'object') {
    return safeJson(data.validation_errors).slice(0, 1500);
  }

  if (data?.message && typeof data.message === 'object') {
    return safeJson(data.message).slice(0, 1500);
  }

  if (data?.detail && typeof data.detail === 'object') {
    return safeJson(data.detail).slice(0, 1500);
  }

  if (typeof data?.raw === 'string' && data.raw.trim()) {
    return data.raw.trim().slice(0, 1500);
  }

  if (data && typeof data === 'object' && Object.keys(data).length) {
    return safeJson(data).slice(0, 1500);
  }

  return `Shiplogic returned HTTP ${status}.`;
}

async function courierGuyRequest(path, { method = 'GET', body, timeoutMs, headers = {} } = {}) {
  const config = requireCourierGuyConfig();

  const requestTimeout = Number.isFinite(Number(timeoutMs))
    ? Math.max(5000, Math.min(120000, Number(timeoutMs)))
    : config.timeoutMs;

  const normalizedPath = String(path || '').startsWith('/')
    ? String(path)
    : `/${String(path || '')}`;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, requestTimeout);

  try {
    const response = await fetch(`${config.baseUrl}${normalizedPath}`, {
      method: String(method || 'GET').toUpperCase(),

      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...headers,
      },

      body: body === undefined || body === null ? undefined : JSON.stringify(body),

      signal: controller.signal,
    });

    const responseText = await response.text().catch(() => '');

    let data = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {
        raw: responseText.slice(0, 3000),
      };
    }

    if (!response.ok) {
      const requestMethod = String(method || 'GET').toUpperCase();

      const errorMessage = safeErrorMessage(data, response.status);

      console.error('[Courier Guy API rejected request]', {
        method: requestMethod,
        path: normalizedPath,
        status: response.status,
        message: errorMessage,
      });

      const error = new Error(errorMessage);

      error.code = 'COURIER_GUY_API_ERROR';
      error.status = response.status;
      error.shiplogic = data;
      error.method = requestMethod;
      error.path = normalizedPath;

      throw error;
    }

    return {
      ok: true,
      mode: config.mode,
      baseUrl: config.baseUrl,
      status: response.status,
      data,
    };
  } catch (error) {
    if (
      error?.name === 'AbortError' ||
      String(error?.message || '')
        .toLowerCase()
        .includes('aborted')
    ) {
      const timeoutError = new Error('The Courier Guy request timed out.');

      timeoutError.code = 'COURIER_GUY_TIMEOUT';
      timeoutError.status = 504;
      timeoutError.path = normalizedPath;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  courierGuyRequest,
};
