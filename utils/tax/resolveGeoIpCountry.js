// utils/tax/resolveGeoIpCountry.js
'use strict';

const {
  normalizeCountryCode,
} = require('./taxConfig');

const {
  firstHeaderValue,
  resolveTrustedHeaderCountry:
    resolveNeutralTrustedHeaderCountry,
  resolveGeoIpCountry:
    resolveNeutralGeoIpCountry,
} = require('../geo/resolveGeoIpCountry');

/*
 * Kasyora tax GeoIP compatibility wrapper
 * ========================================
 *
 * The actual trusted infrastructure-country detection now lives in:
 *
 * utils/geo/resolveGeoIpCountry.js
 *
 * This file remains in place so the existing tax flow can continue
 * importing:
 *
 * ../utils/tax/resolveGeoIpCountry
 *
 * without changing the working provisional VAT flow.
 *
 * This wrapper performs only the small amount of tax-compatible
 * country normalization required by the existing callers.
 *
 * It must not:
 *
 * - calculate VAT;
 * - resolve tax treatment;
 * - alter checkout tax;
 * - alter PayPal totals;
 * - alter completed orders.
 */

/*
 * Preserve the existing tax helper API.
 *
 * The neutral GeoIP resolver already:
 *
 * - takes the first forwarded header value;
 * - uppercases the country code;
 * - rejects XX;
 * - rejects T1;
 * - validates a two-letter country code.
 *
 * This final normalizeCountryCode() call keeps the tax subsystem's
 * own country normalization boundary intact.
 */
function normalizeGeoCountryHeader(value) {
  const trustedValue =
    firstHeaderValue(value);

  const normalized =
    String(trustedValue || '')
      .trim()
      .toUpperCase();

  if (
    !normalized ||
    normalized === 'XX' ||
    normalized === 'T1'
  ) {
    return '';
  }

  return normalizeCountryCode(
    normalized,
    '',
  );
}

/*
 * Preserve the existing tax-facing trusted-header helper.
 *
 * Infrastructure parsing is delegated to the neutral resolver.
 */
function resolveTrustedHeaderCountry(req) {
  const neutralResult =
    resolveNeutralTrustedHeaderCountry(
      req,
    );

  const countryCode =
    normalizeCountryCode(
      neutralResult?.countryCode,
      '',
    );

  if (
    neutralResult?.success !== true ||
    !countryCode
  ) {
    return {
      success: false,

      countryCode: '',

      provider: '',
    };
  }

  return {
    success: true,

    countryCode,

    provider:
      String(
        neutralResult.provider || '',
      )
        .trim()
        .slice(0, 100),
  };
}

/*
 * Preserve the existing tax-facing GeoIP helper.
 *
 * The neutral resolver determines the visitor country.
 *
 * This wrapper then keeps the result compatible with the existing
 * tax-country middleware.
 */
function resolveGeoIpCountry(req) {
  const neutralResult =
    resolveNeutralGeoIpCountry(
      req,
    );

  const countryCode =
    normalizeCountryCode(
      neutralResult?.countryCode,
      '',
    );

  if (
    neutralResult?.success !== true ||
    !countryCode
  ) {
    return {
      success: false,

      countryCode: '',

      provider: '',
    };
  }

  return {
    success: true,

    countryCode,

    provider:
      String(
        neutralResult.provider || '',
      )
        .trim()
        .slice(0, 100),
  };
}

module.exports = {
  firstHeaderValue,

  normalizeGeoCountryHeader,

  resolveTrustedHeaderCountry,

  resolveGeoIpCountry,
};