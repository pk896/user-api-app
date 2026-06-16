// utils/courierGuy/getCourierGuyRates.js
'use strict';

const {
  courierGuyRequest,
} = require('./courierGuyClient');

const {
  buildCourierGuyAddressFromWarehouse,
} = require('./buildCourierGuyAddressFromWarehouse');

const {
  buildCourierGuyDeliveryAddress,
} = require('./buildCourierGuyDeliveryAddress');

const {
  buildCourierGuyParcelsFromCart,
} = require('./buildCourierGuyParcelsFromCart');

const {
  normalizeCourierGuyRates,
} = require('./normalizeCourierGuyRates');

function tomorrowDateOnly() {
  const date = new Date(
    Date.now() + 24 * 60 * 60 * 1000
  );

  return date.toISOString().slice(0, 10);
}

function cartDeclaredValue(cart) {
  const items = Array.isArray(cart?.items)
    ? cart.items
    : [];

  let total = 0;

  for (const item of items) {
    const quantity = Math.max(
      1,
      Math.floor(
        Number(item?.qty ?? item?.quantity ?? 1)
      )
    );

    const price = Number(
      item?.price ??
        item?.unitPrice ??
        0
    );

    if (Number.isFinite(price) && price >= 0) {
      total += price * quantity;
    }
  }

  return Number(total.toFixed(2));
}

async function getCourierGuyRates({
  cart,
  shippingInput,
  warehouse,
  Product,
}) {
  if (!cart || !Array.isArray(cart.items) || !cart.items.length) {
    const error = new Error(
      'Cart is empty; Courier Guy rates cannot be requested.'
    );

    error.code = 'CART_EMPTY';
    throw error;
  }

  if (!shippingInput) {
    const error = new Error(
      'Shipping address is required for Courier Guy rates.'
    );

    error.code = 'SHIPPING_ADDRESS_INVALID';
    throw error;
  }

  if (!warehouse) {
    const error = new Error(
      'No warehouse is available for this Courier Guy quote.'
    );

    error.code = 'COURIER_GUY_WAREHOUSE_NOT_FOUND';
    throw error;
  }

  const collectionAddress =
    buildCourierGuyAddressFromWarehouse(warehouse);

  const deliveryAddress =
    buildCourierGuyDeliveryAddress(shippingInput);

  const parcels =
    await buildCourierGuyParcelsFromCart(
      cart,
      { Product }
    );

  const requestedDate = tomorrowDateOnly();

  const payload = {
    collection_address: collectionAddress,
    delivery_address: deliveryAddress,
    parcels,
    collection_min_date: requestedDate,
    delivery_min_date: requestedDate,
  };

  const declaredValue = cartDeclaredValue(cart);

  if (declaredValue > 0) {
    payload.declared_value = declaredValue;
  }

  const response = await courierGuyRequest(
    '/rates',
    {
      method: 'POST',
      body: payload,
      timeoutMs: 30000,
    }
  );

  const rates = normalizeCourierGuyRates(
    response.data
  );

  return {
    mode: response.mode,
    baseUrl: response.baseUrl,
    status: response.status,
    payload,
    rates,
    rawResponse: response.data,
  };
}

module.exports = {
  getCourierGuyRates,
};
