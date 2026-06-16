// utils/courierGuy/getCourierGuyShipment.js
'use strict';

const {
  courierGuyRequest,
} = require('./courierGuyClient');

const {
  normalizeCourierGuyShipment,
} = require('./normalizeCourierGuyShipment');

async function getCourierGuyShipment(shipmentId) {
  const id = String(shipmentId || '').trim();

  if (!id) {
    const error = new Error(
      'Courier Guy shipmentId is required.'
    );

    error.code =
      'COURIER_GUY_SHIPMENT_ID_MISSING';

    throw error;
  }

  const query = new URLSearchParams({
    include_parcels: 'false',
    id,
  });

  const response = await courierGuyRequest(
    `/tracking/shipments?${query.toString()}`,
    {
      method: 'GET',
      timeoutMs: 30000,
    }
  );

  return normalizeCourierGuyShipment(
    response.data
  );
}

module.exports = {
  getCourierGuyShipment,
};
