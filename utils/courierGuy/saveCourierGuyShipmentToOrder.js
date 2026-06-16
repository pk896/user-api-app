// utils/courierGuy/saveCourierGuyShipmentToOrder.js
'use strict';

function mapTrackingStatus(status) {
  const value = String(status || '').toUpperCase();

  if (value === 'DELIVERED') return 'DELIVERED';
  if (value === 'CANCELLED') return 'CANCELLED';
  if (value === 'IN_TRANSIT' || value === 'OUT_FOR_DELIVERY') return 'IN_TRANSIT';
  if (value === 'SHIPPED') return 'SHIPPED';
  return 'PROCESSING';
}

function mapFulfillmentStatus(status) {
  const value = String(status || '').toUpperCase();

  if (value === 'DELIVERED') return 'DELIVERED';
  if (value === 'CANCELLED') return 'CANCELLED';
  if (['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'SHIPPED'].includes(value)) return 'SHIPPED';
  return 'LABEL_CREATED';
}

async function saveCourierGuyShipmentToOrder(order, result) {
  const shipment = result?.shipment || result;

  order.courierGuy = order.courierGuy || {};
  order.shippingTracking = order.shippingTracking || {};

  order.courierGuy.shipmentId = shipment.shipmentId || order.courierGuy.shipmentId;
  order.courierGuy.trackingReference =
    shipment.trackingReference || order.courierGuy.trackingReference || '';
  order.courierGuy.shortTrackingReference =
    shipment.shortTrackingReference || order.courierGuy.shortTrackingReference || '';
  order.courierGuy.waybillNumber = shipment.waybillNumber || order.courierGuy.waybillNumber || '';
  order.courierGuy.waybillUrl = shipment.waybillUrl || order.courierGuy.waybillUrl || '';
  order.courierGuy.labelUrl = shipment.labelUrl || order.courierGuy.labelUrl || '';
  order.courierGuy.stickerUrl = shipment.stickerUrl || order.courierGuy.stickerUrl || '';
  order.courierGuy.trackingUrl = shipment.trackingUrl || order.courierGuy.trackingUrl || '';
  order.courierGuy.shipmentStatus = shipment.status || '';
  order.courierGuy.trackingStatus = shipment.status || '';
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

  // Shipment-creation response:
  // Save only when this call actually created the shipment.
  if (result?.response) {
    order.courierGuy.createResponse = result.response;
  }

  // Tracking response:
  // Save separately so refreshing tracking never destroys
  // the original shipment-creation response.
  if (result?.trackingResponse) {
    order.courierGuy.trackingResponse = result.trackingResponse;
  }

  if (result?.documents) {
    if (result.documents.waybillUrl) {
      order.courierGuy.waybillUrl = result.documents.waybillUrl;
    }

    if (result.documents.stickerUrl) {
      order.courierGuy.stickerUrl = result.documents.stickerUrl;
    }
  }

  const trackingNumber =
    shipment.trackingReference ||
    shipment.waybillNumber ||
    shipment.shortTrackingReference ||
    shipment.shipmentId;

  order.shippingTracking.carrier = 'OTHER';
  order.shippingTracking.carrierLabel = 'The Courier Guy';
  order.shippingTracking.carrierToken = '';
  order.shippingTracking.trackingNumber = trackingNumber || '';
  order.shippingTracking.trackingUrl = shipment.trackingUrl || '';
  order.shippingTracking.labelUrl =
    shipment.labelUrl || shipment.waybillUrl || shipment.stickerUrl || '';
  order.shippingTracking.liveStatus = mapTrackingStatus(shipment.status);
  order.shippingTracking.status = mapTrackingStatus(shipment.status);
  order.shippingTracking.liveEvents = Array.isArray(shipment.events) ? shipment.events : [];
  order.shippingTracking.lastTrackingUpdate = new Date(shipment.lastUpdate || Date.now());
  order.shippingTracking.lastUpdate = new Date();

  if (shipment.estimatedDelivery) {
    const eta = new Date(shipment.estimatedDelivery);
    if (!Number.isNaN(eta.getTime())) {
      order.shippingTracking.estimatedDelivery = eta;
    }
  }

  order.fulfillmentStatus = mapFulfillmentStatus(shipment.status);

  await order.save();
  return order;
}

module.exports = {
  saveCourierGuyShipmentToOrder,
};
