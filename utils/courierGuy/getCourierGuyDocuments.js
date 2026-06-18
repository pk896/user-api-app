// utils/courierGuy/getCourierGuyDocuments.js
'use strict';

const { courierGuyRequest } = require('./courierGuyClient');

function clean(value, max = 1000000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function extractShipments(data) {
  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data?.shipments)) {
    return data.shipments;
  }

  if (Array.isArray(data?.data)) {
    return data.data;
  }

  if (Array.isArray(data?.results)) {
    return data.results;
  }

  if (data?.shipment && typeof data.shipment === 'object') {
    return [data.shipment];
  }

  if (data?.data?.shipment && typeof data.data.shipment === 'object') {
    return [data.data.shipment];
  }

  if (data && typeof data === 'object') {
    return [data];
  }

  return [];
}

function extractParcelWaybills(shipment) {
  const source = shipment || {};

  const candidates = [
    source.parcel_waybills,
    source.parcelWaybills,
    source.parcels,
    source.shipment?.parcel_waybills,
    source.shipment?.parcelWaybills,
    source.data?.parcel_waybills,
    source.data?.parcelWaybills,
  ];

  return candidates.find(Array.isArray) || [];
}

function normalizeStickerParcels(data) {
  const shipments = extractShipments(data);
  const parcels = [];

  for (const shipment of shipments) {
    const parcelWaybills = extractParcelWaybills(shipment);

    for (const parcel of parcelWaybills) {
      const parcelReference = clean(
        parcel?.parcel_reference ||
          parcel?.parcelReference ||
          parcel?.waybill_number ||
          parcel?.waybillNumber ||
          '',
        200,
      );

      const content = clean(
        parcel?.sticker_waybill_content ||
          parcel?.stickerWaybillContent ||
          parcel?.zpl ||
          '',
      );

      if (!parcelReference && !content) {
        continue;
      }

      parcels.push({
        parcelReference,
        content,
      });
    }
  }

  return parcels;
}

function combineStickerZpl(stickerParcels) {
  const parcels = Array.isArray(stickerParcels) ? stickerParcels : [];

  return parcels
    .map((parcel) => clean(parcel?.content))
    .filter(Boolean)
    .join('\n\n');
}

function uniqueStickerParcels(parcels) {
  const source = Array.isArray(parcels) ? parcels : [];
  const unique = [];
  const seen = new Set();

  for (const parcel of source) {
    const parcelReference = clean(parcel?.parcelReference, 200);
    const content = clean(parcel?.content);

    const key = parcelReference || content.slice(0, 250);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);

    unique.push({
      parcelReference,
      content,
    });
  }

  return unique;
}

async function requestStickerPage({
  shipmentId,
  trackingReference,
  limit,
  offset,
}) {
  const query = new URLSearchParams({
    format: 'zpl',
    limit: String(limit),
    offset: String(offset),
  });

  if (shipmentId) {
    query.set('id', shipmentId);
  } else {
    query.set('tracking_reference', trackingReference);
  }

  return courierGuyRequest(
    `/shipments/label/stickers?${query.toString()}`,
    {
      method: 'GET',
      timeoutMs: 45000,
    },
  );
}

async function retrieveAllStickerParcels({
  shipmentId,
  trackingReference,
}) {
  const limit = 20;
  const maximumPages = 10;

  const allParcels = [];
  const rawResponses = [];

  for (let page = 0; page < maximumPages; page += 1) {
    const offset = page * limit;

    const response = await requestStickerPage({
      shipmentId,
      trackingReference,
      limit,
      offset,
    });

    rawResponses.push(response.data);

    const pageParcels = normalizeStickerParcels(response.data);

    if (!pageParcels.length) {
      break;
    }

    allParcels.push(...pageParcels);

    /*
     * A page containing fewer than the requested limit normally means
     * that there are no more parcel stickers to retrieve.
     */
    if (pageParcels.length < limit) {
      break;
    }
  }

  return {
    stickerParcels: uniqueStickerParcels(allParcels),
    rawResponses,
  };
}

async function getCourierGuyDocuments(
  shipmentId,
  {
    trackingReference = '',
    retryDelaysMs = [0, 1500, 3000, 5000],
  } = {},
) {
  const id = clean(shipmentId, 200);
  const tracking = clean(trackingReference, 200);

  if (!id && !tracking) {
    const error = new Error(
      'Courier Guy shipmentId or trackingReference is required.',
    );

    error.code = 'COURIER_GUY_SHIPMENT_ID_MISSING';

    throw error;
  }

  const delays = Array.isArray(retryDelaysMs) && retryDelaysMs.length
    ? retryDelaysMs
    : [0];

  let lastError = null;
  let lastRawResponse = null;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = Number(delays[attempt]);

    if (Number.isFinite(delay) && delay > 0) {
      await sleep(delay);
    }

    try {
      const result = await retrieveAllStickerParcels({
        shipmentId: id,
        trackingReference: tracking,
      });

      lastRawResponse = result.rawResponses;

      const stickerParcels = result.stickerParcels;

      const stickerZpl = combineStickerZpl(stickerParcels);

      const primaryWaybillNumber = clean(
        stickerParcels.find((parcel) => parcel?.parcelReference)
          ?.parcelReference || '',
        200,
      );

      if (stickerZpl) {
        return {
          format: 'zpl',

          stickerParcels,
          stickerZpl,

          primaryWaybillNumber,

          waybillUrl: '',
          stickerUrl: '',

          waybillResponse: null,
          stickerResponse: lastRawResponse,

          errors: [],
        };
      }

      lastError = new Error(
        'The Courier Guy returned no sticker_waybill_content yet.',
      );

      lastError.code = 'COURIER_GUY_STICKER_NOT_READY';
    } catch (error) {
      lastError = error;

      lastRawResponse = error?.shiplogic || lastRawResponse;

      console.warn('[Courier Guy sticker retrieval attempt failed]', {
        shipmentId: id,
        trackingReference: tracking,
        attempt: attempt + 1,
        totalAttempts: delays.length,
        code: error?.code || '',
        status: error?.status || null,
        message: error?.message || String(error),
      });
    }
  }

  const message = String(
    lastError?.message ||
      'The Courier Guy sticker is not available yet.',
  ).slice(0, 1000);

  return {
    format: 'zpl',

    stickerParcels: [],
    stickerZpl: '',

    primaryWaybillNumber: '',

    waybillUrl: '',
    stickerUrl: '',

    waybillResponse: null,
    stickerResponse: lastRawResponse,

    errors: [
      {
        type: 'sticker',
        message,
      },
    ],
  };
}

module.exports = {
  getCourierGuyDocuments,
  normalizeStickerParcels,
  combineStickerZpl,
};