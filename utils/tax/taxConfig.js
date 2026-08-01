// utils/tax/taxConfig.js
'use strict';

/*
 * Kasyora tax configuration
 * =========================
 *
 * This module provides the shared configuration and safe
 * normalization helpers used by Kasyora's tax resolvers.
 *
 * IMPORTANT COMMERCE SEPARATION
 * -----------------------------
 *
 * INTERNAL:
 * Kasyora Internal Store products may receive South African VAT
 * depending on the authoritative delivery country.
 *
 * CJ:
 * Kasyora does not add South African VAT to CJ products, carts,
 * shipping, checkout, PayPal payments or CJ orders.
 *
 * The CJ department must never call the Internal Store tax resolver.
 */

/*
 * South Africa's ISO 3166-1 alpha-2 country code.
 *
 * This is a jurisdiction identifier, not a currency.
 */
const SOUTH_AFRICA_COUNTRY_CODE = 'ZA';

/*
 * The default storefront country before a customer has selected
 * a country and before a GeoIP country is available.
 *
 * This default affects provisional storefront presentation only.
 * The validated checkout shipping address always becomes authoritative.
 */
const DEFAULT_TAX_COUNTRY_CODE = normalizeCountryCode(
  process.env.DEFAULT_TAX_COUNTRY_CODE,
  SOUTH_AFRICA_COUNTRY_CODE,
);

/*
 * Read the South African VAT rate from the environment.
 *
 * Example:
 * VAT_RATE=0.15
 *
 * The result is returned as a decimal rate:
 * 0.15 = 15%
 */
function getSouthAfricaVatRate() {
  const configuredRate = Number(process.env.VAT_RATE);

  if (
    !Number.isFinite(configuredRate) ||
    configuredRate < 0 ||
    configuredRate > 1
  ) {
    return 0.15;
  }

  return configuredRate;
}

/*
 * Normalize an ISO 3166-1 alpha-2 country code.
 *
 * Examples:
 * "za" -> "ZA"
 * " US " -> "US"
 *
 * Invalid values return the supplied fallback.
 */
function normalizeCountryCode(
  value,
  fallback = '',
) {
  const normalizedValue = String(value || '')
    .trim()
    .toUpperCase();

  if (/^[A-Z]{2}$/.test(normalizedValue)) {
    return normalizedValue;
  }

  const normalizedFallback = String(fallback || '')
    .trim()
    .toUpperCase();

  return /^[A-Z]{2}$/.test(normalizedFallback)
    ? normalizedFallback
    : '';
}

/*
 * Determine whether a normalized destination is South Africa.
 */
function isSouthAfricaCountry(value) {
  return (
    normalizeCountryCode(value) ===
    SOUTH_AFRICA_COUNTRY_CODE
  );
}

/*
 * Tax treatment identifiers stored in quotes and orders.
 *
 * Do not use display text as the authoritative tax decision.
 * These stable machine-readable codes allow historical orders,
 * receipts, refunds and reports to retain their original treatment.
 */
const INTERNAL_TAX_TREATMENTS = Object.freeze({
  /*
   * Internal Kasyora goods delivered within South Africa.
   */
  SOUTH_AFRICA_STANDARD: 'ZA_STANDARD',

  /*
   * Internal Kasyora goods delivered outside South Africa.
   *
   * The South African VAT rate applied by Kasyora is 0%.
   */
  SOUTH_AFRICA_EXPORT_ZERO_RATED:
    'ZA_EXPORT_ZERO_RATED',

  /*
   * Used only when an authoritative destination cannot be
   * determined during checkout.
   */
  REVIEW_REQUIRED: 'REVIEW_REQUIRED',
});

/*
 * Source identifiers describing where the country decision came from.
 *
 * Priority is enforced later by the tax-country resolver:
 *
 * 1. CHECKOUT_ADDRESS
 * 2. CUSTOMER_SELECTION
 * 3. GEO_IP
 * 4. DEFAULT
 */
const TAX_COUNTRY_SOURCES = Object.freeze({
  CHECKOUT_ADDRESS: 'CHECKOUT_ADDRESS',
  CUSTOMER_SELECTION: 'CUSTOMER_SELECTION',
  GEO_IP: 'GEO_IP',
  DEFAULT: 'DEFAULT',
});

/*
 * Tax calculation version.
 *
 * Every completed Internal Kasyora order should snapshot this version.
 * Increase it when the authoritative tax rules or calculation structure
 * changes materially.
 */
const TAX_CALCULATION_VERSION =
  String(
    process.env.TAX_CALCULATION_VERSION ||
    '2026-01',
  )
    .trim()
    .slice(0, 50) ||
  '2026-01';

/*
 * CJ VAT policy
 * =============
 *
 * This explicit constant prevents the CJ flow from accidentally
 * falling back to the global VAT_RATE environment variable.
 *
 * Kasyora-added VAT for CJ is always zero.
 */
const CJ_KASYORA_VAT_RATE = 0;

module.exports = {
  SOUTH_AFRICA_COUNTRY_CODE,
  DEFAULT_TAX_COUNTRY_CODE,

  INTERNAL_TAX_TREATMENTS,
  TAX_COUNTRY_SOURCES,
  TAX_CALCULATION_VERSION,

  CJ_KASYORA_VAT_RATE,

  getSouthAfricaVatRate,
  normalizeCountryCode,
  isSouthAfricaCountry,
};