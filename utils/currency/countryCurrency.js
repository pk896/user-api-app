// utils/currency/countryCurrency.js
'use strict';

const {
  normalizeCurrencyCode,
  isSupportedUserCurrency,
} = require('./currencyConfig');

/*
 * Kasyora country-to-display-currency policy
 * ===========================================
 *
 * This file maps an ISO 3166-1 alpha-2 visitor country
 * to Kasyora's preferred customer-facing display currency.
 *
 * IMPORTANT:
 *
 * - This is DISPLAY-CURRENCY policy only.
 *
 * - It does not determine:
 *   - BASE_CURRENCY;
 *   - product storage currency;
 *   - tax jurisdiction;
 *   - VAT;
 *   - checkout currency;
 *   - PayPal currency;
 *   - seller accounting;
 *   - payouts;
 *   - completed-order accounting.
 *
 * - Every mapped currency must also exist in
 *   utils/currency/currencyConfig.js.
 *
 * - If a country has no mapping, the later display-currency
 *   resolver must safely fall back to BASE_CURRENCY.
 *
 * - This mapping represents Kasyora's preferred shopping
 *   currency for a visitor in that country. It is not intended
 *   to be a legal-currency or monetary-policy database.
 */

/*
 * Keep the raw configuration as country/currency pairs rather
 * than an object literal so duplicate country entries can be
 * detected during startup validation.
 */
