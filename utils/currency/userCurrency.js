// utils/currency/userCurrency.js
'use strict';

const {
  convertMoneyAmount,
  FX_PROVIDER,
} = require('../fx/getFxRate');

const {
  normalizeCurrencyCode,
  isSupportedUserCurrency,
  getSupportedUserCurrency,
  getSupportedUserCurrencies,
} = require('./currencyConfig');

const {
  resolveDisplayCurrency,
} = require('./resolveDisplayCurrency');

/*
 * Kasyora authoritative accounting currency.
 *
 * Display-currency selection must never change this value.
 */
function getBaseCurrency() {
  const currency =
    normalizeCurrencyCode(
      process.env.BASE_CURRENCY ||
        'USD',
    );

  return /^[A-Z]{3}$/.test(
    currency,
  )
    ? currency
    : 'USD';
}

/*
 * Resolve the complete customer display-currency context.
 *
 * Priority is owned by resolveDisplayCurrency.js:
 *
 * 1. Explicit customer selection
 * 2. Trusted GeoIP country
 * 3. BASE_CURRENCY fallback
 *
 * This helper does not perform FX conversion.
 */
function getUserCurrencyContext(req) {
  return resolveDisplayCurrency(
    req,
    {
      baseCurrency:
        getBaseCurrency(),
    },
  );
}

/*
 * Preserve the existing getUserCurrency() public API.
 *
 * Existing routes and helpers can continue asking only for the
 * three-letter display currency code.
 *
 * The difference is that, when the customer has not manually
 * selected a currency, GeoIP may now supply the automatic
 * display currency.
 */
function getUserCurrency(req) {
  const context =
    getUserCurrencyContext(
      req,
    );

  const currency =
    normalizeCurrencyCode(
      context?.currency,
    );

  if (
    isSupportedUserCurrency(
      currency,
    )
  ) {
    return currency;
  }

  /*
   * Defensive fallback.
   *
   * resolveDisplayCurrency() already provides this protection,
   * but keep getUserCurrency() independently safe because many
   * existing Kasyora callers rely on this function.
   */
  const baseCurrency =
    getBaseCurrency();

  if (
    isSupportedUserCurrency(
      baseCurrency,
    )
  ) {
    return baseCurrency;
  }

  return 'USD';
}

/*
 * Store an explicit customer choice.
 *
 * IMPORTANT:
 *
 * This session key means:
 *
 * "The customer deliberately selected this display currency."
 *
 * GeoIP must never write into this key.
 */
function setUserCurrency(
  req,
  currency,
) {
  if (!req?.session) {
    const err =
      new Error(
        'A session is required before selecting a currency.',
      );

    err.code =
      'USER_CURRENCY_SESSION_REQUIRED';

    throw err;
  }

  const normalized =
    normalizeCurrencyCode(
      currency,
    );

  if (
    !isSupportedUserCurrency(
      normalized,
    )
  ) {
    const err =
      new Error(
        `Unsupported customer currency: ${currency}`,
      );

    err.code =
      'USER_CURRENCY_NOT_SUPPORTED';

    throw err;
  }

  req.session.userCurrency =
    normalized;

  return normalized;
}

/*
 * Remove only the explicit customer preference.
 *
 * After this value is removed, the normal resolution policy
 * becomes active again:
 *
 * GeoIP
 * -> BASE_CURRENCY
 *
 * This function deliberately does not write a replacement
 * currency into the session.
 */
function clearUserCurrency(req) {
  if (req?.session) {
    delete req.session.userCurrency;
  }
}

function getUserCurrencyDetails(req) {
  const currency =
    getUserCurrency(req);

  return (
    getSupportedUserCurrency(
      currency,
    ) ||
    getSupportedUserCurrency(
      'USD',
    )
  );
}

/*
 * Build the standard currency presentation state used by routes
 * and EJS templates.
 *
 * Existing fields are preserved.
 *
 * Additional fields expose where the requested display currency
 * came from without changing any accounting values.
 */
