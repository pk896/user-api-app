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

function getBaseCurrency() {
  const currency = normalizeCurrencyCode(
    process.env.BASE_CURRENCY || 'USD',
  );

  return /^[A-Z]{3}$/.test(currency)
    ? currency
    : 'USD';
}

function getUserCurrency(req) {
  const baseCurrency = getBaseCurrency();

  const sessionCurrency = normalizeCurrencyCode(
    req?.session?.userCurrency,
  );

  if (isSupportedUserCurrency(sessionCurrency)) {
    return sessionCurrency;
  }

  /*
   * BASE_CURRENCY is the fallback only when it is also an enabled
   * customer-facing currency.
   *
   * Kasyora currently uses USD, which is enabled.
   */
  if (isSupportedUserCurrency(baseCurrency)) {
    return baseCurrency;
  }

  return 'USD';
}

function setUserCurrency(req, currency) {
  if (!req?.session) {
    const err = new Error(
      'A session is required before selecting a currency.',
    );

    err.code = 'USER_CURRENCY_SESSION_REQUIRED';
    throw err;
  }

  const normalized = normalizeCurrencyCode(currency);

  if (!isSupportedUserCurrency(normalized)) {
    const err = new Error(
      `Unsupported customer currency: ${currency}`,
    );

    err.code = 'USER_CURRENCY_NOT_SUPPORTED';
    throw err;
  }

  req.session.userCurrency = normalized;

  return normalized;
}

function clearUserCurrency(req) {
  if (req?.session) {
    delete req.session.userCurrency;
  }
}

function getUserCurrencyDetails(req) {
  const currency = getUserCurrency(req);

  return (
    getSupportedUserCurrency(currency) ||
    getSupportedUserCurrency('USD')
  );
}

function getCurrencyViewData(req) {
  const baseCurrency = getBaseCurrency();
  const userCurrency = getUserCurrency(req);
  const userCurrencyDetails = getUserCurrencyDetails(req);

  return {
    baseCurrency,
    userCurrency,

    /*
     * displayCurrency is the clearer name for templates.
     * userCurrency is retained because it describes where the
     * value originated.
     */
    displayCurrency: userCurrency,

    userCurrencyDetails,

    supportedUserCurrencies:
      getSupportedUserCurrencies(),

    fxProvider: FX_PROVIDER,
  };
}

function normalizeMoneyAmount(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    const err = new Error(
      'Invalid money amount supplied for display conversion.',
    );

    err.code = 'USER_CURRENCY_AMOUNT_INVALID';
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
    normalizeMoneyAmount(amount);

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

  if (!isSupportedUserCurrency(toCurrency)) {
    const err = new Error(
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
        fromCurrency === toCurrency
          ? 1
          : NaN
      ),
    );

  if (
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    const err = new Error(
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
        normalizedAmount.toFixed(2),
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
      converted.fx || null,
  };
}

/*
 * Converts several amounts using one rate lookup.
 *
 * This is better for pages containing many products because it does
 * not call convertMoneyAmount separately for every product.
 */
async function convertAmountsForUser(
  req,
  amounts,
  options = {},
) {
  const source = Array.isArray(amounts)
    ? amounts
    : [];

  const normalizedAmounts = source.map(
    normalizeMoneyAmount,
  );

  const fromCurrency = normalizeCurrencyCode(
    options.fromCurrency || getBaseCurrency(),
  );

  const toCurrency =
    normalizeCurrencyCode(
      options.toCurrency ||
      getUserCurrency(req),
    );

  if (!isSupportedUserCurrency(toCurrency)) {
    const err = new Error(
      `Unsupported display currency: ${toCurrency}`,
    );

    err.code =
      'USER_CURRENCY_NOT_SUPPORTED';

    throw err;
  }

  /*
  * Get one conversion result for 1 unit.
  * Your FX utility caches and deduplicates this lookup.
  */
  const unitConversion =
    await convertMoneyAmount(
      1,
      fromCurrency,
      toCurrency,
    );

  const rate = Number(
    unitConversion?.fx?.rate ??
      (
        fromCurrency === toCurrency
          ? 1
          : NaN
      ),
  );

  if (!Number.isFinite(rate) || rate <= 0) {
    const err = new Error(
      `Invalid display FX rate for ${fromCurrency}->${toCurrency}.`,
    );

    err.code = 'USER_CURRENCY_RATE_INVALID';
    throw err;
  }

  /*
  * Display rounding must follow the selected display
  * currency rather than assuming two decimal places.
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
      ...(unitConversion.fx || {}),
      rate,
      from: fromCurrency,
      to: toCurrency,
    },
  };
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (
      !req?.session ||
      typeof req.session.save !== 'function'
    ) {
      resolve();
      return;
    }

    req.session.save((err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

module.exports = {
  getBaseCurrency,
  getUserCurrency,
  setUserCurrency,
  clearUserCurrency,
  getUserCurrencyDetails,
  getCurrencyViewData,
  convertAmountForUser,
  convertAmountsForUser,
  saveSession,
};
