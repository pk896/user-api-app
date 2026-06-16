// utils/courierGuy/getCourierGuyDocuments.js
'use strict';

const { fetch } = require('undici');

const {
  requireCourierGuyConfig,
} = require('./courierGuyConfig');

function clean(value, max = 3000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function findSignedUrl(data) {
  if (typeof data === 'string') {
    const value = clean(data);

    return /^https?:\/\//i.test(value)
      ? value
      : '';
  }

  const candidates = [
    data?.url,
    data?.signed_url,
    data?.signedUrl,
    data?.download_url,
    data?.downloadUrl,
    data?.data?.url,
    data?.data?.signed_url,
    data?.data?.signedUrl,
  ];

  for (const candidate of candidates) {
    const value = clean(candidate);

    if (/^https?:\/\//i.test(value)) {
      return value;
    }
  }

  return '';
}

async function requestDocument(
  documentType,
  shipmentId
) {
  const config = requireCourierGuyConfig();

  const type = String(documentType || '')
    .trim()
    .toLowerCase();

  if (!['waybill', 'sticker'].includes(type)) {
    const error = new Error(
      'Unsupported Courier Guy document type.'
    );

    error.code =
      'COURIER_GUY_DOCUMENT_TYPE_INVALID';

    throw error;
  }

  const id = String(shipmentId || '').trim();

  if (!id) {
    const error = new Error(
      'Courier Guy shipmentId is required.'
    );

    error.code =
      'COURIER_GUY_SHIPMENT_ID_MISSING';

    throw error;
  }

  const url = new URL(
    `${config.baseUrl}/generate/${type}/${encodeURIComponent(id)}`
  );

  // This key is used server-side only.
  // The generated signed PDF URL is what gets saved.
  url.searchParams.set(
    'api_key',
    config.apiKey
  );

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, config.timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',

      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: 'application/json',
      },

      signal: controller.signal,
    });

    const responseText = await response
      .text()
      .catch(() => '');

    let data = {};

    try {
      data = responseText
        ? JSON.parse(responseText)
        : {};
    } catch {
      data = responseText;
    }

    if (!response.ok) {
      const message =
        typeof data === 'string'
          ? data
          : data?.message ||
            data?.detail ||
            data?.error ||
            `Shiplogic ${type} request returned HTTP ${response.status}.`;

      const error = new Error(
        String(message || '').slice(0, 1000)
      );

      error.code =
        'COURIER_GUY_DOCUMENT_FAILED';

      error.status = response.status;
      error.documentType = type;
      error.shiplogic = data;

      throw error;
    }

    const signedUrl = findSignedUrl(data);

    if (!signedUrl) {
      const error = new Error(
        `Shiplogic did not return a signed ${type} URL.`
      );

      error.code =
        'COURIER_GUY_DOCUMENT_URL_MISSING';

      error.documentType = type;
      error.shiplogic = data;

      throw error;
    }

    return {
      url: signedUrl,
      raw: data,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getCourierGuyDocuments(
  shipmentId
) {
  const results = await Promise.allSettled([
    requestDocument('waybill', shipmentId),
    requestDocument('sticker', shipmentId),
  ]);

  const waybillResult = results[0];
  const stickerResult = results[1];

  return {
    waybillUrl:
      waybillResult.status === 'fulfilled'
        ? waybillResult.value.url
        : '',

    stickerUrl:
      stickerResult.status === 'fulfilled'
        ? stickerResult.value.url
        : '',

    waybillResponse:
      waybillResult.status === 'fulfilled'
        ? waybillResult.value.raw
        : null,

    stickerResponse:
      stickerResult.status === 'fulfilled'
        ? stickerResult.value.raw
        : null,

    errors: [
      waybillResult.status === 'rejected'
        ? {
            type: 'waybill',
            message:
              waybillResult.reason?.message ||
              String(waybillResult.reason),
          }
        : null,

      stickerResult.status === 'rejected'
        ? {
            type: 'sticker',
            message:
              stickerResult.reason?.message ||
              String(stickerResult.reason),
          }
        : null,
    ].filter(Boolean),
  };
}

module.exports = {
  getCourierGuyDocuments,
};