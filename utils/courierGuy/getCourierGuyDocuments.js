// utils/courierGuy/getCourierGuyDocuments.js
'use strict';

const { courierGuyRequest } = require('./courierGuyClient');

function clean(value, max = 1000000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
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

  if (data && typeof data === 'object') {
    return [data];
  }

  return [];
}

function normalizeStickerParcels(data) {
  const shipments = extractShipments(data);
  const parcels = [];

  for (const shipment of shipments) {
    const parcelWaybills = Array.isArray(shipment?.parcel_waybills) ? shipment.parcel_waybills : [];

    for (const parcel of parcelWaybills) {
      const content = clean(parcel?.sticker_waybill_content || parcel?.stickerWaybillContent || '');

      if (!content) {
        continue;
      }

      parcels.push({
        parcelReference: clean(parcel?.parcel_reference || parcel?.parcelReference || '', 200),

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

async function getCourierGuyDocuments(shipmentId) {
  const id = String(shipmentId || '').trim();

  if (!id) {
    const error = new Error('Courier Guy shipmentId is required.');

    error.code = 'COURIER_GUY_SHIPMENT_ID_MISSING';

    throw error;
  }

  const query = new URLSearchParams({
    format: 'zpl',
    id,
  });

  try {
    const response = await courierGuyRequest(`/shipments/label/stickers?${query.toString()}`, {
      method: 'GET',
      timeoutMs: 45000,
    });

    const stickerParcels = normalizeStickerParcels(response.data);

    const stickerZpl = combineStickerZpl(stickerParcels);

    if (!stickerZpl) {
      return {
        format: 'zpl',

        stickerParcels: [],
        stickerZpl: '',

        // The supplied documentation confirms ZPL stickers,
        // but does not provide a separate PDF waybill endpoint.
        waybillUrl: '',
        stickerUrl: '',

        waybillResponse: null,
        stickerResponse: response.data,

        errors: [
          {
            type: 'sticker',
            message: 'The Courier Guy returned no sticker_waybill_content for this shipment.',
          },
        ],
      };
    }

    return {
      format: 'zpl',

      stickerParcels,
      stickerZpl,

      waybillUrl: '',
      stickerUrl: '',

      waybillResponse: null,
      stickerResponse: response.data,

      errors: [],
    };
  } catch (error) {
    console.warn('[Courier Guy sticker retrieval failed]', {
      shipmentId: id,
      code: error?.code || '',
      status: error?.status || null,
      message: error?.message || String(error),
    });

    return {
      format: 'zpl',

      stickerParcels: [],
      stickerZpl: '',

      waybillUrl: '',
      stickerUrl: '',

      waybillResponse: null,
      stickerResponse: error?.shiplogic || null,

      errors: [
        {
          type: 'sticker',
          message: String(error?.message || 'Courier Guy sticker retrieval failed.').slice(0, 1000),
        },
      ],
    };
  }
}

module.exports = {
  getCourierGuyDocuments,
  normalizeStickerParcels,
  combineStickerZpl,
};
