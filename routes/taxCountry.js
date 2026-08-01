// routes/taxCountry.js
'use strict';

const express = require('express');

const COUNTRIES = require('../utils/countries');

const { TAX_COUNTRY_SOURCES, normalizeCountryCode } = require('../utils/tax/taxConfig');

const { TAX_COUNTRY_SESSION_KEY } = require('../middleware/taxCountry');

const router = express.Router();

/*
 * Kasyora delivery-country selection route
 * =========================================
 *
 * This route stores only the customer's provisional delivery-country
 * selection.
 *
 * It does not:
 *
 * - calculate VAT;
 * - alter product prices;
 * - alter cart totals;
 * - alter PayPal totals;
 * - create or update orders;
 * - make GeoIP authoritative;
 * - apply any VAT to the CJ department.
 *
 * The validated Internal checkout shipping address will later override
 * this session selection and become authoritative for VAT.
 */

/*
 * Build an immutable lookup from Kasyora's existing country list.
 *
 * utils/countries.js supplies objects in this structure:
 *
 * {
 *   code: 'ZA',
 *   name: 'South Africa'
 * }
 */
const COUNTRY_BY_CODE = (() => {
  const lookup = new Map();

  const list = Array.isArray(COUNTRIES) ? COUNTRIES : [];

  for (const country of list) {
    const code = normalizeCountryCode(country?.code, '');

    const name = String(country?.name || '')
      .trim()
      .slice(0, 200);

    if (!code || !name || lookup.has(code)) {
      continue;
    }

    lookup.set(
      code,
      Object.freeze({
        code,
        name,
      }),
    );
  }

  return lookup;
})();

/*
 * Limit untrusted text before using it in an error response.
 */
