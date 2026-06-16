// utils/courierGuy/createCourierGuyShipment.js
'use strict';

const { courierGuyRequest } = require('./courierGuyClient');

const { buildCourierGuyShipmentPayload } = require('./buildCourierGuyShipmentPayload');

const { normalizeCourierGuyShipment } = require('./normalizeCourierGuyShipment');

const { getCourierGuyDocuments } = require('./getCourierGuyDocuments');

async function createCourierGuyShipment(order) {
  if (!order) {
    const error = new Error('Order is required.');
    error.code = 'COURIER_GUY_ORDER_REQUIRED';
    throw error;
  }

  if (order?.courierGuy?.shipmentId) {
    return {
      reused: true,
      shipment: normalizeCourierGuyShipment(
        order?.courierGuy?.createResponse || {
          id: order.courierGuy.shipmentId,
          tracking_reference: order.courierGuy.trackingReference,
          waybill_number: order.courierGuy.waybillNumber,
          status: order.courierGuy.shipmentStatus,
        },
      ),
      payload: null,
    };
  }

  const built = await buildCourierGuyShipmentPayload(order);

  console.log('[Courier Guy shipment request]', {
    orderId: order.orderId,
    shippingProvider: order.shippingProvider,

    serviceLevelCode: built.payload.service_level_code || '',

    serviceLevelId: built.payload.service_level_id || '',

    customerReference: built.payload.customer_reference || '',

    collectionMinDate: built.payload.collection_min_date || '',

    deliveryMinDate: built.payload.delivery_min_date || '',

    parcelCount: Array.isArray(built.payload.parcels) ? built.payload.parcels.length : 0,

    collectionCountry: built.payload.collection_address?.country || '',

    deliveryCountry: built.payload.delivery_address?.country || '',

    hasCollectionContact: Boolean(built.payload.collection_contact),

    hasDeliveryContact: Boolean(built.payload.delivery_contact),

    declaredValue: built.payload.declared_value ?? null,
  });

  const response = await courierGuyRequest('/shipments', {
    method: 'POST',
    body: built.payload,
    timeoutMs: 45000,
  });

  const shipment = normalizeCourierGuyShipment(response.data);

  if (!shipment.shipmentId) {
    const error = new Error(
      'Shiplogic created a response but did not return a recognizable shipment ID.',
    );

    error.code = 'COURIER_GUY_SHIPMENT_ID_MISSING';

    error.shiplogic = response.data;

    throw error;
  }

  // Document generation is separate from shipment creation.
  // A document failure must not mark the successfully-created
  // shipment as failed.
  let documents = {
    waybillUrl: '',
    stickerUrl: '',
    waybillResponse: null,
    stickerResponse: null,
    errors: [],
  };

  try {
    documents = await getCourierGuyDocuments(shipment.shipmentId);
  } catch (documentError) {
    console.warn('[Courier Guy documents unavailable after creation]', {
      shipmentId: shipment.shipmentId,

      message: documentError?.message || String(documentError),
    });
  }

  shipment.waybillUrl = documents.waybillUrl || shipment.waybillUrl || '';

  shipment.stickerUrl = documents.stickerUrl || shipment.stickerUrl || '';

  return {
    reused: false,
    shipment,
    payload: built.payload,
    warehouse: built.warehouse,
    collectionAddress: built.collectionAddress,
    deliveryAddress: built.deliveryAddress,
    parcels: built.parcels,
    response: response.data,
    documents,
  };
}

module.exports = {
  createCourierGuyShipment,
};
