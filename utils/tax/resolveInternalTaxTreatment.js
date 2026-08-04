// utils/tax/resolveInternalTaxTreatment.js
'use strict';

const {
  SOUTH_AFRICA_COUNTRY_CODE,
  DEFAULT_TAX_COUNTRY_CODE,
  INTERNAL_TAX_TREATMENTS,
  TAX_COUNTRY_SOURCES,
  TAX_CALCULATION_VERSION,
  getSouthAfricaVatRate,
  isSouthAfricaVatEnabled,
  normalizeCountryCode,
  isSouthAfricaCountry,
} = require('./taxConfig');

/*
 * Kasyora Internal Store tax resolver
 * ===================================
 *
 * This resolver belongs only to the Internal Kasyora Store.
 *
 * It must never be used for:
 *
 * - CJ products
 * - CJ cart calculations
 * - CJ checkout calculations
 * - CJ PayPal payments
 * - CJ orders
 *
 * The CJ department has a separate zero-Kasyora-VAT policy.
 */

/*
 * Safely round an amount to two decimal places.
 *
 * All input and output amounts remain in Kasyora's
 * authoritative BASE_CURRENCY.
 */
function round2(value) {
  const amount =
    Number(value);

  if (
    !Number.isFinite(amount)
  ) {
    return 0;
  }

  return (
    Math.round(
      amount * 100,
    ) / 100
  );
}

/*
 * Normalize and validate the source that supplied the country.
 *
 * Supported priority order:
 *
 * 1. CHECKOUT_ADDRESS
 * 2. CUSTOMER_SELECTION
 * 3. GEO_IP
 * 4. DEFAULT
 */
function normalizeTaxCountrySource(value) {
  const normalizedValue =
    String(value || '')
      .trim()
      .toUpperCase();

  const allowedSources =
    new Set(
      Object.values(
        TAX_COUNTRY_SOURCES,
      ),
    );

  return allowedSources.has(
    normalizedValue,
  )
    ? normalizedValue
    : TAX_COUNTRY_SOURCES.DEFAULT;
}

/*
 * Determine whether the supplied country source is authoritative.
 *
 * Only the validated checkout shipping address is authoritative.
 *
 * Customer selection, GeoIP and default country are provisional
 * storefront or pre-checkout indicators only.
 */
function isAuthoritativeCountrySource(source) {
  return (
    normalizeTaxCountrySource(
      source,
    ) ===
    TAX_COUNTRY_SOURCES
      .CHECKOUT_ADDRESS
  );
}

/*
 * Resolve the Internal Kasyora Store tax treatment.
 *
 * Arguments:
 *
 * destinationCountryCode:
 * The country where the Internal Kasyora order will be delivered.
 *
 * countrySource:
 * Describes where the country came from:
 *
 * - CHECKOUT_ADDRESS
 * - CUSTOMER_SELECTION
 * - GEO_IP
 * - DEFAULT
 *
 * During checkout, the validated shipping-address country must be
 * passed with countrySource CHECKOUT_ADDRESS.
 */
