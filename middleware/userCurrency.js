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
 * BASE_CURRENCY.
 *
 * This middleware determines only:
 *
 * - the requested customer display currency;
 * - the FX rate used for this response;
 * - the currency that can safely be rendered;
 * - presentation-only currency-source metadata.
 */
async function userCurrencyMiddleware(
  req,
  res,
  next,
) {
  try {
    const currencyData =
      getCurrencyViewData(
        req,
      );

    const baseCurrency =
      currencyData.baseCurrency;

    /*
     * requestedCurrency is the currency selected by the
     * display-currency resolution policy:
     *
     * CUSTOMER_SELECTION
     * -> GEO_IP
     * -> BASE_CURRENCY
     */
    const requestedCurrency =
      currencyData.userCurrency;

    const requestedCurrencySource =
      String(
        currencyData
          .displayCurrencySource ||
          'BASE_CURRENCY',
      )
        .trim()
        .toUpperCase();

    const requestedCurrencyAutomatic =
      currencyData
        .displayCurrencyAutomatic ===
      true;

    const requestedCurrencyCountryCode =
      String(
        currencyData
          .displayCurrencyCountryCode ||
          '',
      )
        .trim()
        .toUpperCase();

    const requestedCurrencyGeoProvider =
      String(
        currencyData
          .displayCurrencyGeoProvider ||
          '',
      )
        .trim()
        .slice(0, 100);

    /*
     * displayCurrency is the currency that will actually be
     * rendered on this HTTP response.
     *
     * Usually:
     *
     * requestedCurrency === displayCurrency
     *
     * If FX conversion fails:
     *
     * displayCurrency = BASE_CURRENCY
     */
    let displayCurrency =
      requestedCurrency;

    let displayRate = 1;

    let displayFx = null;

    let currencyConversionAvailable =
      true;

    let currencyConversionMessage =
      '';

    try {
      const conversion =
        await convertMoneyAmount(
          1,
          baseCurrency,
          requestedCurrency,
        );

      const rate =
        Number(
          conversion?.fx?.rate ??
            (
              baseCurrency ===
              requestedCurrency
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
        throw new Error(
          `Invalid display rate for ${baseCurrency}->${requestedCurrency}`,
        );
      }

      displayRate =
        rate;

      displayFx =
        conversion.fx ||
        null;
    } catch (error) {
      /*
       * Never display a BASE_CURRENCY amount with a
       * ZAR/EUR/JPY/etc. label.
       *
       * If FX is unavailable, safely use BASE_CURRENCY for this
       * response.
       *
       * IMPORTANT:
       *
       * We do not clear req.session.userCurrency.
       *
       * A manual preference therefore survives a temporary FX
       * outage and can work again automatically when the provider
       * recovers.
       */
      console.warn(
        '[userCurrency] Display conversion unavailable for ' +
          `${baseCurrency}->${requestedCurrency}:`,
        error?.message ||
          error,
      );

      displayCurrency =
        baseCurrency;

      displayRate =
        1;

      displayFx =
        null;

      currencyConversionAvailable =
        false;

      currencyConversionMessage =
        `${requestedCurrency} prices are temporarily unavailable. ` +
        `Prices are currently shown in ${baseCurrency}.`;
    }

    /*
     * Determine the source of the currency actually rendered.
     *
     * When conversion succeeds, it has the same source as the
     * requested currency.
     *
     * When conversion fails, the actual rendered currency is
     * BASE_CURRENCY regardless of whether the original request
     * came from:
     *
     * - CUSTOMER_SELECTION;
     * - GEO_IP;
     * - BASE_CURRENCY.
     */
    const displayCurrencySource =
      currencyConversionAvailable
        ? requestedCurrencySource
        : 'BASE_CURRENCY';

    /*
     * Automatic refers to the requested currency resolution.
     *
     * Manual customer selection:
     *
     * false
     *
     * GeoIP or BASE_CURRENCY automatic resolution:
     *
     * true
     *
     * We preserve this separately from displayCurrencySource so
     * an FX fallback does not erase how the request was originally
     * resolved.
     */
    const displayCurrencyAutomatic =
      requestedCurrencyAutomatic;

    /*
     * GeoIP metadata belongs to the requested currency decision.
     *
     * If FX failed, the values are still useful diagnostically,
     * but they must not be interpreted as saying BASE_CURRENCY
     * itself came from GeoIP.
     */
    const displayCurrencyCountryCode =
      requestedCurrencyCountryCode;

    const displayCurrencyGeoProvider =
      requestedCurrencyGeoProvider;

    /*
     * Resolve metadata for the currency that will actually be
     * rendered on this response.
     *
     * Usually:
     *
     * requestedCurrency === displayCurrency
     *
     * During an FX-provider failure:
     *
     * requestedCurrency may remain INR/JPY/ZAR/etc.
     * displayCurrency safely becomes BASE_CURRENCY.
     */
    const displayCurrencyDetails =
      currencyData
        .supportedUserCurrencies
        .find(
          (currency) =>
            currency.code ===
            displayCurrency,
        ) || {
        code:
          displayCurrency,

        name:
          displayCurrency,

        symbol:
          displayCurrency,

        locale:
          'en',

        decimals:
          2,

        popular:
          false,
      };

    const requestCurrencyData = {
      ...currencyData,

      /*
       * Requested presentation state
       * ============================
       *
       * This describes what the normal currency-resolution policy
       * selected before FX availability was tested.
       */
      requestedCurrency,

      requestedCurrencySource,

      requestedCurrencyAutomatic,

      requestedCurrencyCountryCode,

      requestedCurrencyGeoProvider,

      /*
       * Actual response presentation state
       * ==================================
       *
       * These values are safe to use when rendering money on the
       * current response.
       */
      displayCurrency,

      displayCurrencySource,

      displayCurrencyAutomatic,

      displayCurrencyCountryCode,

      displayCurrencyGeoProvider,

      displayCurrencyDetails,

      displayRate,

      displayFx,

      currencyConversionAvailable,

      currencyConversionMessage,
    };

    /*
     * Server routes and APIs can read the same resolved context.
     */
    req.currency =
      requestCurrencyData;

    /*
     * Globally available to EJS templates.
     */
    res.locals.baseCurrency =
      baseCurrency;

    /*
     * Preserve existing meaning:
     *
     * userCurrency / requestedCurrency represent the currency
     * Kasyora attempted to display for this customer.
     */
    res.locals.userCurrency =
      requestedCurrency;

    res.locals.requestedCurrency =
      requestedCurrency;

    /*
     * Requested-currency resolution metadata.
     */
    res.locals.requestedCurrencySource =
      requestedCurrencySource;

    res.locals.requestedCurrencyAutomatic =
      requestedCurrencyAutomatic;

    res.locals.requestedCurrencyCountryCode =
      requestedCurrencyCountryCode;

    res.locals.requestedCurrencyGeoProvider =
      requestedCurrencyGeoProvider;

    /*
     * Actual currency rendered for this response.
     */
    res.locals.displayCurrency =
      displayCurrency;

    res.locals.displayCurrencySource =
      displayCurrencySource;

    res.locals.displayCurrencyAutomatic =
      displayCurrencyAutomatic;

    res.locals.displayCurrencyCountryCode =
      displayCurrencyCountryCode;

    res.locals.displayCurrencyGeoProvider =
      displayCurrencyGeoProvider;

    res.locals.displayCurrencyDetails =
      displayCurrencyDetails;

    res.locals.displayRate =
      displayRate;

    res.locals.displayFx =
      displayFx;

    res.locals.currencyConversionAvailable =
      currencyConversionAvailable;

    res.locals.currencyConversionMessage =
      currencyConversionMessage;

    /*
     * Existing shared selector/view data remains available.
     */
    res.locals.userCurrencyDetails =
      currencyData.userCurrencyDetails;

    res.locals.supportedUserCurrencies =
      currencyData
        .supportedUserCurrencies;

    res.locals.fxProvider =
      currencyData.fxProvider;

    return next();
  } catch (error) {
    return next(
      error,
    );
  }
}

module.exports =
  userCurrencyMiddleware;