// utils/currency/resolveDisplayCurrency.js
'use strict';

const { normalizeCurrencyCode, isSupportedUserCurrency } = require('./currencyConfig');

const { getPreferredCurrencyForCountry } = require('./countryCurrency');

const { resolveGeoIpCountry } = require('../geo/resolveGeoIpCountry');

/*
 * Kasyora display-currency resolution policy
 * ===========================================
 *
 * This resolver decides which customer-facing currency Kasyora
 * should request for the current storefront response.
 *
 * It does not:
 *
 * - convert money;
 * - change Product.price;
 * - change BASE_CURRENCY;
 * - change cart accounting;
 * - calculate VAT;
 * - determine checkout tax;
 * - change PayPal currency;
 * - change orders;
 * - change seller balances or payouts.
 *
 * Resolution priority:
 *
 * 1. Explicit customer-selected display currency
 * 2. Trusted GeoIP country -> preferred display currency
 * 3. BASE_CURRENCY
 */

/*
 * Resolution-source constants.
 *
 * These describe why a particular display currency was selected.
 */
const DISPLAY_CURRENCY_SOURCES = Object.freeze({
  CUSTOMER_SELECTION: 'CUSTOMER_SELECTION',

  GEO_IP: 'GEO_IP',

  BASE_CURRENCY: 'BASE_CURRENCY',
});

/*
 * Normalize BASE_CURRENCY safely.
 *
 * BASE_CURRENCY is Kasyora's authoritative accounting currency.
 *
 * USD remains the final defensive fallback if the environment
 * value itself is malformed.
 */
function normalizeBaseCurrency(value) {
  const currency = normalizeCurrencyCode(value || 'USD');

  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

/*
 * Read only an explicit customer currency preference.
 *
 * IMPORTANT:
 *
 * req.session.userCurrency means:
 *
 * "The customer deliberately chose this display currency."
 *
 * GeoIP must never write into this session key.
 */
function getSessionDisplayCurrency(req) {
  const currency = normalizeCurrencyCode(req?.session?.userCurrency);

  if (!currency || !isSupportedUserCurrency(currency)) {
    return null;
  }

  return {
    currency,

    source: DISPLAY_CURRENCY_SOURCES.CUSTOMER_SELECTION,

    countryCode: '',

    provider: '',
  };
}

/*
 * Resolve an automatic display currency from trusted GeoIP.
 *
 * The neutral GeoIP helper resolves only the visitor country.
 *
 * countryCurrency.js then applies Kasyora's independent
 * country -> preferred shopping-currency policy.
 */
function getGeoIpDisplayCurrency(req) {
  const geoResult = resolveGeoIpCountry(req);

  if (geoResult?.success !== true) {
    return null;
  }

  const countryCode = String(geoResult.countryCode || '')
    .trim()
    .toUpperCase();

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return null;
  }

  const currency = normalizeCurrencyCode(getPreferredCurrencyForCountry(countryCode));

  if (!currency || !isSupportedUserCurrency(currency)) {
    return null;
  }

  return {
    currency,

    source: DISPLAY_CURRENCY_SOURCES.GEO_IP,

    countryCode,

    provider: String(geoResult.provider || '')
      .trim()
      .slice(0, 100),
  };
}

/*
 * Resolve the safe BASE_CURRENCY fallback.
 *
 * Prefer BASE_CURRENCY only if it is also enabled in the
 * customer-facing display-currency whitelist.
 *
 * Kasyora currently uses USD and USD is enabled.
 *
 * If a future BASE_CURRENCY value is valid ISO-style syntax but
 * is not enabled as a display currency, fall back to USD.
 */
function getBaseCurrencyDisplayFallback(baseCurrencyValue) {
  const baseCurrency = normalizeBaseCurrency(baseCurrencyValue);

  if (isSupportedUserCurrency(baseCurrency)) {
    return {
      currency: baseCurrency,

      source: DISPLAY_CURRENCY_SOURCES.BASE_CURRENCY,

      countryCode: '',

      provider: '',
    };
  }

  return {
    currency: 'USD',

    source: DISPLAY_CURRENCY_SOURCES.BASE_CURRENCY,

    countryCode: '',

    provider: '',
  };
}

/*
 * Main display-currency resolver.
 *
 * Priority:
 *
 * CUSTOMER_SELECTION
 * -> GEO_IP
 * -> BASE_CURRENCY
 *
 * This function is synchronous because:
 *
 * - session lookup is local;
 * - trusted country headers are already present on the request;
 * - country -> currency mapping is static configuration.
 *
 * FX lookup happens later in userCurrency middleware.
 */
function resolveDisplayCurrency(req, options = {}) {
  const baseCurrency = normalizeBaseCurrency(
    options.baseCurrency || process.env.BASE_CURRENCY || 'USD',
  );

  /*
   * 1. Explicit customer choice always wins.
   */
  const sessionCurrency = getSessionDisplayCurrency(req);

  if (sessionCurrency) {
    return {
      ...sessionCurrency,

      baseCurrency,

      automatic: false,
    };
  }

  /*
   * 2. Use trusted GeoIP only when the customer has not made
   *    an explicit selection.
   */
  const geoCurrency = getGeoIpDisplayCurrency(req);

  if (geoCurrency) {
    return {
      ...geoCurrency,

      baseCurrency,

      automatic: true,
    };
  }

  /*
   * 3. Unknown country, disabled GeoIP, unsupported country
   *    currency, or missing mapping -> BASE_CURRENCY.
   */
  const fallback = getBaseCurrencyDisplayFallback(baseCurrency);

  return {
    ...fallback,

    /*
     * Keep the authoritative BASE_CURRENCY separate from the
     * customer-facing fallback currency.
     *
     * A display fallback must never rewrite Kasyora's accounting
     * currency identity.
     */
    baseCurrency,

    automatic: true,
  };
}

module.exports = {
  DISPLAY_CURRENCY_SOURCES,

  normalizeBaseCurrency,

  getSessionDisplayCurrency,

  getGeoIpDisplayCurrency,

  getBaseCurrencyDisplayFallback,

  resolveDisplayCurrency,
};
