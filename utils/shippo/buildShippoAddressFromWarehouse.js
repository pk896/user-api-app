// utils/shippo/buildShippoAddressFromWarehouse.js
'use strict';

function clean(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

function normalizeCountryCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : '';
}

function buildShippoAddressFromWarehouse(warehouse) {
  const w = warehouse || {};
  const address = w.address || {};

  const from = {
    name: clean(w.name || w.code || 'Warehouse', 120),
    street1: clean(address.street1, 300),
    street2: clean(address.street2, 300),
    city: clean(address.city, 120),
    state: clean(address.state || w.province || w.provinceCode, 120),
    zip: clean(address.zip, 60),
    country: normalizeCountryCode(address.country || w.country),
    phone: clean(w.phone, 40),
    email: clean(w.email, 140),
  };

  const missing = [];

  if (!from.name) missing.push('warehouse.name');
  if (!from.street1) missing.push('warehouse.address.street1');
  if (!from.city) missing.push('warehouse.address.city');
  if (!from.state) missing.push('warehouse.address.state');
  if (!from.zip) missing.push('warehouse.address.zip');
  if (!from.country) missing.push('warehouse.address.country');

  if (missing.length) {
    const err = new Error(`Warehouse Shippo FROM address incomplete: ${missing.join(', ')}`);
    err.code = 'WAREHOUSE_FROM_ADDRESS_INCOMPLETE';
    throw err;
  }

  return from;
}

module.exports = { buildShippoAddressFromWarehouse };

