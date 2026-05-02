// utils/payment/resolveWarehouseForCart.js
'use strict';

const ZA_PROVINCE_ALIASES = new Map([
  ['eastern cape', { name: 'Eastern Cape', code: 'EC' }],
  ['ec', { name: 'Eastern Cape', code: 'EC' }],

  ['free state', { name: 'Free State', code: 'FS' }],
  ['fs', { name: 'Free State', code: 'FS' }],

  ['gauteng', { name: 'Gauteng', code: 'GP' }],
  ['gp', { name: 'Gauteng', code: 'GP' }],

  ['kwazulu-natal', { name: 'KwaZulu-Natal', code: 'KZN' }],
  ['kwazulu natal', { name: 'KwaZulu-Natal', code: 'KZN' }],
  ['kzn', { name: 'KwaZulu-Natal', code: 'KZN' }],

  ['limpopo', { name: 'Limpopo', code: 'LP' }],
  ['lp', { name: 'Limpopo', code: 'LP' }],

  ['mpumalanga', { name: 'Mpumalanga', code: 'MP' }],
  ['mp', { name: 'Mpumalanga', code: 'MP' }],

  ['northern cape', { name: 'Northern Cape', code: 'NC' }],
  ['nc', { name: 'Northern Cape', code: 'NC' }],

  ['north west', { name: 'North West', code: 'NW' }],
  ['nw', { name: 'North West', code: 'NW' }],

  ['western cape', { name: 'Western Cape', code: 'WC' }],
  ['wc', { name: 'Western Cape', code: 'WC' }],
]);

function normalizeCountryCode(v) {
  const s = String(v || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(s) ? s : null;
}

function normalizeProvinceText(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[._]/g, ' ')
    .replace(/\s+/g, ' ');
}

function normalizeSouthAfricaProvince(v) {
  const key = normalizeProvinceText(v);
  return ZA_PROVINCE_ALIASES.get(key) || null;
}

function toRegexExact(value) {
  const escaped = String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}$`, 'i');
}

function publicWarehouseMeta(warehouse) {
  if (!warehouse) return null;

  return {
    id: warehouse._id ? String(warehouse._id) : null,
    code: warehouse.code || null,
    name: warehouse.name || null,
    country: warehouse.country || null,
    province: warehouse.province || null,
    provinceCode: warehouse.provinceCode || null,
  };
}

async function resolveWarehouseForCart(cart, deps = {}) {
  const {
    to,
    Warehouse,
  } = deps;

  if (!Warehouse || typeof Warehouse.findOne !== 'function') {
    return null;
  }

  const toCountry = normalizeCountryCode(to?.country);
  const toStateRaw = String(to?.state || '').trim();

  if (!toCountry) {
    return null;
  }

  // 1) South Africa: choose the warehouse for the customer's province.
  if (toCountry === 'ZA') {
    const province = normalizeSouthAfricaProvince(toStateRaw);

    if (province) {
      const provinceWarehouse = await Warehouse.findOne({
        isActive: true,
        country: 'ZA',
        $or: [
          { provinceCode: province.code },
          { province: toRegexExact(province.name) },
          { supportedProvinces: { $in: [province.name, province.code] } },
        ],
      })
        .sort({ priority: 1, isDefault: -1, updatedAt: -1 })
        .lean();

      if (provinceWarehouse) {
        return provinceWarehouse;
      }
    }

    // 2) South Africa fallback: default ZA warehouse.
    const defaultZaWarehouse = await Warehouse.findOne({
      isActive: true,
      country: 'ZA',
      isDefault: true,
    })
      .sort({ priority: 1, updatedAt: -1 })
      .lean();

    if (defaultZaWarehouse) {
      return defaultZaWarehouse;
    }
  }

  // 3) Any country: country-specific default warehouse.
  const countryDefaultWarehouse = await Warehouse.findOne({
    isActive: true,
    country: toCountry,
    isDefault: true,
  })
    .sort({ priority: 1, updatedAt: -1 })
    .lean();

  if (countryDefaultWarehouse) {
    return countryDefaultWarehouse;
  }

  // 4) Any country: warehouse that supports this destination country.
  const supportedCountryWarehouse = await Warehouse.findOne({
    isActive: true,
    supportedCountries: toCountry,
  })
    .sort({ priority: 1, isDefault: -1, updatedAt: -1 })
    .lean();

  if (supportedCountryWarehouse) {
    return supportedCountryWarehouse;
  }

  // 5) Global fallback: any active default warehouse.
  const globalDefaultWarehouse = await Warehouse.findOne({
    isActive: true,
    isDefault: true,
  })
    .sort({ priority: 1, updatedAt: -1 })
    .lean();

  return globalDefaultWarehouse || null;
}

module.exports = {
  resolveWarehouseForCart,
  normalizeSouthAfricaProvince,
  publicWarehouseMeta,
};
