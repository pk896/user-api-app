// middleware/taxCountry.js
'use strict';

const {
  DEFAULT_TAX_COUNTRY_CODE,
  TAX_COUNTRY_SOURCES,
  normalizeCountryCode,
} = require('../utils/tax/taxConfig');

const {
  resolveGeoIpCountry,
} = require('../utils/tax/resolveGeoIpCountry');

/*
 * Kasyora provisional delivery-country middleware
 * ===============================================
 *
 * This middleware determines only the provisional delivery country
 * used before checkout.
 *
 * It does not:
 *
 * - calculate VAT;
 * - change product prices;
 * - change cart totals;
 * - change PayPal totals;
 * - create orders;
 * - decide the final checkout tax treatment.
 *
 * The validated checkout shipping address will later become the only
 * authoritative country for Internal Kasyora VAT.
 *
 * CJ remains completely separate and does not receive Kasyora VAT.
 */

const TAX_COUNTRY_SESSION_KEY =
  'taxCountrySelection';

/*
 * Normalize a timestamp without trusting malformed session data.
 */
function normalizeDateString(value) {
  const parsedDate =
    new Date(value);

  if (
    Number.isNaN(
      parsedDate.getTime(),
    )
  ) {
    return '';
  }

  return parsedDate.toISOString();
}

/*
 * Read a valid customer-selected country from the session.
 *
 * The session value will later be written only by the dedicated
 * country-selection route.
 */
function getSessionTaxCountrySelection(req) {
  const selection =
    req?.session?.[
      TAX_COUNTRY_SESSION_KEY
    ];

  if (
    !selection ||
    typeof selection !== 'object'
  ) {
    return null;
  }

  const countryCode =
    normalizeCountryCode(
      selection.countryCode,
      '',
    );

  if (!countryCode) {
    return null;
  }

  return {
    countryCode,

    source:
      TAX_COUNTRY_SOURCES
        .CUSTOMER_SELECTION,

    selectedAt:
      normalizeDateString(
        selection.selectedAt,
      ),

    provisional: true,
    authoritative: false,
  };
}

/*
 * Resolve the trusted GeoIP fallback.
 *
 * A failed or unavailable GeoIP result is normal and safe.
 */
function getGeoIpTaxCountry(req) {
  const geoResult =
    resolveGeoIpCountry(req);

  const countryCode =
    normalizeCountryCode(
      geoResult?.countryCode,
      '',
    );

  if (
    geoResult?.success !== true ||
    !countryCode
  ) {
    return null;
  }

  return {
    countryCode,

    source:
      TAX_COUNTRY_SOURCES.GEO_IP,

    provider:
      String(
        geoResult.provider || '',
      )
        .trim()
        .slice(0, 100),

    provisional: true,
    authoritative: false,
  };
}

/*
 * Return the configured safe default.
 *
 * taxConfig.js already validates the environment value and falls back
 * to South Africa when DEFAULT_TAX_COUNTRY_CODE is invalid.
 */
function getDefaultTaxCountry() {
  return {
    countryCode:
      DEFAULT_TAX_COUNTRY_CODE,

    source:
      TAX_COUNTRY_SOURCES.DEFAULT,

    provider: '',

    provisional: true,
    authoritative: false,
  };
}

/*
 * Resolve the provisional country using this exact priority:
 *
 * 1. Customer selection
 * 2. Trusted GeoIP
 * 3. Configured default
 */
function resolveProvisionalTaxCountry(req) {
  const sessionSelection =
    getSessionTaxCountrySelection(req);

  if (sessionSelection) {
    return sessionSelection;
  }

  const geoIpSelection =
    getGeoIpTaxCountry(req);

  if (geoIpSelection) {
    return geoIpSelection;
  }

  return getDefaultTaxCountry();
}

/*
 * Express middleware
 * ==================
 *
 * server.js must mount this after express-session so the customer
 * selection can be read from req.session.
 */
function taxCountryMiddleware(
  req,
  res,
  next,
) {
  try {
    const context =
      resolveProvisionalTaxCountry(req);

    /*
     * Make the complete context available to later server routes.
     */
    req.taxCountryContext = {
      countryCode:
        context.countryCode,

      source:
        context.source,

      provider:
        context.provider || '',

      selectedAt:
        context.selectedAt || '',

      provisional: true,
      authoritative: false,
    };

    /*
     * Make safe presentation values available to EJS views.
     *
     * No VAT value is exposed here because VAT must be resolved by
     * the separate Internal Store tax resolver.
     */
    res.locals.taxCountryCode =
      req.taxCountryContext
        .countryCode;

    res.locals.taxCountrySource =
      req.taxCountryContext
        .source;

    res.locals.taxCountryProvider =
      req.taxCountryContext
        .provider;

    res.locals.taxCountryProvisional =
      true;

    res.locals.taxCountryAuthoritative =
      false;

    return next();
  } catch (error) {
    /*
     * Country convenience must never take the storefront down.
     *
     * Use the validated configured default and continue.
     */
    console.error(
      '[tax] Provisional tax-country middleware failed:',
      error?.stack ||
      error?.message ||
      error,
    );

    req.taxCountryContext =
      getDefaultTaxCountry();

    res.locals.taxCountryCode =
      req.taxCountryContext
        .countryCode;

    res.locals.taxCountrySource =
      req.taxCountryContext
        .source;

    res.locals.taxCountryProvider =
      '';

    res.locals.taxCountryProvisional =
      true;

    res.locals.taxCountryAuthoritative =
      false;

    return next();
  }
}

module.exports = taxCountryMiddleware;

module.exports.TAX_COUNTRY_SESSION_KEY =
  TAX_COUNTRY_SESSION_KEY;

module.exports.getSessionTaxCountrySelection =
  getSessionTaxCountrySelection;

module.exports.getGeoIpTaxCountry =
  getGeoIpTaxCountry;

module.exports.getDefaultTaxCountry =
  getDefaultTaxCountry;

module.exports.resolveProvisionalTaxCountry =
  resolveProvisionalTaxCountry;