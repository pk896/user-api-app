// utils/courierGuy/buildCourierGuyDeliveryAddress.js
'use strict';

function clean(value, max = 255) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function normalizeCountry(value) {
  const country = clean(value, 2).toUpperCase();

  return /^[A-Z]{2}$/.test(country)
    ? country
    : '';
}

function buildCourierGuyDeliveryAddress(shippingInput) {
  const input = shippingInput || {};
  const address = input.address || {};

  const result = {
    type: 'residential',
    company: '',
    street_address: clean(address.address_line_1, 255),
    local_area: clean(address.address_line_2, 255),
    city: clean(address.admin_area_2, 120),
    zone: clean(address.admin_area_1, 120),
    country: normalizeCountry(address.country_code),
    code: clean(address.postal_code, 40),
  };

  const missing = [];

  if (!result.street_address) {
    missing.push('shipping.address.address_line_1');
  }

  if (!result.city) {
    missing.push('shipping.address.admin_area_2');
  }

  if (!result.zone) {
    missing.push('shipping.address.admin_area_1');
  }

  if (!result.country) {
    missing.push('shipping.address.country_code');
  }

  if (!result.code) {
    missing.push('shipping.address.postal_code');
  }

  if (missing.length) {
    const error = new Error(
      `Delivery address is missing Courier Guy fields: ${missing.join(', ')}`
    );

    error.code = 'COURIER_GUY_DELIVERY_ADDRESS_INCOMPLETE';
    error.missing = missing;

    throw error;
  }

  return result;
}

function buildCourierGuyDeliveryContact(shippingInput) {
  const input = shippingInput || {};

  const contact = {
    name: clean(input.fullName, 255),
    mobile_number: clean(input.phone, 80),
    email: clean(input.email, 255),
  };

  const missing = [];

  if (!contact.name) {
    missing.push('shipping.fullName');
  }

  if (!contact.mobile_number && !contact.email) {
    missing.push('shipping.phone or shipping.email');
  }

  if (missing.length) {
    const error = new Error(
      `Delivery contact is missing Courier Guy fields: ${missing.join(', ')}`
    );

    error.code = 'COURIER_GUY_DELIVERY_CONTACT_INCOMPLETE';
    error.missing = missing;

    throw error;
  }

  return contact;
}

module.exports = {
  buildCourierGuyDeliveryAddress,
  buildCourierGuyDeliveryContact,
};
