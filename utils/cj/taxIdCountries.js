// utils/cj/taxIdCountries.js
'use strict';

/*
 * CJ buyer Tax ID rules.
 *
 * This is different from Kasyora's own tax/VAT/IOSS number.
 * These values belong to the recipient/buyer and are required
 * by destination-country customs/logistics rules.
 *
 * Keep this list strict:
 * - Add a country only when CJ/logistics/customs commonly requires it.
 * - Do not block normal checkout countries unless there is a clear rule.
 *
 * Verified / high-confidence so far:
 * - Argentina requires recipient CUIT / DNI for many import shipments.
 * - Brazil requires recipient CPF / CNPJ for CJ parcels.
 * - Chile requires recipient RUT for many import shipments.
 * - Ecuador requires recipient tax/personal ID for many import shipments.
 * - Indonesia requires recipient NPWP / NIK / passport for many import shipments.
 * - Mexico requires recipient RFC / CURP for many import shipments.
 * - Peru requires recipient DNI / RUC / CE for many import shipments.
 */
const CJ_BUYER_TAX_ID_RULES = {
  AR: {
    countryName: 'Argentina',

    label: 'CUIT / CUIL / DNI',

    placeholder: 'Required for Argentina',

    examples: 'CUIT/CUIL: 20-12345678-9 or DNI: 12345678',

    message:
      'Tax ID / Consignee ID is required for Argentina CJ delivery. Enter the buyer CUIT, CUIL, or DNI before payment. Use CUIT/CUIL with 11 digits or DNI with 7 to 8 digits.',

    allowedDigitLengths: [7, 8, 11],
  },

  BR: {
    countryName: 'Brazil',

    label: 'CPF / CNPJ',

    placeholder: 'Required for Brazil',

    examples: 'CPF: 000.000.000-00 or CNPJ: 00.000.000/0000-00',

    message:
      'Tax ID / Consignee ID is required for Brazil CJ delivery. Enter the buyer CPF or CNPJ before payment. Use CPF with 11 digits or CNPJ with 14 digits.',

    allowedDigitLengths: [11, 14],
  },

  CL: {
    countryName: 'Chile',

    label: 'RUT',

    placeholder: 'Required for Chile',

    examples: 'RUT: 12.345.678-9',

    message:
      'Tax ID / Consignee ID is required for Chile CJ delivery. Enter the buyer RUT before payment. Use the Chilean RUT with 8 or 9 digits, including the check digit if it is numeric.',

    allowedDigitLengths: [8, 9],
  },

  EC: {
    countryName: 'Ecuador',

    label: 'Cédula / RUC',

    placeholder: 'Required for Ecuador',

    examples: 'Cédula: 0123456789 or RUC: 0123456789001',

    message:
      'Tax ID / Consignee ID is required for Ecuador CJ delivery. Enter the buyer Cédula or RUC before payment. Use Cédula with 10 digits or RUC with 13 digits.',

    allowedDigitLengths: [10, 13],
  },

  ID: {
    countryName: 'Indonesia',

    label: 'NPWP / NIK / Passport',

    placeholder: 'Required for Indonesia',

    examples: 'NIK: 16 digits or NPWP: 15 to 16 digits',

    message:
      'Tax ID / Consignee ID is required for Indonesia CJ delivery. Enter the buyer NPWP, NIK, or passport number before payment. Use NIK with 16 digits or NPWP with 15 to 16 digits.',

    allowedDigitLengths: [15, 16],
  },

  MX: {
    countryName: 'Mexico',

    label: 'RFC / CURP',

    placeholder: 'Required for Mexico',

    examples: 'RFC: ABCD010203XXX or CURP: ABCD010203HDFXXX09',

    message:
      'Tax ID / Consignee ID is required for Mexico CJ delivery. Enter the buyer RFC or CURP before payment. Enter RFC or CURP without spaces.',

    allowedDigitLengths: [],

    allowedPattern: /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$|^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/i,
  },

  PE: {
    countryName: 'Peru',

    label: 'DNI / RUC / CE',

    placeholder: 'Required for Peru',

    examples: 'DNI: 12345678 or RUC: 20123456789',

    message:
      'Tax ID / Consignee ID is required for Peru CJ delivery. Enter the buyer DNI, RUC, or foreigner card number before payment. Use DNI with 8 digits or RUC with 11 digits.',

    allowedDigitLengths: [8, 9, 11],
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

  const lengthRules = Array.isArray(rule.allowedDigitLengths)
    ? rule.allowedDigitLengths
    : [];

  const lengthOk =
    lengthRules.length > 0 &&
    lengthRules.includes(digits.length);

  const patternOk =
    rule.allowedPattern instanceof RegExp &&
    rule.allowedPattern.test(normalized);

  const ok = lengthOk || patternOk;

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