function getCurrencyViewData(req) {
  const baseCurrency =
    getBaseCurrency();

  const currencyContext =
    getUserCurrencyContext(
      req,
    );

  const userCurrency =
    getUserCurrency(
      req,
    );

  const userCurrencyDetails =
    getSupportedUserCurrency(
      userCurrency,
    ) ||
    getSupportedUserCurrency(
      'USD',
    );

  return {
    baseCurrency,

    userCurrency,

    /*
     * displayCurrency is the clearer presentation name.
     *
     * userCurrency is retained for backward compatibility with
     * existing Kasyora routes and views.
     */
    displayCurrency:
      userCurrency,

    userCurrencyDetails,

    supportedUserCurrencies:
      getSupportedUserCurrencies(),

    fxProvider:
      FX_PROVIDER,

    /*
     * Display-currency resolution metadata.
     *
     * These values describe only customer presentation.
     *
     * They must never be interpreted as:
     *
     * - tax-country authority;
     * - shipping destination;
     * - checkout currency;
     * - PayPal currency.
     */
    displayCurrencySource:
      String(
        currencyContext?.source ||
          'BASE_CURRENCY',
      )
        .trim()
        .toUpperCase(),

    displayCurrencyAutomatic:
      currencyContext?.automatic ===
      true,

    displayCurrencyCountryCode:
      String(
        currencyContext
          ?.countryCode ||
          '',
      )
        .trim()
        .toUpperCase(),

    displayCurrencyGeoProvider:
      String(
        currencyContext?.provider ||
          '',
      )
        .trim()
        .slice(0, 100),
  };
}

function normalizeMoneyAmount(value) {
  const amount =
    Number(value);

  if (
    !Number.isFinite(
      amount,
    )
  ) {
    const err =
      new Error(
        'Invalid money amount supplied for display conversion.',
      );

    err.code =
      'USER_CURRENCY_AMOUNT_INVALID';

    throw err;
  }

  return amount;
}

async function convertAmountForUser(
  req,
  amount,
  options = {},
) {
  const normalizedAmount =
    normalizeMoneyAmount(
      amount,
    );

  const fromCurrency =
    normalizeCurrencyCode(
      options.fromCurrency ||
        getBaseCurrency(),
    );

  const toCurrency =
    normalizeCurrencyCode(
      options.toCurrency ||
        getUserCurrency(req),
    );

  if (
    !isSupportedUserCurrency(
      toCurrency,
    )
  ) {
    const err =
      new Error(
        `Unsupported display currency: ${toCurrency}`,
      );

    err.code =
      'USER_CURRENCY_NOT_SUPPORTED';

    throw err;
  }

  const converted =
    await convertMoneyAmount(
      normalizedAmount,
      fromCurrency,
      toCurrency,
    );

  const rate =
    Number(
      converted?.fx?.rate ??
        (
          fromCurrency ===
          toCurrency
            ? 1
            : NaN
        ),
    );

  if (
    !Number.isFinite(
      rate,
    ) ||
    rate <= 0
  ) {
    const err =
      new Error(
        `Invalid display FX rate for ${fromCurrency}->${toCurrency}.`,
      );

    err.code =
      'USER_CURRENCY_RATE_INVALID';

    throw err;
  }

  const currencyDetails =
    getSupportedUserCurrency(
      toCurrency,
    );

  const displayDecimalsRaw =
    Number(
      currencyDetails?.decimals,
    );

  const displayDecimals =
    Number.isInteger(
      displayDecimalsRaw,
    ) &&
    displayDecimalsRaw >= 0 &&
    displayDecimalsRaw <= 4
      ? displayDecimalsRaw
      : 2;

  const displayValue =
    Number(
      (
        normalizedAmount *
        rate
      ).toFixed(
        displayDecimals,
      ),
    );

  return {
    /*
     * BASE_CURRENCY remains Kasyora's authoritative
     * accounting amount.
     */
    baseValue:
      Number(
        normalizedAmount.toFixed(
          2,
        ),
      ),

    baseCurrency:
      fromCurrency,

    /*
     * Display rounding follows the selected currency.
     *
     * Examples:
     *
     * JPY -> 0 decimals
     * USD -> 2 decimals
     * KWD -> 3 decimals
     */
    displayValue,

    displayCurrency:
      toCurrency,

    fx:
      converted.fx ||
      null,
  };
}

