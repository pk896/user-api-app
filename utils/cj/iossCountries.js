// utils/cj/iossCountries.js
'use strict';

/*
 * EU countries where CJ logistics may require an IOSS number
 * for B2C imported-goods shipments.
 *
 * Keep this separate from general countries.js because this is
 * a CJ logistics/tax rule, not a normal country-list rule.
 */
const CJ_IOSS_REQUIRED_COUNTRY_CODES = new Set([
  'AT', // Austria
  'BE', // Belgium
  'BG', // Bulgaria
  'HR', // Croatia
  'CY', // Cyprus
  'CZ', // Czechia
  'DK', // Denmark
  'EE', // Estonia
  'FI', // Finland
  'FR', // France
  'DE', // Germany
  'GR', // Greece
  'HU', // Hungary
  'IE', // Ireland
  'IT', // Italy
  'LV', // Latvia
  'LT', // Lithuania
  'LU', // Luxembourg
  'MT', // Malta
  'NL', // Netherlands
  'PL', // Poland
  'PT', // Portugal
  'RO', // Romania
  'SK', // Slovakia
  'SI', // Slovenia
  'ES', // Spain
  'SE', // Sweden
]);

function normalizeCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();

  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function requiresCjIossNumber(countryCode) {
  const code = normalizeCountryCode(countryCode);

  return CJ_IOSS_REQUIRED_COUNTRY_CODES.has(code);
}

function normalizeCjIossNumber(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 50);
}

function getConfiguredCjIossNumber() {
  return normalizeCjIossNumber(process.env.KASYORA_IOSS_NUMBER);
}

module.exports = {
  CJ_IOSS_REQUIRED_COUNTRY_CODES,
  requiresCjIossNumber,
  normalizeCjIossNumber,
  getConfiguredCjIossNumber,
};