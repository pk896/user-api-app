// utils/courierGuy/buildCourierGuyShipmentPayload.js
'use strict';

const Warehouse = require('../../models/Warehouse');

const {
  buildCourierGuyAddressFromWarehouse,
  buildCourierGuyContactFromWarehouse,
} = require('./buildCourierGuyAddressFromWarehouse');

const {
  buildCourierGuyDeliveryAddress,
  buildCourierGuyDeliveryContact,
} = require('./buildCourierGuyDeliveryAddress');

function clean(value, max = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function dateTimeIso(value, fallbackDays = 1) {
  const fallbackDate = new Date(Date.now() + fallbackDays * 24 * 60 * 60 * 1000);

  const date = value ? new Date(value) : fallbackDate;

  if (Number.isNaN(date.getTime())) {
    return fallbackDate.toISOString();
  }

  return date.toISOString();
}

function orderShippingInput(order) {
  const shipping = order?.shipping || {};

  return {
    fullName: clean(shipping.name || 'Customer', 255),
    phone: clean(shipping.phone, 80),
    email: clean(shipping.email || order?.payer?.email, 255),
    address: {
      address_line_1: clean(shipping.address_line_1, 255),
      address_line_2: clean(shipping.address_line_2, 255),
      admin_area_2: clean(shipping.admin_area_2, 120),
      admin_area_1: clean(shipping.admin_area_1, 120),
      postal_code: clean(shipping.postal_code, 40),
      country_code: clean(shipping.country_code, 2).toUpperCase(),
    },
  };
}

function declaredValue(order) {
  const value = Number(order?.breakdown?.itemTotal?.value ?? order?.amount?.value ?? 0);
  return Number.isFinite(value) && value > 0 ? Number(value.toFixed(2)) : null;
}

async function buildCourierGuyShipmentPayload(order) {
  if (!order) {
    const error = new Error('Order is required to create a Courier Guy shipment.');
    error.code = 'COURIER_GUY_ORDER_REQUIRED';
    throw error;
  }

  if (String(order.shippingProvider || '').toUpperCase() !== 'COURIER_GUY') {
    const error = new Error('This order did not select The Courier Guy.');
    error.code = 'COURIER_GUY_PROVIDER_MISMATCH';
    throw error;
  }

  const serviceLevelId = clean(
    order?.courierGuy?.serviceLevelId || order?.courierGuy?.chosenRate?.serviceLevelId,
    200,
  );

  const serviceLevelCode = clean(
    order?.courierGuy?.serviceCode || order?.courierGuy?.chosenRate?.serviceCode,
    120,
  );

  if (!serviceLevelId && !serviceLevelCode) {
    const error = new Error('Courier Guy payer-selected service level is missing.');
    error.code = 'COURIER_GUY_SERVICE_LEVEL_MISSING';
    throw error;
  }

  const warehouseId = order?.courierGuy?.warehouseId;
  const warehouse = warehouseId
    ? await Warehouse.findOne({ _id: warehouseId, isActive: true }).lean()
    : null;

  if (!warehouse) {
    const error = new Error('The quoted Courier Guy warehouse was not found or is inactive.');
    error.code = 'COURIER_GUY_WAREHOUSE_NOT_FOUND';
    throw error;
  }

  const shippingInput = orderShippingInput(order);
  const collectionAddress = buildCourierGuyAddressFromWarehouse(warehouse);
  const collectionContact = buildCourierGuyContactFromWarehouse(warehouse);
  const deliveryAddress = buildCourierGuyDeliveryAddress(shippingInput);
  const deliveryContact = buildCourierGuyDeliveryContact(shippingInput);

  const parcels = Array.isArray(order?.courierGuy?.parcelSnapshot)
    ? order.courierGuy.parcelSnapshot
    : [];

  if (!parcels.length) {
    const error = new Error(
      'Courier Guy parcel snapshot is missing. The checkout quote must save its parcels on the order.',
    );
    error.code = 'COURIER_GUY_PARCELS_MISSING';
    throw error;
  }

  const payload = {
    collection_address: collectionAddress,
    collection_contact: collectionContact,
    delivery_address: deliveryAddress,
    delivery_contact: deliveryContact,
    parcels,
    customer_reference: clean(order.orderId || order._id, 120),
    collection_min_date: dateTimeIso(order?.courierGuy?.chosenRate?.collectionDate, 1),

    delivery_min_date: dateTimeIso(order?.courierGuy?.chosenRate?.deliveryDateFrom, 1),
  };

  if (serviceLevelCode) {
    payload.service_level_code = serviceLevelCode;
  } else {
    payload.service_level_id = serviceLevelId;
  }

  const value = declaredValue(order);
  if (value !== null) payload.declared_value = value;

  const instructions = clean(order?.shippingInstructions || '', 500);
  if (instructions) payload.special_instructions = instructions;

  return {
    payload,
    warehouse,
    collectionAddress,
    deliveryAddress,
    parcels,
  };
}

module.exports = {
  buildCourierGuyShipmentPayload,
};
