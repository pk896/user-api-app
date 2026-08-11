// routes/currency.js
'use strict';

const express = require('express');

const {
  isSupportedUserCurrency,
  normalizeCurrencyCode,
  getSupportedUserCurrencies,
  getPopularUserCurrencies,
} = require('../utils/currency/currencyConfig');

const {
  getBaseCurrency,
  getUserCurrency,
  getUserCurrencyContext,
  setUserCurrency,
  clearUserCurrency,
  saveSession,
} = require('../utils/currency/userCurrency');

const router = express.Router();

function safeReturnPath(value) {
  const raw = String(value || '').trim();

  /*
   * Only allow a local application path.
   * This prevents an open-redirect vulnerability.
   */
  if (
    !raw ||
    !raw.startsWith('/') ||
    raw.startsWith('//') ||
    raw.includes('\\') ||
    raw.includes('\r') ||
    raw.includes('\n')
  ) {
    return '/store';
  }

  return raw.slice(0, 1000);
}

/*
 * GET /currency
 *
 * Useful for browser JavaScript and future mobile clients.
 *
 * The resolved display currency may come from:
 *
 * 1. explicit customer selection;
 * 2. trusted GeoIP;
 * 3. BASE_CURRENCY fallback.
 */
router.get('/', (req, res) => {
  const supportedCurrencies = getSupportedUserCurrencies();

  const currencyContext = getUserCurrencyContext(req);

  const userCurrency = getUserCurrency(req);

  /*
   * This response contains customer-specific currency state.
   *
   * Do not allow browsers, CDNs or shared intermediaries
   * to cache one customer's resolved currency.
   */
  res.set('Cache-Control', 'no-store');

  return res.json({
    ok: true,

    baseCurrency: getBaseCurrency(),

    /*
     * Preserve the existing API field.
     *
     * userCurrency now means the resolved customer-facing
     * currency, not necessarily a session-stored preference.
     */
    userCurrency,

    currencySource: String(currencyContext?.source || 'BASE_CURRENCY')
      .trim()
      .toUpperCase(),

    automatic: currencyContext?.automatic === true,

    countryCode: String(currencyContext?.countryCode || '')
      .trim()
      .toUpperCase(),

    geoProvider: String(currencyContext?.provider || '')
      .trim()
      .slice(0, 100),

    supportedCurrencyCount: supportedCurrencies.length,

    popularCurrencies: getPopularUserCurrencies(),

    supportedCurrencies,
  });
});

/*
 * POST /currency/select
 *
 * Accepts form data or JSON:
 *
 * {
 *   "currency": "ZAR",
 *   "returnTo": "/store"
 * }
 */
router.post('/select', async (req, res) => {
  try {
    const currency = normalizeCurrencyCode(req.body?.currency);

    if (!isSupportedUserCurrency(currency)) {
      return res.status(400).json({
        ok: false,
        code: 'USER_CURRENCY_NOT_SUPPORTED',
        message: 'The selected currency is not supported.',
      });
    }

    const selectedCurrency = setUserCurrency(req, currency);

    await saveSession(req);

    const returnTo = safeReturnPath(req.body?.returnTo || req.get('referer') || '/store');

    const acceptsJson = String(req.get('accept') || '')
      .toLowerCase()
      .includes('application/json');

    if (acceptsJson || req.is('application/json')) {
      return res.json({
        ok: true,

        baseCurrency: getBaseCurrency(),

        userCurrency: selectedCurrency,

        currencySource: 'CUSTOMER_SELECTION',

        automatic: false,

        countryCode: '',

        geoProvider: '',

        returnTo,
      });
    }

    return res.redirect(303, returnTo);
  } catch (err) {
    console.error('[currency] Failed to select currency:', err?.stack || err);

    return res.status(500).json({
      ok: false,
      code: err?.code || 'USER_CURRENCY_SELECTION_FAILED',

      message: 'The currency preference could not be saved.',
    });
  }
});

/*
 * POST /currency/reset
 *
 * Removes only the customer's explicit display-currency
 * selection.
 *
 * After reset, Kasyora returns to automatic resolution:
 *
 * trusted GeoIP country
 * -> preferred display currency
 * -> BASE_CURRENCY fallback
 *
 * No GeoIP-derived currency is written into the session.
 */
router.post('/reset', async (req, res) => {
  try {
    clearUserCurrency(req);

    await saveSession(req);

    /*
     * Re-resolve immediately after the explicit session
     * preference has been removed.
     *
     * This may now resolve to:
     *
     * - GEO_IP; or
     * - BASE_CURRENCY.
     */
    const currencyContext = getUserCurrencyContext(req);

    const userCurrency = getUserCurrency(req);

    const returnTo = safeReturnPath(req.body?.returnTo || req.get('referer') || '/store');

    const acceptsJson = String(req.get('accept') || '')
      .toLowerCase()
      .includes('application/json');

    if (acceptsJson || req.is('application/json')) {
      return res.json({
        ok: true,

        baseCurrency: getBaseCurrency(),

        userCurrency,

        currencySource: String(currencyContext?.source || 'BASE_CURRENCY')
          .trim()
          .toUpperCase(),

        automatic: currencyContext?.automatic === true,

        countryCode: String(currencyContext?.countryCode || '')
          .trim()
          .toUpperCase(),

        geoProvider: String(currencyContext?.provider || '')
          .trim()
          .slice(0, 100),

        returnTo,
      });
    }

    return res.redirect(303, returnTo);
  } catch (err) {
    console.error('[currency] Failed to reset currency:', err?.stack || err);

    return res.status(500).json({
      ok: false,

      code: 'USER_CURRENCY_RESET_FAILED',

      message: 'The currency preference could not be reset.',
    });
  }
});

module.exports = router;
