// middleware/storeDepartment.js
'use strict';

const {
  TAX_COUNTRY_SOURCES,
} = require('../utils/tax/taxConfig');

const {
  resolveInternalTaxTreatment,
} = require('../utils/tax/resolveInternalTaxTreatment');

/*
 * Normalize the active storefront department.
 *
 * Any value other than "cj" safely resolves to the
 * Internal Kasyora Store.
 */
function normalizeDepartment(value) {
  return String(value || '')
    .trim()
    .toLowerCase() === 'cj'
    ? 'cj'
    : 'internal';
}

/*
 * Round BASE_CURRENCY amounts to two decimal places.
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
 * Normalize a cart quantity.
 *
 * Invalid and negative quantities contribute nothing
 * to the visible cart summary.
 */
function normalizeQuantity(value) {
  return Math.max(
    0,
    Math.floor(
      Number(value || 0),
    ),
  );
}

/*
 * Resolve the Internal storefront's complete provisional
 * tax treatment.
 *
 * taxCountryMiddleware has already populated:
 *
 * req.taxCountryContext.countryCode
 * req.taxCountryContext.source
 *
 * This result is provisional only.
 *
 * The validated checkout shipping address remains
 * authoritative for:
 *
 * - final VAT;
 * - PayPal totals;
 * - completed Internal orders.
 *
 * This function belongs only to the Internal Store.
 * CJ never calls the Internal tax resolver.
 */
function getProvisionalInternalTaxTreatment(req) {
  const destinationCountryCode =
    String(
      req?.taxCountryContext
        ?.countryCode ||
      '',
    )
      .trim()
      .toUpperCase()
      .slice(0, 2);

  const countrySource =
    String(
      req?.taxCountryContext
        ?.source ||
      TAX_COUNTRY_SOURCES.DEFAULT,
    )
      .trim()
      .toUpperCase();

  const treatment =
    resolveInternalTaxTreatment({
      destinationCountryCode,
      countrySource,
    });

  /*
   * A provisional country normally produces a successful
   * treatment because missing provisional values safely use
   * the configured default country.
   *
   * Keep a defensive zero-rate fallback so a malformed context
   * can never add VAT to the storefront cart.
   */
  if (
    !treatment ||
    treatment.success !== true
  ) {
    return {
      success:
        false,

      destinationCountryCode,

      countrySource,

      authoritative:
        false,

      provisional:
        true,

      vatEnabled:
        false,

      treatmentCode:
        'REVIEW_REQUIRED',

      vatRate:
        0,

      vatPercentage:
        0,

      label:
        '',

      exportEvidenceRequired:
        false,
    };
  }

  const resolvedRate =
    Number(
      treatment.vatRate,
    );

  const safeVatRate =
    Number.isFinite(
      resolvedRate,
    ) &&
    resolvedRate >= 0 &&
    resolvedRate <= 1
      ? resolvedRate
      : 0;

  return {
    ...treatment,

    /*
     * VAT wording and activation require both:
     *
     * - the resolver explicitly enabling VAT; and
     * - a valid configured rate context.
     *
     * A qualifying foreign export may still have:
     *
     * vatEnabled: true
     * vatRate: 0
     *
     * because VAT is active globally but the export treatment
     * is zero-rated.
     */
    vatEnabled:
      treatment.vatEnabled === true,

    vatRate:
      safeVatRate,

    vatPercentage:
      round2(
        safeVatRate * 100,
      ),
  };
}

/*
 * Read the authoritative VAT-exclusive Internal cart unit price.
 *
 * priceExVat is preferred for compatibility with current and
 * older Internal customer sessions.
 *
 * New Internal cart items contain the same VAT-exclusive amount in:
 *
 * item.price
 * item.priceExVat
 */
function getInternalPriceExVat(item) {
  const priceExVat =
    Number(
      item?.priceExVat,
    );

  if (
    Number.isFinite(
      priceExVat,
    ) &&
    priceExVat >= 0
  ) {
    return round2(
      priceExVat,
    );
  }

  const storedPrice =
    Number(
      item?.price,
    );

  if (
    Number.isFinite(
      storedPrice,
    ) &&
    storedPrice >= 0
  ) {
    return round2(
      storedPrice,
    );
  }

  return 0;
}

/*
 * Internal cart summary
 * =====================
 *
 * Internal cart prices remain stored VAT-exclusive.
 *
 * The total exposed to storefront templates is the provisional
 * customer-visible amount:
 *
 * VAT-exclusive unit price
 * + provisional VAT
 * × quantity
 *
 * VAT_RATE=0:
 *
 * visible total = VAT-exclusive total
 *
 * VAT_RATE greater than zero with South Africa selected:
 *
 * visible total = VAT-inclusive provisional total
 *
 * Foreign destination while VAT is globally enabled:
 *
 * visible total = zero-rated provisional total
 */