function resolveInternalTaxTreatment({
  destinationCountryCode,
  countrySource =
    TAX_COUNTRY_SOURCES.DEFAULT,
} = {}) {
  const normalizedSource =
    normalizeTaxCountrySource(
      countrySource,
    );

  /*
   * Before checkout, an invalid or missing country safely falls
   * back to the configured provisional default country.
   *
   * At checkout, an invalid or missing authoritative country must
   * not silently fall back because shipping, payment and the final
   * order depend on the validated destination.
   */
  const destinationCountry =
    normalizedSource ===
    TAX_COUNTRY_SOURCES
      .CHECKOUT_ADDRESS
      ? normalizeCountryCode(
          destinationCountryCode,
          '',
        )
      : normalizeCountryCode(
          destinationCountryCode,
          DEFAULT_TAX_COUNTRY_CODE,
        );

  const authoritative =
    isAuthoritativeCountrySource(
      normalizedSource,
    );

  /*
   * A validated checkout address without a valid country must stop
   * finalisation and payment.
   *
   * This validation remains required even when VAT is disabled,
   * because the destination is still needed for shipping and the
   * completed order.
   */
  if (
    authoritative &&
    !destinationCountry
  ) {
    return {
      success: false,

      jurisdiction:
        SOUTH_AFRICA_COUNTRY_CODE,

      destinationCountryCode:
        '',

      countrySource:
        normalizedSource,

      authoritative:
        true,

      provisional:
        false,

      vatEnabled:
        false,

      treatmentCode:
        INTERNAL_TAX_TREATMENTS
          .REVIEW_REQUIRED,

      vatRate:
        null,

      vatPercentage:
        null,

      label:
        'Delivery country required',

      reason:
        'A valid checkout shipping country is required before the Internal Kasyora order can be finalised.',

      exportEvidenceRequired:
        false,

      taxCalculationVersion:
        TAX_CALCULATION_VERSION,
    };
  }

  const configuredVatRate =
    getSouthAfricaVatRate();

  const vatEnabled =
    isSouthAfricaVatEnabled();

  /*
   * VAT-disabled Internal treatment
   * ===============================
   *
   * When VAT_RATE is zero, missing or invalid:
   *
   * - Kasyora does not add VAT;
   * - South African sales are not classified as ZA_STANDARD;
   * - foreign sales are not classified as zero-rated exports;
   * - product and cart prices remain VAT-exclusive source prices;
   * - customer-visible prices remain equal to those source prices.
   *
   * The destination country is still preserved because it remains
   * important for shipping, checkout and the completed order.
   */
  if (!vatEnabled) {
    return {
      success: true,

      jurisdiction:
        SOUTH_AFRICA_COUNTRY_CODE,

      destinationCountryCode:
        destinationCountry,

      countrySource:
        normalizedSource,

      authoritative,

      provisional:
        !authoritative,

      vatEnabled:
        false,

      treatmentCode:
        INTERNAL_TAX_TREATMENTS
          .VAT_DISABLED,

      vatRate:
        0,

      vatPercentage:
        0,

      /*
       * Keep the display label empty so shared storefront or
       * checkout code cannot accidentally display VAT wording.
       */
      label:
        '',

      reason:
        'Internal Kasyora VAT is disabled by the current tax configuration.',

      exportEvidenceRequired:
        false,

      taxCalculationVersion:
        TAX_CALCULATION_VERSION,
    };
  }

  /*
   * Internal products delivered within South Africa are charged
   * the configured South African standard VAT rate only while
   * Internal VAT is enabled.
   */
  if (
    isSouthAfricaCountry(
      destinationCountry,
    )
  ) {
    return {
      success: true,

      jurisdiction:
        SOUTH_AFRICA_COUNTRY_CODE,

      destinationCountryCode:
        destinationCountry,

      countrySource:
        normalizedSource,

      authoritative,

      provisional:
        !authoritative,

      vatEnabled:
        true,

      treatmentCode:
        INTERNAL_TAX_TREATMENTS
          .SOUTH_AFRICA_STANDARD,

      vatRate:
        configuredVatRate,

      vatPercentage:
        round2(
          configuredVatRate * 100,
        ),

      label:
        'South African VAT',

      reason:
        authoritative
          ? 'The validated shipping address is in South Africa and Internal Kasyora VAT is enabled.'
          : 'The provisional delivery country is South Africa and Internal Kasyora VAT is enabled.',

      exportEvidenceRequired:
        false,

      taxCalculationVersion:
        TAX_CALCULATION_VERSION,
    };
  }

  /*
   * Internal products delivered outside South Africa receive
   * a 0% South African VAT treatment only while Kasyora's
   * Internal VAT configuration is enabled.
   *
   * The completed order must retain the export and delivery
   * evidence required by Kasyora's accounting and compliance
   * process.
   */
  return {
    success: true,

    jurisdiction:
      SOUTH_AFRICA_COUNTRY_CODE,

    destinationCountryCode:
      destinationCountry,

    countrySource:
      normalizedSource,

    authoritative,

    provisional:
      !authoritative,

    vatEnabled:
      true,

    treatmentCode:
      INTERNAL_TAX_TREATMENTS
        .SOUTH_AFRICA_EXPORT_ZERO_RATED,

    vatRate:
      0,

    vatPercentage:
      0,

    label:
      'South African VAT at 0%',

    reason:
      authoritative
        ? 'The validated shipping address is outside South Africa and Internal Kasyora VAT is enabled.'
        : 'The provisional delivery country is outside South Africa and Internal Kasyora VAT is enabled.',

    exportEvidenceRequired:
      authoritative,

    taxCalculationVersion:
      TAX_CALCULATION_VERSION,
  };
}