function safeString(value, maxLength = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

/*
 * Determine whether the caller expects JSON.
 *
 * This allows the same route to support:
 *
 * - a normal server-rendered HTML form;
 * - a later JavaScript country selector.
 */
function wantsJson(req) {
  const acceptedType = safeString(req.get('accept'), 500).toLowerCase();

  const requestedWith = safeString(req.get('x-requested-with'), 100).toLowerCase();

  return (
    req.is('application/json') ||
    acceptedType.includes('application/json') ||
    requestedWith === 'xmlhttprequest'
  );
}

/*
 * Validate a returnTo value as a local application path.
 *
 * Accepted examples:
 *
 * /store
 * /store/shop?department=internal
 * /store/product/ABC123#singleProductDetails
 *
 * Rejected examples:
 *
 * https://attacker.example
 * //attacker.example
 * javascript:alert(1)
 * \attacker.example
 */
function safeLocalReturnTo(value, fallback = '/store') {
  const candidate = safeString(value, 2000);

  const containsControlCharacter = Array.from(candidate).some((character) => {
    const characterCode = character.charCodeAt(0);

    return characterCode <= 31 || characterCode === 127;
  });

  if (
    !candidate ||
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.startsWith('/\\') ||
    candidate.includes('\\') ||
    containsControlCharacter
  ) {
    return fallback;
  }

  try {
    /*
     * Parse against a fixed local origin so relative application
     * paths can be checked without trusting APP_URL or request Host.
     */
    const parsed = new URL(candidate, 'https://kasyora.local');

    if (parsed.origin !== 'https://kasyora.local') {
      return fallback;
    }

    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return fallback;
  }
}

/*
 * Resolve a country from the existing authoritative Kasyora list.
 */
function getSupportedCountry(value) {
  const countryCode = normalizeCountryCode(value, '');

  if (!countryCode) {
    return null;
  }

  return COUNTRY_BY_CODE.get(countryCode) || null;
}

/*
 * Save the session before returning a response.
 *
 * Explicit saving prevents a fast redirect from racing against
 * asynchronous session-store persistence.
 */
function saveSession(req) {
  return new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.save !== 'function') {
      const error = new Error('A valid customer session is required.');

      error.code = 'TAX_COUNTRY_SESSION_UNAVAILABLE';

      reject(error);
      return;
    }

    req.session.save((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/*
 * Invalidate provisional server-side values derived from the previous
 * country.
 *
 * Some of these fields will be introduced later in the tax patch.
 * Deleting a missing property is harmless.
 *
 * This does not clear either cart.
 */
function invalidateCountryDependentSessionData(req) {
  if (!req.session) {
    return;
  }

  /*
   * Internal Kasyora provisional/final tax quote keys.
   */
  delete req.session.internalTaxQuote;

  delete req.session.internalCheckoutTaxQuote;

  delete req.session.internalCheckoutQuote;

  /*
   * Do not delete:
   *
   * req.session.cart
   * req.session.cjCart
   * req.session.userCurrency
   *
   * Country selection must not remove products or change the
   * customer's selected display currency.
   */
}

/*
 * POST /tax-country/select
 *
 * Accepted body:
 *
 * {
 *   countryCode: 'ZA',
 *   returnTo: '/store'
 * }
 */
router.post('/select', async (req, res) => {
  try {
    const requestedCountry =
      req.body?.countryCode ?? req.body?.country ?? req.body?.deliveryCountry;

    const country = getSupportedCountry(requestedCountry);

    if (!country) {
      const message = 'Please select a valid supported delivery country.';

      if (wantsJson(req)) {
        return res.status(400).json({
          success: false,

          code: 'TAX_COUNTRY_INVALID',

          message,
        });
      }

      req.flash?.('error', message);

      return res.redirect(safeLocalReturnTo(req.body?.returnTo, '/store'));
    }

    if (!req.session) {
      const message = 'Your session is unavailable. Please refresh the page and try again.';

      if (wantsJson(req)) {
        return res.status(503).json({
          success: false,

          code: 'TAX_COUNTRY_SESSION_UNAVAILABLE',

          message,
        });
      }

      return res.status(503).send(message);
    }

    /*
     * Store a small normalized snapshot only.
     *
     * Never store the complete submitted body.
     */
    req.session[TAX_COUNTRY_SESSION_KEY] = {
      countryCode: country.code,

      countryName: country.name,

      source: TAX_COUNTRY_SOURCES.CUSTOMER_SELECTION,

      selectedAt: new Date().toISOString(),
    };

    invalidateCountryDependentSessionData(req);

    await saveSession(req);

    const redirectTo = safeLocalReturnTo(req.body?.returnTo, '/store');

    if (wantsJson(req)) {
      return res.json({
        success: true,

        message: 'Delivery country updated.',

        country: {
          code: country.code,

          name: country.name,
        },

        provisional: true,
        authoritative: false,

        redirectTo,
      });
    }

    req.flash?.(
      'success',
      'Delivery country updated to ' +
        country.name +
        '. Final tax will be confirmed from the shipping address at checkout.',
    );

    return res.redirect(redirectTo);
  } catch (error) {
    console.error(
      '[tax] Delivery-country selection failed:',
      error?.stack || error?.message || error,
    );

    const message = 'The delivery country could not be updated. Please try again.';

    if (wantsJson(req)) {
      return res.status(500).json({
        success: false,

        code: safeString(error?.code || 'TAX_COUNTRY_SELECTION_FAILED', 100),

        message,
      });
    }

    req.flash?.('error', message);

    return res.redirect(safeLocalReturnTo(req.body?.returnTo, '/store'));
  }
});

/*
 * POST /tax-country/reset
 *
 * Removes only the explicit customer selection.
 *
 * The next request will use:
 *
 * trusted GeoIP
 * → configured default
 */
router.post('/reset', async (req, res) => {
  try {
    if (req.session) {
      delete req.session[TAX_COUNTRY_SESSION_KEY];

      invalidateCountryDependentSessionData(req);

      await saveSession(req);
    }

    const redirectTo = safeLocalReturnTo(req.body?.returnTo, '/store');

    if (wantsJson(req)) {
      return res.json({
        success: true,

        message: 'Delivery-country selection reset.',

        redirectTo,
      });
    }

    req.flash?.('success', 'Delivery-country selection reset.');

    return res.redirect(redirectTo);
  } catch (error) {
    console.error('[tax] Delivery-country reset failed:', error?.stack || error?.message || error);

    const message = 'The delivery-country selection could not be reset.';

    if (wantsJson(req)) {
      return res.status(500).json({
        success: false,

        code: 'TAX_COUNTRY_RESET_FAILED',

        message,
      });
    }

    req.flash?.('error', message);

    return res.redirect(safeLocalReturnTo(req.body?.returnTo, '/store'));
  }
});

module.exports = router;

module.exports.COUNTRY_BY_CODE = COUNTRY_BY_CODE;

module.exports.safeLocalReturnTo = safeLocalReturnTo;

module.exports.getSupportedCountry = getSupportedCountry;