function internalCartSummary(
  cart,
  taxTreatment,
) {
  const items =
    Array.isArray(
      cart?.items,
    )
      ? cart.items
      : [];

  const resolvedVatRate =
    Number(
      taxTreatment?.vatRate,
    );

  const provisionalVatRate =
    Number.isFinite(
      resolvedVatRate,
    ) &&
    resolvedVatRate >= 0 &&
    resolvedVatRate <= 1
      ? resolvedVatRate
      : 0;

  return items.reduce(
    (summary, item) => {
      const quantity =
        normalizeQuantity(
          item?.quantity,
        );

      const unitPriceExVat =
        getInternalPriceExVat(
          item,
        );

      const unitVatAmount =
        round2(
          unitPriceExVat *
          provisionalVatRate,
        );

      const visibleUnitPrice =
        round2(
          unitPriceExVat +
          unitVatAmount,
        );

      summary.count +=
        quantity;

      summary.subtotalExVat =
        round2(
          summary.subtotalExVat +
          (
            unitPriceExVat *
            quantity
          ),
        );

      summary.vatAmount =
        round2(
          summary.vatAmount +
          (
            unitVatAmount *
            quantity
          ),
        );

      summary.total =
        round2(
          summary.total +
          (
            visibleUnitPrice *
            quantity
          ),
        );

      return summary;
    },
    {
      count:
        0,

      subtotalExVat:
        0,

      vatAmount:
        0,

      total:
        0,
    },
  );
}

/*
 * Separate CJ cart summary
 * ========================
 *
 * Do not apply Internal tax configuration or Internal country
 * treatment to CJ.
 *
 * CJ cart item.price remains authoritative for the completely
 * separate CJ commerce flow.
 */
function cjCartSummary(cart) {
  const items =
    Array.isArray(
      cart?.items,
    )
      ? cart.items
      : [];

  return items.reduce(
    (summary, item) => {
      const quantity =
        normalizeQuantity(
          item?.quantity,
        );

      const storedPrice =
        Number(
          item?.price,
        );

      const price =
        Number.isFinite(
          storedPrice,
        ) &&
        storedPrice >= 0
          ? round2(
              storedPrice,
            )
          : 0;

      summary.count +=
        quantity;

      summary.total =
        round2(
          summary.total +
          (
            price *
            quantity
          ),
        );

      return summary;
    },
    {
      count:
        0,

      total:
        0,
    },
  );
}

module.exports = function storeDepartment(
  req,
  res,
  next,
) {
  const activeDepartment =
    normalizeDepartment(
      req.session?.storeDepartment,
    );

  /*
   * Resolve this once per request.
   *
   * The same treatment controls:
   *
   * - the Internal header cart;
   * - the Internal mobile floating cart;
   * - shared VAT presentation locals.
   */
  const provisionalInternalTaxTreatment =
    getProvisionalInternalTaxTreatment(
      req,
    );

  const internalCart =
    internalCartSummary(
      req.session?.cart,
      provisionalInternalTaxTreatment,
    );

  const cjCart =
    cjCartSummary(
      req.session?.cjCart,
    );

  res.locals.storeDepartment =
    activeDepartment;

  /*
   * Shared Internal storefront tax state.
   *
   * These values are provisional only.
   */
  res.locals.internalTaxTreatment =
    provisionalInternalTaxTreatment;

  res.locals.internalVatEnabled =
    provisionalInternalTaxTreatment
      .vatEnabled === true;

  res.locals.internalVatRate =
    Number(
      provisionalInternalTaxTreatment
        .vatRate ||
      0,
    );

  res.locals.internalVatPercentage =
    Number(
      provisionalInternalTaxTreatment
        .vatPercentage ||
      0,
    );

  /*
   * Internal cart summary
   *
   * Existing count and total fields are preserved.
   * The additional breakdown values are safe for later
   * cart and navigation presentation.
   */
  res.locals.internalCartSummary = {
    count:
      internalCart.count,

    subtotalExVat:
      round2(
        internalCart.subtotalExVat,
      ),

    vatAmount:
      round2(
        internalCart.vatAmount,
      ),

    total:
      round2(
        internalCart.total,
      ),
  };

  /*
   * CJ cart remains separate and contains no Internal VAT fields.
   */
  res.locals.cjCartSummary = {
    count:
      cjCart.count,

    total:
      round2(
        cjCart.total,
      ),
  };

  res.locals.activeStoreCart =
    activeDepartment === 'cj'
      ? res.locals.cjCartSummary
      : res.locals.internalCartSummary;

  res.locals.activeStoreCartUrl =
    activeDepartment === 'cj'
      ? '/cj/cart'
      : '/store/cart';

  return next();
};

/*
 * Export focused helpers for safe automated testing.
 *
 * These exports do not change Express middleware behaviour.
 */
module.exports.normalizeDepartment =
  normalizeDepartment;

module.exports.getProvisionalInternalTaxTreatment =
  getProvisionalInternalTaxTreatment;

module.exports.getInternalPriceExVat =
  getInternalPriceExVat;

module.exports.internalCartSummary =
  internalCartSummary;

module.exports.cjCartSummary =
  cjCartSummary;