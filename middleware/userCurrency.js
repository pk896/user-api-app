// middleware/userCurrency.js
'use strict';

const {
  getCurrencyViewData,
} = require('../utils/currency/userCurrency');

const {
  convertMoneyAmount,
} = require('../utils/fx/getFxRate');

/*
 * Resolve one display rate per request.
 *
 * Product, cart, checkout and accounting amounts remain stored in
 * BASE_CURRENCY. This rate is used only to present those amounts in
 * the customer's selected display currency.
 */
async function userCurrencyMiddleware(req, res, next) {
  try {
    const currencyData = getCurrencyViewData(req);

    const baseCurrency =
      currencyData.baseCurrency;

    const requestedCurrency =
      currencyData.userCurrency;

    let displayCurrency =
      requestedCurrency;

    let displayRate = 1;
    let displayFx = null;
    let currencyConversionAvailable = true;
    let currencyConversionMessage = '';

    try {
      const conversion = await convertMoneyAmount(
        1,
        baseCurrency,
        requestedCurrency,
      );

      const rate = Number(
        conversion?.fx?.rate ??
        conversion?.value ??
        1,
      );

      if (!Number.isFinite(rate) || rate <= 0) {
        throw new Error(
          `Invalid display rate for ${baseCurrency}->${requestedCurrency}`,
        );
      }

      displayRate = rate;
      displayFx = conversion.fx || null;
    } catch (error) {
      /*
       * Never display a USD amount with a ZAR/EUR/etc. currency label.
       *
       * If FX is unavailable, safely fall back to BASE_CURRENCY for
       * this response. The user's saved preference remains in the
       * session and can work again when the provider recovers.
       */
      console.warn(
        `[userCurrency] Display conversion unavailable for ` +
        `${baseCurrency}->${requestedCurrency}:`,
        error?.message || error,
      );

      displayCurrency = baseCurrency;
      displayRate = 1;
      displayFx = null;
      currencyConversionAvailable = false;
      currencyConversionMessage =
        `${requestedCurrency} prices are temporarily unavailable. ` +
        `Prices are currently shown in ${baseCurrency}.`;
    }

    const requestCurrencyData = {
      ...currencyData,

      requestedCurrency,
      displayCurrency,
      displayRate,
      displayFx,
      currencyConversionAvailable,
      currencyConversionMessage,
    };

    /*
     * Server routes and APIs can read the same resolved context.
     */
    req.currency = requestCurrencyData;

    /*
     * Globally available to EJS templates.
     */
    res.locals.baseCurrency =
      baseCurrency;

    res.locals.userCurrency =
      requestedCurrency;

    res.locals.requestedCurrency =
      requestedCurrency;

    res.locals.displayCurrency =
      displayCurrency;

    res.locals.displayRate =
      displayRate;

    res.locals.displayFx =
      displayFx;

    res.locals.currencyConversionAvailable =
      currencyConversionAvailable;

    res.locals.currencyConversionMessage =
      currencyConversionMessage;

    res.locals.userCurrencyDetails =
      currencyData.userCurrencyDetails;

    res.locals.supportedUserCurrencies =
      currencyData.supportedUserCurrencies;

    res.locals.fxProvider =
      currencyData.fxProvider;

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = userCurrencyMiddleware;