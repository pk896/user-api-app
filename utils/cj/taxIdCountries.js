// utils/cj/taxIdCountries.js
'use strict';

/*
 * CJ buyer Tax ID rules.
 *
 * This is different from Kasyora's own tax/VAT/IOSS number.
 * These values belong to the recipient/buyer and are required
 * by destination-country customs/logistics rules.
 *
 * Verified so far:
 * - Brazil requires recipient Tax ID for CJ parcels.
 */
const CJ_BUYER_TAX_ID_RULES = {
  BR: {
    countryName: 'Brazil',

    label: 'CPF / CNPJ',

    examples: 'CPF: 000.000.000-00 or CNPJ: 00.000.000/0000-00',

    message:
      'Brazil CJ delivery requires the buyer CPF or CNPJ before payment. Enter CPF with 11 digits or CNPJ with 14 digits.',

    allowedDigitLengths: [11, 14],
  },
};

function normalizeCountryCode(value) {
  const code = String(value || '')
    .trim()
    .toUpperCase();

  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function normalizeBuyerTaxId(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .slice(0, 50);
}

function buyerTaxIdDigits(value) {
  return String(value || '')
    .replace(/\D/g, '')
    .slice(0, 30);
}

function getCjBuyerTaxIdRule(countryCode) {
  const code = normalizeCountryCode(countryCode);

  return CJ_BUYER_TAX_ID_RULES[code] || null;
}

function requiresCjBuyerTaxId(countryCode) {
  return Boolean(getCjBuyerTaxIdRule(countryCode));
}

function validateCjBuyerTaxId(countryCode, taxId) {
  const rule = getCjBuyerTaxIdRule(countryCode);

  if (!rule) {
    return {
      required: false,
      ok: true,
      normalized: normalizeBuyerTaxId(taxId),
      digits: buyerTaxIdDigits(taxId),
      message: '',
      rule: null,
    };
  }

  const normalized = normalizeBuyerTaxId(taxId);
  const digits = buyerTaxIdDigits(normalized);

  const ok = rule.allowedDigitLengths.includes(digits.length);

  return {
    required: true,
    ok,
    normalized,
    digits,
    message: rule.message,
    rule,
  };
}

module.exports = {
  CJ_BUYER_TAX_ID_RULES,
  normalizeBuyerTaxId,
  getCjBuyerTaxIdRule,
  requiresCjBuyerTaxId,
  validateCjBuyerTaxId,
};