const RAW_COUNTRY_CURRENCY_MAPPINGS = Object.freeze([
  ['AF', 'AFN'],
  ['AL', 'ALL'],
  ['DZ', 'DZD'],
  ['AD', 'EUR'],
  ['AO', 'AOA'],
  ['AG', 'XCD'],
  ['AR', 'ARS'],
  ['AM', 'AMD'],
  ['AU', 'AUD'],
  ['AT', 'EUR'],
  ['AZ', 'AZN'],
  ['BS', 'BSD'],
  ['BH', 'BHD'],
  ['BD', 'BDT'],
  ['BB', 'BBD'],
  ['BY', 'BYN'],
  ['BE', 'EUR'],
  ['BZ', 'BZD'],
  ['BJ', 'XOF'],
  ['BT', 'BTN'],
  ['BO', 'BOB'],
  ['BA', 'BAM'],
  ['BW', 'BWP'],
  ['BR', 'BRL'],
  ['BN', 'BND'],
  ['BG', 'EUR'],
  ['BF', 'XOF'],
  ['BI', 'BIF'],
  ['CV', 'CVE'],
  ['KH', 'KHR'],
  ['CM', 'XAF'],
  ['CA', 'CAD'],
  ['CF', 'XAF'],
  ['TD', 'XAF'],
  ['CL', 'CLP'],
  ['CN', 'CNY'],
  ['CO', 'COP'],
  ['KM', 'KMF'],
  ['CG', 'XAF'],
  ['CD', 'CDF'],
  ['CR', 'CRC'],
  ['CI', 'XOF'],
  ['HR', 'EUR'],
  ['CU', 'CUP'],
  ['CY', 'EUR'],
  ['CZ', 'CZK'],
  ['DK', 'DKK'],
  ['DJ', 'DJF'],
  ['DM', 'XCD'],
  ['DO', 'DOP'],
  ['EC', 'USD'],
  ['EG', 'EGP'],
  ['SV', 'USD'],
  ['GQ', 'XAF'],
  ['ER', 'ERN'],
  ['EE', 'EUR'],
  ['SZ', 'SZL'],
  ['ET', 'ETB'],
  ['FJ', 'FJD'],
  ['FI', 'EUR'],
  ['FR', 'EUR'],
  ['GA', 'XAF'],
  ['GM', 'GMD'],
  ['GE', 'GEL'],
  ['DE', 'EUR'],
  ['GH', 'GHS'],
  ['GR', 'EUR'],
  ['GD', 'XCD'],
  ['GT', 'GTQ'],
  ['GN', 'GNF'],
  ['GW', 'XOF'],
  ['GY', 'GYD'],
  ['HT', 'HTG'],
  ['HN', 'HNL'],
  ['HU', 'HUF'],
  ['IS', 'ISK'],
  ['IN', 'INR'],
  ['ID', 'IDR'],
  ['IR', 'IRR'],
  ['IQ', 'IQD'],
  ['IE', 'EUR'],
  ['IL', 'ILS'],
  ['IT', 'EUR'],
  ['JM', 'JMD'],
  ['JP', 'JPY'],
  ['JO', 'JOD'],
  ['KZ', 'KZT'],
  ['KE', 'KES'],
  ['KI', 'AUD'],
  ['KW', 'KWD'],
  ['KG', 'KGS'],
  ['LA', 'LAK'],
  ['LV', 'EUR'],
  ['LB', 'LBP'],
  ['LS', 'LSL'],
  ['LR', 'LRD'],
  ['LY', 'LYD'],
  ['LI', 'CHF'],
  ['LT', 'EUR'],
  ['LU', 'EUR'],
  ['MG', 'MGA'],
  ['MW', 'MWK'],
  ['MY', 'MYR'],
  ['MV', 'MVR'],
  ['ML', 'XOF'],
  ['MT', 'EUR'],
  ['MH', 'USD'],
  ['MR', 'MRU'],
  ['MU', 'MUR'],
  ['MX', 'MXN'],
  ['FM', 'USD'],
  ['MD', 'MDL'],
  ['MC', 'EUR'],
  ['MN', 'MNT'],
  ['ME', 'EUR'],
  ['MA', 'MAD'],
  ['MZ', 'MZN'],
  ['MM', 'MMK'],
  ['NA', 'NAD'],
  ['NR', 'AUD'],
  ['NP', 'NPR'],
  ['NL', 'EUR'],
  ['NZ', 'NZD'],
  ['NI', 'NIO'],
  ['NE', 'XOF'],
  ['NG', 'NGN'],
  ['MK', 'MKD'],
  ['NO', 'NOK'],
  ['OM', 'OMR'],
  ['PK', 'PKR'],
  ['PW', 'USD'],
  ['PS', 'ILS'],
  ['PA', 'PAB'],
  ['PG', 'PGK'],
  ['PY', 'PYG'],
  ['PE', 'PEN'],
  ['PH', 'PHP'],
  ['PL', 'PLN'],
  ['PT', 'EUR'],
  ['QA', 'QAR'],
  ['RO', 'RON'],
  ['RU', 'RUB'],
  ['RW', 'RWF'],
  ['KN', 'XCD'],
  ['LC', 'XCD'],
  ['VC', 'XCD'],
  ['WS', 'WST'],
  ['SM', 'EUR'],
  ['ST', 'STN'],
  ['SA', 'SAR'],
  ['SN', 'XOF'],
  ['RS', 'RSD'],
  ['SC', 'SCR'],
  ['SL', 'SLE'],
  ['SG', 'SGD'],
  ['SK', 'EUR'],
  ['SI', 'EUR'],
  ['SB', 'SBD'],
  ['SO', 'SOS'],
  ['ZA', 'ZAR'],
  ['KR', 'KRW'],
  ['SS', 'SSP'],
  ['ES', 'EUR'],
  ['LK', 'LKR'],
  ['SD', 'SDG'],
  ['SR', 'SRD'],
  ['SE', 'SEK'],
  ['CH', 'CHF'],
  ['SY', 'SYP'],
  ['TJ', 'TJS'],
  ['TZ', 'TZS'],
  ['TH', 'THB'],
  ['TL', 'USD'],
  ['TG', 'XOF'],
  ['TO', 'TOP'],
  ['TT', 'TTD'],
  ['TN', 'TND'],
  ['TR', 'TRY'],
  ['TM', 'TMT'],
  ['TV', 'AUD'],
  ['UG', 'UGX'],
  ['UA', 'UAH'],
  ['AE', 'AED'],
  ['GB', 'GBP'],
  ['US', 'USD'],
  ['UY', 'UYU'],
  ['UZ', 'UZS'],
  ['VU', 'VUV'],
  ['VA', 'EUR'],
  ['VE', 'VES'],
  ['VN', 'VND'],
  ['YE', 'YER'],
  ['ZM', 'ZMW'],
  ['ZW', 'ZWG'],

  /*
   * Territories / special regions
   * =============================
   *
   * These match the additional ISO destination codes already
   * present in Kasyora's utils/countries.js.
   */
  ['AX', 'EUR'],
  ['AS', 'USD'],
  ['AI', 'XCD'],
  ['AW', 'AWG'],
  ['BM', 'BMD'],
  ['BQ', 'USD'],
  ['BV', 'NOK'],
  ['IO', 'USD'],
  ['VG', 'USD'],
  ['KY', 'KYD'],
  ['CX', 'AUD'],
  ['CC', 'AUD'],
  ['CK', 'NZD'],
  ['CW', 'XCG'],
  ['FK', 'FKP'],
  ['FO', 'DKK'],
  ['GF', 'EUR'],
  ['PF', 'XPF'],
  ['TF', 'EUR'],
  ['GI', 'GIP'],
  ['GL', 'DKK'],
  ['GP', 'EUR'],
  ['GU', 'USD'],
  ['GG', 'GGP'],
  ['HM', 'AUD'],
  ['HK', 'HKD'],
  ['IM', 'IMP'],
  ['JE', 'JEP'],
  ['MO', 'MOP'],
  ['MQ', 'EUR'],
  ['YT', 'EUR'],
  ['MS', 'XCD'],
  ['NC', 'XPF'],
  ['NU', 'NZD'],
  ['NF', 'AUD'],
  ['MP', 'USD'],
  ['PN', 'NZD'],
  ['PR', 'USD'],
  ['RE', 'EUR'],
  ['BL', 'EUR'],
  ['SH', 'SHP'],
  ['MF', 'EUR'],
  ['PM', 'EUR'],
  ['SX', 'XCG'],
  ['GS', 'GBP'],
  ['SJ', 'NOK'],
  ['TW', 'TWD'],
  ['TK', 'NZD'],
  ['TC', 'USD'],
  ['UM', 'USD'],
  ['VI', 'USD'],
  ['WF', 'XPF'],
]);

