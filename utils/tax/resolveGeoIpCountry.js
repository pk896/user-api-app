// utils/tax/resolveGeoIpCountry.js
'use strict';

const {
  normalizeCountryCode,
} = require('./taxConfig');

/*
 * Kasyora provisional GeoIP-country resolver
 * ==========================================
 *
 * This helper has no third-party Node.js GeoIP dependency.
 *
 * GeoIP is used only as a provisional storefront convenience.
 * It must never become authoritative for:
 *
 * - checkout VAT;
 * - PayPal totals;
 * - completed orders;
 * - invoices;
 * - receipts;
 * - refunds.
 *
 * Priority elsewhere in the application remains:
 *
 * 1. Validated checkout shipping address
 * 2. Customer-selected delivery country
 * 3. Provisional GeoIP country
 * 4. Configured default country
 */

/*
 * Country headers may be supplied by a trusted CDN or hosting proxy.
 *
 * Examples:
 *
 * Cloudflare:
 * CF-IPCountry
 *
 * AWS CloudFront:
 * CloudFront-Viewer-Country
 *
 * Vercel:
 * X-Vercel-IP-Country
 *
 * These headers must not be trusted unless the deployment owner has
 * explicitly enabled them and the trusted proxy removes any matching
 * browser-supplied header before forwarding the request.
 */
const TRUST_GEO_COUNTRY_HEADERS =
  String(
    process.env.TRUST_GEO_COUNTRY_HEADERS ||
    'false',
  )
    .trim()
    .toLowerCase() === 'true';

/*
 * Normalize a possible request-header value.
 *
 * Express header values may be strings or arrays.
 */
function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return String(value[0] || '')
      .trim();
  }

  return String(value || '')
    .split(',')[0]
    .trim();
}

/*
 * Some providers use special values when no country can be resolved.
 *
 * Cloudflare examples include:
 *
 * XX = unknown
 * T1 = Tor network
 *
 * Neither is an ISO 3166-1 alpha-2 delivery country that should drive
 * Kasyora's provisional tax presentation.
 */
function normalizeGeoCountryHeader(value) {
  const rawValue =
    firstHeaderValue(value)
      .toUpperCase();

  if (
    !rawValue ||
    rawValue === 'XX' ||
    rawValue === 'T1'
  ) {
    return '';
  }

  return normalizeCountryCode(
    rawValue,
    '',
  );
}

/*
 * Find a country supplied by an explicitly trusted infrastructure
 * provider.
 *
 * We intentionally do not read X-Forwarded-For and perform a local
 * database lookup. This avoids vulnerable GeoIP dependencies and
 * avoids treating a browser-provided header as authoritative.
 */
function resolveTrustedHeaderCountry(req) {
  if (
    !TRUST_GEO_COUNTRY_HEADERS
  ) {
    return {
      success: false,
      countryCode: '',
      provider: '',
    };
  }

  const candidates = [
    {
      provider: 'cloudflare',
      value:
        req?.headers?.['cf-ipcountry'],
    },
    {
      provider: 'aws-cloudfront',
      value:
        req?.headers?.[
          'cloudfront-viewer-country'
        ],
    },
    {
      provider: 'vercel',
      value:
        req?.headers?.[
          'x-vercel-ip-country'
        ],
    },
  ];

  for (const candidate of candidates) {
    const countryCode =
      normalizeGeoCountryHeader(
        candidate.value,
      );

    if (countryCode) {
      return {
        success: true,
        countryCode,
        provider:
          candidate.provider,
      };
    }
  }

  return {
    success: false,
    countryCode: '',
    provider: '',
  };
}

/*
 * Resolve a provisional country from trusted request infrastructure.
 *
 * An unsuccessful result is expected and safe.
 *
 * The later tax-country middleware will fall back to:
 *
 * DEFAULT_TAX_COUNTRY_CODE
 *
 * until the customer selects a delivery country.
 */
function resolveGeoIpCountry(req) {
  const trustedHeaderResult =
    resolveTrustedHeaderCountry(req);

  return {
    success:
      trustedHeaderResult.success,

    countryCode:
      trustedHeaderResult.countryCode,

    provider:
      trustedHeaderResult.provider,
  };
}

module.exports = {
  firstHeaderValue,
  normalizeGeoCountryHeader,
  resolveTrustedHeaderCountry,
  resolveGeoIpCountry,
};