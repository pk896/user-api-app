// middleware/storeDepartment.js
'use strict';

const {
  TAX_COUNTRY_SOURCES,
} = require('../utils/tax/taxConfig');

const {
  resolveInternalTaxTreatment,
} = require('../utils/tax/resolveInternalTaxTreatment');

function normalizeDepartment(value) {
  return String(value || '')
    .trim()
    .toLowerCase() === 'cj'
    ? 'cj'
    : 'internal';
}

function round2(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return 0;
  }

  return Math.round(amount * 100) / 100;
}

function normalizeQuantity(value) {
  return Math.max(
    0,
    Math.floor(
      Number(value || 0),
    ),
  );
}

/*
 * Resolve the Internal storefront's provisional VAT rate.
 *
 * taxCountryMiddleware has already populated:
 *
 * req.taxCountryContext.countryCode
 * req.taxCountryContext.source
 *
 * This result is provisional only.
 *
 * The validated Checkout shipping address remains authoritative
 * for the final Internal VAT calculation.
 */
function getProvisionalInternalVatRate(req) {
  const destinationCountryCode =
    String(
      req?.taxCountryContext?.countryCode ||
      '',
    )
      .trim()
      .toUpperCase()
      .slice(0, 2);

  const countrySource =
    String(
      req?.taxCountryContext?.source ||
      TAX_COUNTRY_SOURCES.DEFAULT,
    )
      .trim()
      .toUpperCase();

  const treatment =
    resolveInternalTaxTreatment({
      destinationCountryCode,
      countrySource,
    });

  const resolvedRate =
    Number(
      treatment?.vatRate,
    );

  if (
    !Number.isFinite(resolvedRate) ||
    resolvedRate < 0 ||
    resolvedRate > 1
  ) {
    return 0;
  }

  return resolvedRate;
}

/*
 * Read the authoritative VAT-exclusive Internal cart unit price.
 *
 * priceExVat is preferred for compatibility with older sessions.
 * New cart items contain the same VAT-exclusive amount in:
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
    Number.isFinite(priceExVat) &&
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
    Number.isFinite(storedPrice) &&
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
 * Internal cart prices are stored VAT-exclusive.
 *
 * The total exposed to storefront templates is the provisional
 * customer-visible amount:
 *
 * VAT-exclusive unit price
 * + provisional VAT
 * × quantity
 */
function internalCartSummary(
  cart,
  provisionalVatRate,
) {
  const items =
    Array.isArray(cart?.items)
      ? cart.items
      : [];

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
      count: 0,
      total: 0,
    },
  );
}

/*
 * Separate CJ cart summary
 * ========================
 *
 * Do not apply Internal VAT logic to CJ.
 *
 * CJ cart item.price remains the authority for the separate
 * CJ commerce flow.
 */
function cjCartSummary(cart) {
  const items =
    Array.isArray(cart?.items)
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
        Number.isFinite(storedPrice) &&
        storedPrice >= 0
          ? storedPrice
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
      count: 0,
      total: 0,
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

  const provisionalInternalVatRate =
    getProvisionalInternalVatRate(
      req,
    );

  const internalCart =
    internalCartSummary(
      req.session?.cart,
      provisionalInternalVatRate,
    );

  const cjCart =
    cjCartSummary(
      req.session?.cjCart,
    );

  res.locals.storeDepartment =
    activeDepartment;

  res.locals.internalCartSummary = {
    count:
      internalCart.count,

    total:
      round2(
        internalCart.total,
      ),
  };

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

  next();
};