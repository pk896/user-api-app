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
 * only when Kasyora's configured Internal VAT rate is greater
 * than zero and the applicable tax treatment requires VAT.
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
const SOUTH_AFRICA_COUNTRY_CODE =
  'ZA';

/*
 * VAT-disabled safe rate
 * ======================
 *
 * Kasyora must never accidentally begin collecting VAT because:
 *
 * - VAT_RATE is missing;
 * - VAT_RATE is blank;
 * - VAT_RATE is malformed;
 * - VAT_RATE is outside the supported range.
 *
 * Therefore, the safe fallback is always zero.
 */
const VAT_DISABLED_RATE =
  0;

/*
 * Normalize an ISO 3166-1 alpha-2 country code.
 *
 * Examples:
 *
 * "za" -> "ZA"
 * " US " -> "US"
 *
 * Invalid values return the supplied fallback.
 */
function normalizeCountryCode(
  value,
  fallback = '',
) {
  const normalizedValue =
    String(value || '')
      .trim()
      .toUpperCase();

  if (
    /^[A-Z]{2}$/.test(
      normalizedValue,
    )
  ) {
    return normalizedValue;
  }

  const normalizedFallback =
    String(fallback || '')
      .trim()
      .toUpperCase();

  return /^[A-Z]{2}$/.test(
    normalizedFallback,
  )
    ? normalizedFallback
    : '';
}

/*
 * The default storefront country before a customer has selected
 * a country and before a trusted GeoIP country is available.
 *
 * This default affects provisional storefront presentation only.
 *
 * The validated checkout shipping address always becomes
 * authoritative for the final Internal tax treatment.
 */
const DEFAULT_TAX_COUNTRY_CODE =
  normalizeCountryCode(
    process.env.DEFAULT_TAX_COUNTRY_CODE,
    SOUTH_AFRICA_COUNTRY_CODE,
  );

/*
 * Read the configured South African VAT rate.
 *
 * Supported examples:
 *
 * VAT_RATE=0
 * VAT_RATE=0.15
 * VAT_RATE=0.20
 *
 * The returned value is a decimal rate:
 *
 * 0    = VAT disabled
 * 0.15 = 15%
 * 0.20 = 20%
 *
 * Production-safe fallback policy:
 *
 * Missing value -> 0
 * Blank value -> 0
 * Invalid value -> 0
 * Negative value -> 0
 * Value greater than 1 -> 0
 *
 * This deliberately does not default to 0.15 because doing so
 * could accidentally activate VAT when Kasyora is not configured
 * to collect it.
 */
function getSouthAfricaVatRate() {
  const rawConfiguredRate =
    String(
      process.env.VAT_RATE ?? '',
    ).trim();

  if (!rawConfiguredRate) {
    return VAT_DISABLED_RATE;
  }

  const configuredRate =
    Number(rawConfiguredRate);

  if (
    !Number.isFinite(
      configuredRate,
    ) ||
    configuredRate < 0 ||
    configuredRate > 1
  ) {
    return VAT_DISABLED_RATE;
  }

  return configuredRate;
}

/*
 * Determine whether Internal Kasyora VAT is globally enabled.
 *
 * This is the central VAT activation decision.
 *
 * VAT is enabled only when the validated configured rate
 * is greater than zero.
 *
 * Examples:
 *
 * VAT_RATE=0
 * -> false
 *
 * VAT_RATE=0.15
 * -> true
 *
 * Missing or invalid VAT_RATE
 * -> false
 */
function isSouthAfricaVatEnabled() {
  return (
    getSouthAfricaVatRate() >
    VAT_DISABLED_RATE
  );
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
 *
 * These stable machine-readable codes allow historical orders,
 * receipts, refunds and reports to retain their original treatment.
 */
const INTERNAL_TAX_TREATMENTS =
  Object.freeze({
    /*
     * Internal Kasyora VAT is currently disabled.
     *
     * This is different from a legally zero-rated export.
     *
     * Examples include:
     *
     * - VAT_RATE=0;
     * - VAT_RATE is missing;
     * - VAT_RATE is invalid and safely falls back to zero.
     */
    VAT_DISABLED:
      'VAT_DISABLED',

    /*
     * Internal Kasyora goods delivered within South Africa
     * while Internal VAT is enabled.
     */
    SOUTH_AFRICA_STANDARD:
      'ZA_STANDARD',

    /*
     * Internal Kasyora goods delivered outside South Africa
     * while Internal VAT is enabled.
     *
     * The South African VAT rate applied by Kasyora is zero,
     * subject to the required export qualification and evidence.
     */
    SOUTH_AFRICA_EXPORT_ZERO_RATED:
      'ZA_EXPORT_ZERO_RATED',

    /*
     * Used only when an authoritative destination cannot be
     * determined during checkout.
     */
    REVIEW_REQUIRED:
      'REVIEW_REQUIRED',
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
const TAX_COUNTRY_SOURCES =
  Object.freeze({
    CHECKOUT_ADDRESS:
      'CHECKOUT_ADDRESS',

    CUSTOMER_SELECTION:
      'CUSTOMER_SELECTION',

    GEO_IP:
      'GEO_IP',

    DEFAULT:
      'DEFAULT',
  });

/*
 * Tax calculation version.
 *
 * Every completed Internal Kasyora order should snapshot this version.
 *
 * Increase it through TAX_CALCULATION_VERSION when the authoritative
 * tax rules or calculation structure changes materially.
 */
const TAX_CALCULATION_VERSION =
  String(
    process.env
      .TAX_CALCULATION_VERSION ||
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
 * falling back to the Internal VAT_RATE environment variable.
 *
 * Kasyora-added VAT for CJ is always zero.
 */
const CJ_KASYORA_VAT_RATE =
  0;

module.exports = {
  SOUTH_AFRICA_COUNTRY_CODE,
  DEFAULT_TAX_COUNTRY_CODE,

  VAT_DISABLED_RATE,

  INTERNAL_TAX_TREATMENTS,
  TAX_COUNTRY_SOURCES,
  TAX_CALCULATION_VERSION,

  CJ_KASYORA_VAT_RATE,

  getSouthAfricaVatRate,
  isSouthAfricaVatEnabled,

  normalizeCountryCode,
  isSouthAfricaCountry,
};