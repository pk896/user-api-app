// utils/courierGuy/renderCourierGuyZplToPdf.js
'use strict';

const { fetch } = require('undici');

function clean(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizeDpmm(value) {
  const raw = clean(value, 20).toLowerCase().replace(/\s+/g, '');

  const aliases = {
    6: '6dpmm',
    '6dpmm': '6dpmm',

    8: '8dpmm',
    '8dpmm': '8dpmm',

    12: '12dpmm',
    '12dpmm': '12dpmm',

    24: '24dpmm',
    '24dpmm': '24dpmm',
  };

  return aliases[raw] || '';
}

function numberEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);

  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function getLabelaryConfig() {
  const apiBase = clean(
    process.env.LABELARY_API_BASE || 'https://api.labelary.com/v1',
    500,
  ).replace(/\/+$/, '');

  const configuredDpmm =
    process.env.LABELARY_DPMM === undefined ||
    process.env.LABELARY_DPMM === null ||
    String(process.env.LABELARY_DPMM).trim() === ''
      ? '8dpmm'
      : process.env.LABELARY_DPMM;

  const dpmm = normalizeDpmm(configuredDpmm);

  const widthInches = clean(process.env.LABELARY_LABEL_WIDTH_INCHES || '4', 20);

  const heightInches = clean(process.env.LABELARY_LABEL_HEIGHT_INCHES || '6', 20);

  const timeoutMs = numberEnv('LABELARY_TIMEOUT_MS', 45000, 5000, 120000);

  const maxZplBytes = numberEnv('LABELARY_MAX_ZPL_BYTES', 1000000, 1000, 1000000);

  const maxPdfBytes = numberEnv('LABELARY_MAX_PDF_BYTES', 20000000, 100000, 50000000);

  if (!/^https:\/\//i.test(apiBase)) {
    const error = new Error('LABELARY_API_BASE must use HTTPS.');

    error.code = 'LABELARY_API_BASE_INVALID';

    throw error;
  }

  if (!dpmm) {
    const error = new Error(
      'LABELARY_DPMM must be 6, 8, 12, or 24. Values such as 8 and 8dpmm are both supported.',
    );

    error.code = 'LABELARY_DPMM_INVALID';

    throw error;
  }

  const width = Number(widthInches);
  const height = Number(heightInches);

  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    width > 15 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    height > 15
  ) {
    const error = new Error('Labelary label width and height must be between 0 and 15 inches.');

    error.code = 'LABELARY_LABEL_SIZE_INVALID';

    throw error;
  }

  return {
    apiBase,
    dpmm,
    widthInches,
    heightInches,
    timeoutMs,
    maxZplBytes,
    maxPdfBytes,
  };
}

function isPdfBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 5) {
    return false;
  }

  return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
}

async function renderCourierGuyZplToPdf(zpl) {
  const source = String(zpl || '');

  if (!source.trim()) {
    const error = new Error('Courier Guy ZPL is required before a PDF can be generated.');

    error.code = 'COURIER_GUY_ZPL_REQUIRED';

    throw error;
  }

  const config = getLabelaryConfig();

  const zplBuffer = Buffer.from(source, 'utf8');

  if (zplBuffer.length > config.maxZplBytes) {
    const error = new Error(
      `Courier Guy ZPL exceeds the maximum conversion size of ${config.maxZplBytes} bytes.`,
    );

    error.code = 'COURIER_GUY_ZPL_TOO_LARGE';

    throw error;
  }

  /*
   * The label index is intentionally omitted.
   * This lets a multi-parcel ZPL document become a multi-page PDF.
   */
  const endpoint =
    `${config.apiBase}/printers/` +
    `${encodeURIComponent(config.dpmm)}/labels/` +
    `${encodeURIComponent(config.widthInches)}x` +
    `${encodeURIComponent(config.heightInches)}/`;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        Accept: 'application/pdf',
        'Content-Type': 'application/x-www-form-urlencoded',
      },

      body: source,

      signal: controller.signal,
    });

    const responseBuffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const responseMessage = responseBuffer.toString('utf8').trim().slice(0, 1500);

      const error = new Error(
        responseMessage || `The ZPL-to-PDF service returned HTTP ${response.status}.`,
      );

      error.code = 'COURIER_GUY_PDF_RENDER_FAILED';
      error.status = response.status;

      throw error;
    }

    if (responseBuffer.length > config.maxPdfBytes) {
      const error = new Error(
        `Generated Courier Guy PDF exceeds the maximum allowed size of ${config.maxPdfBytes} bytes.`,
      );

      error.code = 'COURIER_GUY_PDF_TOO_LARGE';

      throw error;
    }

    if (!isPdfBuffer(responseBuffer)) {
      const error = new Error('The ZPL-to-PDF service did not return a valid PDF document.');

      error.code = 'COURIER_GUY_PDF_INVALID';

      throw error;
    }

    return responseBuffer;
  } catch (error) {
    if (
      error?.name === 'AbortError' ||
      String(error?.message || '')
        .toLowerCase()
        .includes('aborted')
    ) {
      const timeoutError = new Error('Courier Guy PDF generation timed out.');

      timeoutError.code = 'COURIER_GUY_PDF_TIMEOUT';
      timeoutError.status = 504;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  renderCourierGuyZplToPdf,
};
