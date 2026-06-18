// utils/courierGuy/saveCourierGuyShipmentToOrder.js
'use strict';

function mapTrackingStatus(status) {
  const value = String(status || '')
    .trim()
    .toUpperCase();

  if (value === 'DELIVERED') {
    return 'DELIVERED';
  }

  if (value === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (value === 'IN_TRANSIT' || value === 'OUT_FOR_DELIVERY') {
    return 'IN_TRANSIT';
  }

  if (value === 'SHIPPED') {
    return 'SHIPPED';
  }

  return 'PROCESSING';
}

function mapFulfillmentStatus(status) {
  const value = String(status || '')
    .trim()
    .toUpperCase();

  if (value === 'DELIVERED') {
    return 'DELIVERED';
  }

  if (value === 'CANCELLED') {
    return 'CANCELLED';
  }

  if (['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'SHIPPED'].includes(value)) {
    return 'SHIPPED';
  }

  return 'LABEL_CREATED';
}

function firstDocumentError(documents) {
  const errors = Array.isArray(documents?.errors) ? documents.errors : [];

  return errors
    .map((item) => {
      const type = String(item?.type || 'document').trim();

      const message = String(item?.message || '').trim();

      return message ? `${type}: ${message}` : '';
    })
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1000);
}

async function saveCourierGuyShipmentToOrder(order, result) {
  if (!order) {
    const error = new Error('Order is required when saving a Courier Guy shipment.');

    error.code = 'COURIER_GUY_ORDER_REQUIRED';

    throw error;
  }

  const shipment = result?.shipment || result || {};

  order.courierGuy = order.courierGuy || {};

  order.shippingTracking = order.shippingTracking || {};

  order.courierGuy.shipmentId = shipment.shipmentId || order.courierGuy.shipmentId || '';

  order.courierGuy.trackingReference =
    shipment.trackingReference || order.courierGuy.trackingReference || '';

  order.courierGuy.shortTrackingReference =
    shipment.shortTrackingReference || order.courierGuy.shortTrackingReference || '';

  order.courierGuy.waybillNumber = shipment.waybillNumber || order.courierGuy.waybillNumber || '';

  order.courierGuy.waybillUrl = shipment.waybillUrl || order.courierGuy.waybillUrl || '';

  order.courierGuy.labelUrl = shipment.labelUrl || order.courierGuy.labelUrl || '';

  order.courierGuy.stickerUrl = shipment.stickerUrl || order.courierGuy.stickerUrl || '';

  order.courierGuy.trackingUrl = shipment.trackingUrl || order.courierGuy.trackingUrl || '';

  order.courierGuy.shipmentStatus = shipment.status || order.courierGuy.shipmentStatus || '';

  order.courierGuy.trackingStatus = shipment.status || order.courierGuy.trackingStatus || '';

  order.courierGuy.lastTrackingSyncAt = new Date();

  order.courierGuy.autoCreateStatus = 'SUCCESS';

  order.courierGuy.autoCreateLastSuccessAt = new Date();

  order.courierGuy.autoCreateLastError = '';

  if (result?.collectionAddress) {
    order.courierGuy.collectionAddressSnapshot = result.collectionAddress;
  }

  if (result?.deliveryAddress) {
    order.courierGuy.deliveryAddressSnapshot = result.deliveryAddress;
  }

  if (Array.isArray(result?.parcels)) {
    order.courierGuy.parcelSnapshot = result.parcels;
  }

  // Preserve the original shipment-creation response.
  if (result?.response) {
    order.courierGuy.createResponse = result.response;
  }

  // Tracking refresh must not overwrite createResponse.
  if (result?.trackingResponse) {
    order.courierGuy.trackingResponse = result.trackingResponse;
  }

  if (result?.documents) {
    const documents = result.documents;

    if (documents.waybillUrl) {
      order.courierGuy.waybillUrl = documents.waybillUrl;
    }

    if (documents.stickerUrl) {
      order.courierGuy.stickerUrl = documents.stickerUrl;
    }

    const stickerParcels = Array.isArray(documents.stickerParcels) ? documents.stickerParcels : [];

    const documentWaybillNumber = String(
      documents.primaryWaybillNumber ||
        stickerParcels.find((parcel) => {
          return String(parcel?.parcelReference || '').trim();
        })?.parcelReference ||
        '',
    ).trim();

    if (documentWaybillNumber && !String(order.courierGuy.waybillNumber || '').trim()) {
      order.courierGuy.waybillNumber = documentWaybillNumber;
    }

    const stickerZpl = String(documents.stickerZpl || '');

    if (stickerZpl.trim()) {
      order.courierGuy.stickerFormat = String(documents.format || 'zpl')
        .trim()
        .toLowerCase();

      order.courierGuy.stickerParcels = stickerParcels;

      order.courierGuy.stickerZpl = stickerZpl;

      order.courierGuy.stickerGeneratedAt = new Date();

      order.courierGuy.documentLastError = '';
    } else {
      const documentError = firstDocumentError(documents);

      if (documentError) {
        order.courierGuy.documentLastError = documentError;
      }
    }
  }

  const trackingNumber =
    shipment.trackingReference ||
    shipment.waybillNumber ||
    order.courierGuy.trackingReference ||
    order.courierGuy.waybillNumber ||
    shipment.shortTrackingReference ||
    shipment.shipmentId ||
    order.courierGuy.shipmentId ||
    '';

  order.shippingTracking.carrier = 'OTHER';

  order.shippingTracking.carrierLabel = 'The Courier Guy';

  order.shippingTracking.carrierToken = '';

  order.shippingTracking.trackingNumber = trackingNumber;

  order.shippingTracking.trackingUrl = shipment.trackingUrl || order.courierGuy.trackingUrl || '';

  // Do not put raw ZPL into a URL field.
  order.shippingTracking.labelUrl =
    shipment.labelUrl ||
    shipment.waybillUrl ||
    order.courierGuy.labelUrl ||
    order.courierGuy.waybillUrl ||
    '';

  const trackingStatus = mapTrackingStatus(shipment.status || order.courierGuy.shipmentStatus);

  order.shippingTracking.liveStatus = trackingStatus;

  order.shippingTracking.status = trackingStatus;

  if (Array.isArray(shipment.events)) {
    order.shippingTracking.liveEvents = shipment.events;
  }

  const providerLastUpdate = new Date(shipment.lastUpdate || Date.now());

  order.shippingTracking.lastTrackingUpdate = Number.isNaN(providerLastUpdate.getTime())
    ? new Date()
    : providerLastUpdate;

  order.shippingTracking.lastUpdate = new Date();

  if (shipment.estimatedDelivery) {
    const eta = new Date(shipment.estimatedDelivery);

    if (!Number.isNaN(eta.getTime())) {
      order.shippingTracking.estimatedDelivery = eta;
    }
  }

  order.fulfillmentStatus = mapFulfillmentStatus(
    shipment.status || order.courierGuy.shipmentStatus,
  );

  await order.save();

  return order;
}

module.exports = {
  saveCourierGuyShipmentToOrder,
};
