// routes/currency.js
'use strict';

const express = require('express');

const {
  isSupportedUserCurrency,
  normalizeCurrencyCode,
  getSupportedUserCurrencies,
} = require('../utils/currency/currencyConfig');

const {
  getBaseCurrency,
  getUserCurrency,
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
 */
router.get('/', (req, res) => {
  return res.json({
    ok: true,
    baseCurrency: getBaseCurrency(),
    userCurrency: getUserCurrency(req),
    supportedCurrencies:
      getSupportedUserCurrencies(),
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
    const currency = normalizeCurrencyCode(
      req.body?.currency,
    );

    if (!isSupportedUserCurrency(currency)) {
      return res.status(400).json({
        ok: false,
        code: 'USER_CURRENCY_NOT_SUPPORTED',
        message:
          'The selected currency is not supported.',
      });
    }

    const selectedCurrency = setUserCurrency(
      req,
      currency,
    );

    await saveSession(req);

    const returnTo = safeReturnPath(
      req.body?.returnTo ||
      req.get('referer') ||
      '/store',
    );

    const acceptsJson = String(
      req.get('accept') || '',
    )
      .toLowerCase()
      .includes('application/json');

    if (acceptsJson || req.is('application/json')) {
      return res.json({
        ok: true,
        baseCurrency: getBaseCurrency(),
        userCurrency: selectedCurrency,
        returnTo,
      });
    }

    return res.redirect(303, returnTo);
  } catch (err) {
    console.error(
      '[currency] Failed to select currency:',
      err?.stack || err,
    );

    return res.status(500).json({
      ok: false,
      code:
        err?.code ||
        'USER_CURRENCY_SELECTION_FAILED',

      message:
        'The currency preference could not be saved.',
    });
  }
});

/*
 * POST /currency/reset
 *
 * Removes the customer selection and returns to BASE_CURRENCY.
 */
router.post('/reset', async (req, res) => {
  try {
    clearUserCurrency(req);
    await saveSession(req);

    const returnTo = safeReturnPath(
      req.body?.returnTo ||
      req.get('referer') ||
      '/store',
    );

    const acceptsJson = String(
      req.get('accept') || '',
    )
      .toLowerCase()
      .includes('application/json');

    if (acceptsJson || req.is('application/json')) {
      return res.json({
        ok: true,
        baseCurrency: getBaseCurrency(),
        userCurrency: getUserCurrency(req),
        returnTo,
      });
    }

    return res.redirect(303, returnTo);
  } catch (err) {
    console.error(
      '[currency] Failed to reset currency:',
      err?.stack || err,
    );

    return res.status(500).json({
      ok: false,
      code: 'USER_CURRENCY_RESET_FAILED',
      message:
        'The currency preference could not be reset.',
    });
  }
});

module.exports = router;
