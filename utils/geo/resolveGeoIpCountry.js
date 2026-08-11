// utils/geo/resolveGeoIpCountry.js
'use strict';

/*
 * Kasyora trusted GeoIP-country resolver
 * ======================================
 *
 * This is a neutral infrastructure helper.
 *
 * Its only responsibility is to determine the visitor's
 * provisional country from trusted hosting/CDN headers.
 *
 * It does not know about:
 *
 * - VAT;
 * - tax treatment;
 * - delivery-country selection;
 * - display currency;
 * - product prices;
 * - carts;
 * - checkout;
 * - PayPal;
 * - orders.
 *
 * Tax and currency flows may consume the country result
 * independently and apply their own separate business rules.
 */

/*
 * Country headers may be supplied by trusted infrastructure.
 *
 * Supported providers:
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
 * These headers must not be trusted unless the deployment owner
 * has explicitly enabled them and the trusted proxy prevents a
 * browser from spoofing the same forwarded country header.
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
 * Express header values may be:
 *
 * - strings;
 * - arrays;
 * - comma-separated forwarded values.
 */
function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return String(
      value[0] || '',
    ).trim();
  }

  return String(value || '')
    .split(',')[0]
    .trim();
}

/*
 * Normalize an ISO 3166-1 alpha-2 country code.
 *
 * This helper deliberately lives outside the tax flow.
 *
 * Country resolution is infrastructure information.
 * Tax and currency policy must remain separate consumers.
 */
function normalizeGeoCountryCode(value) {
  const normalized =
    String(value || '')
      .trim()
      .toUpperCase();

  return /^[A-Z]{2}$/.test(
    normalized,
  )
    ? normalized
    : '';
}

/*
 * Normalize a country supplied by a trusted GeoIP header.
 *
 * Some providers return special non-country values.
 *
 * Cloudflare examples:
 *
 * XX = unknown
 * T1 = Tor network
 *
 * Neither should be treated as a real customer country.
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

  return normalizeGeoCountryCode(
    rawValue,
  );
}

/*
 * Read a country supplied by explicitly trusted infrastructure.
 *
 * We intentionally do not:
 *
 * - inspect X-Forwarded-For;
 * - perform a local IP-database lookup;
 * - accept arbitrary client-provided country values.
 *
 * The existing TRUST_GEO_COUNTRY_HEADERS environment switch
 * remains the security boundary.
 */
function resolveTrustedHeaderCountry(req) {
  if (!TRUST_GEO_COUNTRY_HEADERS) {
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
        req?.headers?.[
          'cf-ipcountry'
        ],
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
 * Resolve the provisional visitor country.
 *
 * An unsuccessful result is normal.
 *
 * Consumers must provide their own fallback policy.
 *
 * Examples:
 *
 * Currency:
 *
 * manual selection
 * -> GeoIP currency
 * -> BASE_CURRENCY
 *
 * Tax:
 *
 * customer delivery-country selection
 * -> GeoIP country
 * -> DEFAULT_TAX_COUNTRY_CODE
 *
 * This helper itself performs neither fallback.
 */
function resolveGeoIpCountry(req) {
  const trustedHeaderResult =
    resolveTrustedHeaderCountry(
      req,
    );

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

  normalizeGeoCountryCode,

  normalizeGeoCountryHeader,

  resolveTrustedHeaderCountry,

  resolveGeoIpCountry,
};