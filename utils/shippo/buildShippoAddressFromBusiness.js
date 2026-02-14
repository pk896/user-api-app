// utils/shippo/buildShippoAddressFromBusiness
'use strict';

function buildShippoAddressFromBusiness(biz) {
  const b = biz?.toObject ? biz.toObject() : (biz || {});

  const country = String(b.countryCode || b.country || '').trim().toUpperCase();
  const street1 = String(b.addressLine1 || '').trim();
  const street2 = String(b.addressLine2 || '').trim();
  const city = String(b.city || '').trim();
  const state = String(b.state || '').trim();
  const zip = String(b.postalCode || '').trim();
  const phone = String(b.phone || '').trim();

  const missing = [];
  if (!country) missing.push('countryCode');
  if (!street1) missing.push('addressLine1');
  if (!city) missing.push('city');
  if (!zip) missing.push('postalCode');
  if (!phone) missing.push('phone');

  if (country === 'US' && !state) missing.push('state');

  if (missing.length) {
    const err = new Error(`Business address incomplete for shipping: missing ${missing.join(', ')}`);
    err.code = 'ADDRESS_INCOMPLETE';
    throw err;
  }

  return {
    name: String(b.name || '').trim() || 'Business',
    street1,
    street2,
    city,
    state: state || undefined,
    zip,
    country,   // ✅ ISO2
    phone,
    email: String(b.email || '').trim() || undefined,
  };
}

module.exports = { buildShippoAddressFromBusiness };
