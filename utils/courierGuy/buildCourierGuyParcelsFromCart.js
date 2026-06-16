// utils/courierGuy/buildCourierGuyParcelsFromCart.js
'use strict';

const {
  loadProductsForCart,
  validateCartProductsShippingOrThrow,
  buildCalculatedParcelFromProducts,
} = require('../payment/buildShippoParcelsFromCart');

function toCourierGuyParcel(shippoStyleParcel, index) {
  const source = shippoStyleParcel || {};

  const length = Number(source.length);
  const width = Number(source.width);
  const height = Number(source.height);
  const weight = Number(source.weight);

  const values = {
    length,
    width,
    height,
    weight,
  };

  for (const [field, value] of Object.entries(values)) {
    if (!Number.isFinite(value) || value <= 0) {
      const error = new Error(
        `Courier Guy parcel #${index + 1} has an invalid ${field}.`
      );

      error.code = 'COURIER_GUY_PARCEL_INVALID';
      error.parcelIndex = index;
      error.field = field;

      throw error;
    }
  }

  return {
    parcel_description:
      index === 0
        ? 'Order parcel'
        : `Order parcel ${index + 1}`,

    submitted_length_cm: Number(length.toFixed(1)),
    submitted_width_cm: Number(width.toFixed(1)),
    submitted_height_cm: Number(height.toFixed(1)),
    submitted_weight_kg: Number(weight.toFixed(3)),
  };
}

async function buildCourierGuyParcelsFromCart(
  cart,
  { Product } = {}
) {
  if (!Product) {
    const error = new Error(
      'Product model not available for Courier Guy parcel calculation.'
    );

    error.code = 'NO_PRODUCT_MODEL';
    throw error;
  }

  const pairs = await loadProductsForCart(cart, {
    Product,
  });

  validateCartProductsShippingOrThrow(pairs);

  if (!pairs.length) {
    const error = new Error(
      'Cart is empty; Courier Guy parcels cannot be created.'
    );

    error.code = 'CART_EMPTY';
    throw error;
  }

  const fragileRows = pairs.filter(
    (row) => Boolean(row?.product?.shipping?.fragile)
  );

  const normalRows = pairs.filter(
    (row) => !row?.product?.shipping?.fragile
  );

  const calculatedParcels = [];

  if (fragileRows.length) {
    calculatedParcels.push(
      buildCalculatedParcelFromProducts(fragileRows)
    );
  }

  if (normalRows.length) {
    calculatedParcels.push(
      buildCalculatedParcelFromProducts(normalRows)
    );
  }

  if (!calculatedParcels.length) {
    calculatedParcels.push(
      buildCalculatedParcelFromProducts(pairs)
    );
  }

  return calculatedParcels.map(
    toCourierGuyParcel
  );
}

module.exports = {
  buildCourierGuyParcelsFromCart,
};
