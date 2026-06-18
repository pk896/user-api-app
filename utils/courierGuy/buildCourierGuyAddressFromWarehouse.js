// utils/courierGuy/buildCourierGuyAddressFromWarehouse.js
'use strict';

function clean(value, max = 255) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function normalizeCountry(value) {
  const country = clean(value, 2).toUpperCase();

  return /^[A-Z]{2}$/.test(country) ? country : '';
}

function buildCourierGuyAddressFromWarehouse(warehouse) {
  if (!warehouse) {
    const error = new Error('Warehouse is required to build The Courier Guy collection address.');

    error.code = 'COURIER_GUY_WAREHOUSE_REQUIRED';
    throw error;
  }

  const address = warehouse.address || {};

  const result = {
    type: 'business',
    company: clean(warehouse.name || 'Kasyora', 255),
    street_address: clean(address.street1, 255),
    local_area: clean(address.street2, 255),
    city: clean(address.city, 120),
    zone: clean(warehouse.province || address.state || warehouse.provinceCode, 120),
    country: normalizeCountry(address.country || warehouse.country),
    code: clean(address.zip, 40),
  };

  const missing = [];

  if (!result.company) {
    missing.push('warehouse.name');
  }

  if (!result.street_address) {
    missing.push('warehouse.address.street1');
  }

  if (!result.local_area) {
    missing.push('warehouse.address.street2/suburb');
  }

  if (!result.city) {
    missing.push('warehouse.address.city');
  }

  if (!result.zone) {
    missing.push('warehouse.address.state/province');
  }

  if (!result.country) {
    missing.push('warehouse.address.country');
  }

  if (!result.code) {
    missing.push('warehouse.address.zip');
  }

  if (missing.length) {
    const error = new Error(
      `Warehouse is missing Courier Guy address fields: ${missing.join(', ')}`,
    );

    error.code = 'COURIER_GUY_WAREHOUSE_ADDRESS_INCOMPLETE';
    error.missing = missing;

    throw error;
  }

  return result;
}

function buildCourierGuyContactFromWarehouse(warehouse) {
  if (!warehouse) {
    const error = new Error('Warehouse is required to build The Courier Guy collection contact.');

    error.code = 'COURIER_GUY_WAREHOUSE_REQUIRED';
    throw error;
  }

  const contact = {
    name: clean(
      process.env.COURIER_GUY_COLLECTION_CONTACT_NAME || warehouse.name || 'Kasyora',
      255,
    ),

    mobile_number: clean(warehouse.phone || process.env.COURIER_GUY_COLLECTION_PHONE || '', 80),

    email: clean(warehouse.email || process.env.COURIER_GUY_COLLECTION_EMAIL || '', 255),
  };

  if (!contact.mobile_number) {
    const error = new Error('Courier Guy collection contact requires a warehouse phone number.');

    error.code = 'COURIER_GUY_COLLECTION_CONTACT_INCOMPLETE';
    error.missing = ['warehouse.phone or COURIER_GUY_COLLECTION_PHONE'];

    throw error;
  }

  return contact;
}

module.exports = {
  buildCourierGuyAddressFromWarehouse,
  buildCourierGuyContactFromWarehouse,
};