/*
 * Convert several amounts using one FX-rate lookup.
 *
 * This remains preferable for pages containing many products
 * because it avoids performing a separate FX request for every
 * displayed product amount.
 */
async function convertAmountsForUser(
  req,
  amounts,
  options = {},
) {
  const source =
    Array.isArray(amounts)
      ? amounts
      : [];

  const normalizedAmounts =
    source.map(
      normalizeMoneyAmount,
    );

  const fromCurrency =
    normalizeCurrencyCode(
      options.fromCurrency ||
        getBaseCurrency(),
    );

  const toCurrency =
    normalizeCurrencyCode(
      options.toCurrency ||
        getUserCurrency(req),
    );

  if (
    !isSupportedUserCurrency(
      toCurrency,
    )
  ) {
    const err =
      new Error(
        `Unsupported display currency: ${toCurrency}`,
      );

    err.code =
      'USER_CURRENCY_NOT_SUPPORTED';

    throw err;
  }

  /*
   * Get one conversion result for one unit.
   *
   * The FX utility already caches and deduplicates the lookup.
   */
  const unitConversion =
    await convertMoneyAmount(
      1,
      fromCurrency,
      toCurrency,
    );

  const rate =
    Number(
      unitConversion?.fx?.rate ??
        (
          fromCurrency ===
          toCurrency
            ? 1
            : NaN
        ),
    );

  if (
    !Number.isFinite(
      rate,
    ) ||
    rate <= 0
  ) {
    const err =
      new Error(
        `Invalid display FX rate for ${fromCurrency}->${toCurrency}.`,
      );

    err.code =
      'USER_CURRENCY_RATE_INVALID';

    throw err;
  }

  /*
   * Display rounding follows the selected display currency
   * rather than assuming two decimal places.
   *
   * Examples:
   *
   * JPY -> 0 decimals
   * USD -> 2 decimals
   * KWD -> 3 decimals
   */
  const currencyDetails =
    getSupportedUserCurrency(
      toCurrency,
    );

  const displayDecimalsRaw =
    Number(
      currencyDetails?.decimals,
    );

  const displayDecimals =
    Number.isInteger(
      displayDecimalsRaw,
    ) &&
    displayDecimalsRaw >= 0 &&
    displayDecimalsRaw <= 4
      ? displayDecimalsRaw
      : 2;

  return {
    baseCurrency:
      fromCurrency,

    displayCurrency:
      toCurrency,

    rate,

    values:
      normalizedAmounts.map(
        (amount) =>
          Number(
            (
              amount *
              rate
            ).toFixed(
              displayDecimals,
            ),
          ),
      ),

    fx: {
      ...(
        unitConversion.fx ||
        {}
      ),

      rate,

      from:
        fromCurrency,

      to:
        toCurrency,
    },
  };
}

function saveSession(req) {
  return new Promise(
    (resolve, reject) => {
      if (
        !req?.session ||
        typeof req.session.save !==
          'function'
      ) {
        resolve();
        return;
      }

      req.session.save(
        (err) => {
          if (err) {
            reject(err);
            return;
          }

          resolve();
        },
      );
    },
  );
}

module.exports = {
  getBaseCurrency,

  /*
   * Newly exported complete resolution context.
   *
   * Existing callers do not need to use this unless they need
   * to know whether the currency came from customer selection,
   * GeoIP or BASE_CURRENCY.
   */
  getUserCurrencyContext,

  getUserCurrency,

  setUserCurrency,

  clearUserCurrency,

  getUserCurrencyDetails,

  getCurrencyViewData,

  convertAmountForUser,

  convertAmountsForUser,

  saveSession,
};