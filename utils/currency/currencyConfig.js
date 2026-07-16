// utils/currency/currencyConfig.js
'use strict';

/*
 * Kasyora customer-facing currencies.
 *
 * IMPORTANT:
 * - BASE_CURRENCY remains Kasyora's authoritative accounting currency.
 * - These currencies are for customer display only.
 * - Adding a currency here does not change product, order, payout,
 *   refund or seller-balance accounting.
 */

const SUPPORTED_USER_CURRENCIES = Object.freeze([
  Object.freeze({
    code: 'USD',
    name: 'US Dollar',
    symbol: '$',
    locale: 'en-US',
    decimals: 2,
  }),

  Object.freeze({
    code: 'ZAR',
    name: 'South African Rand',
    symbol: 'R',
    locale: 'en-ZA',
    decimals: 2,
  }),

  Object.freeze({
    code: 'EUR',
    name: 'Euro',
    symbol: '€',
    locale: 'en-IE',
    decimals: 2,
  }),

  Object.freeze({
    code: 'GBP',
    name: 'British Pound',
    symbol: '£',
    locale: 'en-GB',
    decimals: 2,
  }),

  Object.freeze({
    code: 'CAD',
    name: 'Canadian Dollar',
    symbol: 'CA$',
    locale: 'en-CA',
    decimals: 2,
  }),

  Object.freeze({
    code: 'AUD',
    name: 'Australian Dollar',
    symbol: 'A$',
    locale: 'en-AU',
    decimals: 2,
  }),
]);

const SUPPORTED_USER_CURRENCY_CODES = new Set(
  SUPPORTED_USER_CURRENCIES.map((currency) => currency.code),
);

function normalizeCurrencyCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function isSupportedUserCurrency(value) {
  return SUPPORTED_USER_CURRENCY_CODES.has(
    normalizeCurrencyCode(value),
  );
}

function getSupportedUserCurrency(value) {
  const code = normalizeCurrencyCode(value);

  return (
    SUPPORTED_USER_CURRENCIES.find(
      (currency) => currency.code === code,
    ) || null
  );
}

function getSupportedUserCurrencies() {
  return SUPPORTED_USER_CURRENCIES.map((currency) => ({
    ...currency,
  }));
}

module.exports = {
  SUPPORTED_USER_CURRENCIES,
  normalizeCurrencyCode,
  isSupportedUserCurrency,
  getSupportedUserCurrency,
  getSupportedUserCurrencies,
};