/*
 * Calculate an Internal product price using a resolved treatment.
 *
 * The supplied unitPriceExVat must remain the stored Product.price
 * value in BASE_CURRENCY.
 *
 * This helper does not perform display-currency conversion.
 */
function calculateInternalUnitPrice({
  unitPriceExVat,
  taxTreatment,
} = {}) {
  const netAmount =
    round2(
      unitPriceExVat,
    );

  if (
    netAmount < 0
  ) {
    const error =
      new Error(
        'Internal product price cannot be negative.',
      );

    error.code =
      'INTERNAL_TAX_PRICE_INVALID';

    throw error;
  }

  const resolvedVatRate =
    Number(
      taxTreatment?.vatRate,
    );

  if (
    !taxTreatment ||
    taxTreatment.success !== true ||
    !Number.isFinite(
      resolvedVatRate,
    ) ||
    resolvedVatRate < 0 ||
    resolvedVatRate > 1
  ) {
    const error =
      new Error(
        'A valid Internal tax treatment is required.',
      );

    error.code =
      'INTERNAL_TAX_TREATMENT_INVALID';

    throw error;
  }

  const vatRate =
    resolvedVatRate;

  const vatAmount =
    round2(
      netAmount *
      vatRate,
    );

  const grossAmount =
    round2(
      netAmount +
      vatAmount,
    );

  return {
    unitPriceExVat:
      netAmount,

    unitVatAmount:
      vatAmount,

    unitPriceIncVat:
      grossAmount,

    vatEnabled:
      taxTreatment.vatEnabled === true,

    vatRate,

    vatPercentage:
      round2(
        vatRate * 100,
      ),

    treatmentCode:
      taxTreatment.treatmentCode,

    jurisdiction:
      taxTreatment.jurisdiction,

    destinationCountryCode:
      taxTreatment
        .destinationCountryCode,

    countrySource:
      taxTreatment.countrySource,

    authoritative:
      taxTreatment.authoritative === true,

    provisional:
      taxTreatment.provisional === true,

    exportEvidenceRequired:
      taxTreatment
        .exportEvidenceRequired === true,

    taxCalculationVersion:
      taxTreatment
        .taxCalculationVersion,
  };
}

/*
 * Calculate an Internal cart or order line.
 */
function calculateInternalLine({
  unitPriceExVat,
  quantity,
  taxTreatment,
} = {}) {
  const normalizedQuantity =
    Math.max(
      1,
      Math.floor(
        Number(quantity) || 1,
      ),
    );

  const unit =
    calculateInternalUnitPrice({
      unitPriceExVat,
      taxTreatment,
    });

  return {
    ...unit,

    quantity:
      normalizedQuantity,

    lineSubtotalExVat:
      round2(
        unit.unitPriceExVat *
        normalizedQuantity,
      ),

    lineVatAmount:
      round2(
        unit.unitVatAmount *
        normalizedQuantity,
      ),

    lineTotalIncVat:
      round2(
        unit.unitPriceIncVat *
        normalizedQuantity,
      ),
  };
}

module.exports = {
  round2,

  normalizeTaxCountrySource,
  isAuthoritativeCountrySource,

  resolveInternalTaxTreatment,
  calculateInternalUnitPrice,
  calculateInternalLine,
};