/*
 * Normalize an ISO 3166-1 alpha-2 country code.
 *
 * Keep this helper currency-local rather than depending on the
 * tax subsystem.
 */
function normalizeCurrencyCountryCode(value) {
  const countryCode =
    String(value || '')
      .trim()
      .toUpperCase();

  return /^[A-Z]{2}$/.test(
    countryCode,
  )
    ? countryCode
    : '';
}

/*
 * Validate the static mapping immediately when the application
 * starts.
 *
 * This protects Kasyora from:
 *
 * - malformed country codes;
 * - malformed currency codes;
 * - duplicate country mappings;
 * - a country pointing to a currency that is not enabled in
 *   currencyConfig.js.
 */
function validateCountryCurrencyConfiguration() {
  const seenCountries =
    new Set();

  for (
    const entry of
    RAW_COUNTRY_CURRENCY_MAPPINGS
  ) {
    const countryCode =
      normalizeCurrencyCountryCode(
        entry?.[0],
      );

    const currencyCode =
      normalizeCurrencyCode(
        entry?.[1],
      );

    if (!countryCode) {
      throw new Error(
        `Invalid Kasyora currency-country code: ${
          entry?.[0] || '(empty)'
        }`,
      );
    }

    if (
      !/^[A-Z]{3}$/.test(
        currencyCode,
      )
    ) {
      throw new Error(
        `Invalid Kasyora country display currency for ${countryCode}: ${
          currencyCode || '(empty)'
        }`,
      );
    }

    if (
      seenCountries.has(
        countryCode,
      )
    ) {
      throw new Error(
        `Duplicate Kasyora country display-currency mapping: ${countryCode}`,
      );
    }

    if (
      !isSupportedUserCurrency(
        currencyCode,
      )
    ) {
      throw new Error(
        `Kasyora country ${countryCode} maps to unsupported display currency ${currencyCode}.`,
      );
    }

    seenCountries.add(
      countryCode,
    );
  }
}

validateCountryCurrencyConfiguration();

/*
 * Internal lookup map.
 *
 * Do not export the mutable Map itself.
 */
const COUNTRY_CURRENCY_BY_COUNTRY =
  new Map(
    RAW_COUNTRY_CURRENCY_MAPPINGS.map(
      ([countryCode, currencyCode]) => [
        normalizeCurrencyCountryCode(
          countryCode,
        ),

        normalizeCurrencyCode(
          currencyCode,
        ),
      ],
    ),
  );

/*
 * Resolve Kasyora's preferred display currency for a country.
 *
 * An empty string is intentional.
 *
 * The later display-currency resolver will interpret an empty
 * result as:
 *
 * use BASE_CURRENCY.
 */
function getPreferredCurrencyForCountry(
  countryCode,
) {
  const normalizedCountry =
    normalizeCurrencyCountryCode(
      countryCode,
    );

  if (!normalizedCountry) {
    return '';
  }

  const currency =
    COUNTRY_CURRENCY_BY_COUNTRY.get(
      normalizedCountry,
    );

  if (
    !currency ||
    !isSupportedUserCurrency(
      currency,
    )
  ) {
    return '';
  }

  return currency;
}

function hasPreferredCurrencyForCountry(
  countryCode,
) {
  return Boolean(
    getPreferredCurrencyForCountry(
      countryCode,
    ),
  );
}

/*
 * Return a safe copy for diagnostics/tests.
 *
 * Callers cannot mutate Kasyora's internal lookup Map.
 */
function getCountryCurrencyMappings() {
  return RAW_COUNTRY_CURRENCY_MAPPINGS.map(
    ([countryCode, currencyCode]) => ({
      countryCode,
      currencyCode,
    }),
  );
}

module.exports = {
  normalizeCurrencyCountryCode,

  getPreferredCurrencyForCountry,

  hasPreferredCurrencyForCountry,

  getCountryCurrencyMappings,
};