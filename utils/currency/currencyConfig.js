// utils/currency/currencyConfig.js
'use strict';

/*
 * Kasyora customer-facing currencies.
 *
 * IMPORTANT:
 * - BASE_CURRENCY remains Kasyora's authoritative accounting currency.
 * - These currencies are for customer display only.
 * - Adding a currency here does not change product, order, payout,
 *   refund or seller-balance accounting.
 */

/*
 * Popular currencies
 * ==================
 *
 * These currencies appear immediately when the selector opens.
 *
 * Kasyora still supports every currency in
 * SUPPORTED_USER_CURRENCIES below.
 *
 * The popular list controls presentation only.
 */
const POPULAR_USER_CURRENCY_CODES = Object.freeze([
  'USD',
  'ZAR',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CNY',
  'INR',
  'BRL',
  'MXN',
  'SGD',
  'AED',
  'NGN',
  'KES',
  'GHS',
  'KRW',
  'NZD',
  'SAR',
  'CHF',
]);

const POPULAR_USER_CURRENCY_CODE_SET = new Set(
  POPULAR_USER_CURRENCY_CODES,
);

/*
 * Kasyora global customer display currencies
 * ==========================================
 *
 * IMPORTANT:
 *
 * - These are DISPLAY currencies only.
 *
 * - Product prices, carts, VAT, shipping, orders,
 *   payouts and seller accounting remain in BASE_CURRENCY.
 *
 * - Adding a currency here does not add it to PayPal.
 *
 * - PAYPAL_CHECKOUT_CURRENCY remains completely separate.
 *
 * - All currencies below are ISO 4217 currency codes.
 */
const RAW_SUPPORTED_USER_CURRENCIES = Object.freeze([
  ['AED', 'UAE Dirham'],
  ['AFN', 'Afghan Afghani'],
  ['ALL', 'Albanian Lek'],
  ['AMD', 'Armenian Dram'],
  ['ANG', 'Netherlands Antillean Guilder'],
  ['AOA', 'Angolan Kwanza'],
  ['ARS', 'Argentine Peso'],
  ['AUD', 'Australian Dollar'],
  ['AWG', 'Aruban Florin'],
  ['AZN', 'Azerbaijani Manat'],
  ['BAM', 'Bosnia-Herzegovina Convertible Mark'],
  ['BBD', 'Barbadian Dollar'],
  ['BDT', 'Bangladeshi Taka'],
  ['BHD', 'Bahraini Dinar'],
  ['BIF', 'Burundian Franc'],
  ['BMD', 'Bermudian Dollar'],
  ['BND', 'Brunei Dollar'],
  ['BOB', 'Bolivian Boliviano'],
  ['BRL', 'Brazilian Real'],
  ['BSD', 'Bahamian Dollar'],
  ['BTN', 'Bhutanese Ngultrum'],
  ['BWP', 'Botswana Pula'],
  ['BYN', 'Belarusian Ruble'],
  ['BZD', 'Belize Dollar'],
  ['CAD', 'Canadian Dollar'],
  ['CDF', 'Congolese Franc'],
  ['CHF', 'Swiss Franc'],
  ['CLP', 'Chilean Peso'],
  ['CNY', 'Chinese Yuan'],
  ['COP', 'Colombian Peso'],
  ['CRC', 'Costa Rican Colón'],
  ['CUP', 'Cuban Peso'],
  ['CVE', 'Cape Verdean Escudo'],
  ['CZK', 'Czech Koruna'],
  ['DJF', 'Djiboutian Franc'],
  ['DKK', 'Danish Krone'],
  ['DOP', 'Dominican Peso'],
  ['DZD', 'Algerian Dinar'],
  ['EGP', 'Egyptian Pound'],
  ['ERN', 'Eritrean Nakfa'],
  ['ETB', 'Ethiopian Birr'],
  ['EUR', 'Euro'],
  ['FJD', 'Fijian Dollar'],
  ['FKP', 'Falkland Islands Pound'],
  ['GBP', 'British Pound'],
  ['GEL', 'Georgian Lari'],
  ['GGP', 'Guernsey Pound'],
  ['GHS', 'Ghanaian Cedi'],
  ['GIP', 'Gibraltar Pound'],
  ['GMD', 'Gambian Dalasi'],
  ['GNF', 'Guinean Franc'],
  ['GTQ', 'Guatemalan Quetzal'],
  ['GYD', 'Guyanese Dollar'],
  ['HKD', 'Hong Kong Dollar'],
  ['HNL', 'Honduran Lempira'],
  ['HTG', 'Haitian Gourde'],
  ['HUF', 'Hungarian Forint'],
  ['IDR', 'Indonesian Rupiah'],
  ['ILS', 'Israeli New Shekel'],
  ['IMP', 'Isle of Man Pound'],
  ['INR', 'Indian Rupee'],
  ['IQD', 'Iraqi Dinar'],
  ['IRR', 'Iranian Rial'],
  ['ISK', 'Icelandic Króna'],
  ['JEP', 'Jersey Pound'],
  ['JMD', 'Jamaican Dollar'],
  ['JOD', 'Jordanian Dinar'],
  ['JPY', 'Japanese Yen'],
  ['KES', 'Kenyan Shilling'],
  ['KGS', 'Kyrgyzstani Som'],
  ['KHR', 'Cambodian Riel'],
  ['KMF', 'Comorian Franc'],
  ['KRW', 'South Korean Won'],
  ['KWD', 'Kuwaiti Dinar'],
  ['KYD', 'Cayman Islands Dollar'],
  ['KZT', 'Kazakhstani Tenge'],
  ['LAK', 'Lao Kip'],
  ['LBP', 'Lebanese Pound'],
  ['LKR', 'Sri Lankan Rupee'],
  ['LRD', 'Liberian Dollar'],
  ['LSL', 'Lesotho Loti'],
  ['LYD', 'Libyan Dinar'],
  ['MAD', 'Moroccan Dirham'],
  ['MDL', 'Moldovan Leu'],
  ['MGA', 'Malagasy Ariary'],
  ['MKD', 'Macedonian Denar'],
  ['MMK', 'Myanmar Kyat'],
  ['MNT', 'Mongolian Tögrög'],
  ['MOP', 'Macanese Pataca'],
  ['MRU', 'Mauritanian Ouguiya'],
  ['MUR', 'Mauritian Rupee'],
  ['MVR', 'Maldivian Rufiyaa'],
  ['MWK', 'Malawian Kwacha'],
  ['MXN', 'Mexican Peso'],
  ['MYR', 'Malaysian Ringgit'],
  ['MZN', 'Mozambican Metical'],
  ['NAD', 'Namibian Dollar'],
  ['NGN', 'Nigerian Naira'],
  ['NIO', 'Nicaraguan Córdoba'],
  ['NOK', 'Norwegian Krone'],
  ['NPR', 'Nepalese Rupee'],
  ['NZD', 'New Zealand Dollar'],
  ['OMR', 'Omani Rial'],
  ['PAB', 'Panamanian Balboa'],
  ['PEN', 'Peruvian Sol'],
  ['PGK', 'Papua New Guinean Kina'],
  ['PHP', 'Philippine Peso'],
  ['PKR', 'Pakistani Rupee'],
  ['PLN', 'Polish Złoty'],
  ['PYG', 'Paraguayan Guaraní'],
  ['QAR', 'Qatari Riyal'],
  ['RON', 'Romanian Leu'],
  ['RSD', 'Serbian Dinar'],
  ['RUB', 'Russian Ruble'],
  ['RWF', 'Rwandan Franc'],
  ['SAR', 'Saudi Riyal'],
  ['SBD', 'Solomon Islands Dollar'],
  ['SCR', 'Seychellois Rupee'],
  ['SDG', 'Sudanese Pound'],
  ['SEK', 'Swedish Krona'],
  ['SGD', 'Singapore Dollar'],
  ['SHP', 'Saint Helena Pound'],
  ['SLE', 'Sierra Leonean Leone'],
  ['SOS', 'Somali Shilling'],
  ['SRD', 'Surinamese Dollar'],
  ['SSP', 'South Sudanese Pound'],
  ['STN', 'São Tomé and Príncipe Dobra'],
  ['SVC', 'Salvadoran Colón'],
  ['SYP', 'Syrian Pound'],
  ['SZL', 'Swazi Lilangeni'],
  ['THB', 'Thai Baht'],
  ['TJS', 'Tajikistani Somoni'],
  ['TMT', 'Turkmenistani Manat'],
  ['TND', 'Tunisian Dinar'],
  ['TOP', 'Tongan Paʻanga'],
  ['TRY', 'Turkish Lira'],
  ['TTD', 'Trinidad and Tobago Dollar'],
  ['TWD', 'New Taiwan Dollar'],
  ['TZS', 'Tanzanian Shilling'],
  ['UAH', 'Ukrainian Hryvnia'],
  ['UGX', 'Ugandan Shilling'],
  ['USD', 'US Dollar'],
  ['UYU', 'Uruguayan Peso'],
  ['UZS', 'Uzbekistani Som'],
  ['VES', 'Venezuelan Bolívar'],
  ['VND', 'Vietnamese Đồng'],
  ['VUV', 'Vanuatu Vatu'],
  ['WST', 'Samoan Tala'],
  ['XAF', 'Central African CFA Franc'],
  ['XCD', 'East Caribbean Dollar'],
  ['XCG', 'Caribbean Guilder'],
  ['XOF', 'West African CFA Franc'],
  ['XPF', 'CFP Franc'],
  ['YER', 'Yemeni Rial'],
  ['ZAR', 'South African Rand'],
  ['ZMW', 'Zambian Kwacha'],
  ['ZWG', 'Zimbabwe Gold'],
]);


/*
 * Validate the static display-currency configuration at startup.
 *
 * Configuration mistakes should fail immediately rather than
 * silently creating duplicate, missing or inconsistent currencies.
 */
function validateCurrencyConfiguration() {
  const seenCodes =
    new Set();

  for (const entry of RAW_SUPPORTED_USER_CURRENCIES) {
    const code =
      String(
        entry?.[0] || '',
      )
        .trim()
        .toUpperCase();

    const name =
      String(
        entry?.[1] || '',
      )
        .trim();

    if (!/^[A-Z]{3}$/.test(code)) {
      throw new Error(
        `Invalid Kasyora display currency code: ${code || '(empty)'}`,
      );
    }

    if (!name) {
      throw new Error(
        `Missing Kasyora display currency name for ${code}.`,
      );
    }

    if (seenCodes.has(code)) {
      throw new Error(
        `Duplicate Kasyora display currency code: ${code}`,
      );
    }

    seenCodes.add(code);
  }

  for (const popularCode of POPULAR_USER_CURRENCY_CODES) {
    if (!seenCodes.has(popularCode)) {
      throw new Error(
        `Popular Kasyora display currency is not supported: ${popularCode}`,
      );
    }
  }
}

validateCurrencyConfiguration();

/*
 * Resolve currency presentation rules from the JavaScript
 * internationalisation engine.
 *
 * This prevents Kasyora from assuming that every currency has
 * two decimal places.
 *
 * Examples:
 *
 * USD -> 2
 * ZAR -> 2
 * JPY -> 0
 * KWD -> 3
 */
function getIntlCurrencyMetadata(code) {
  try {
    const formatter = new Intl.NumberFormat(
      'en',
      {
        style: 'currency',
        currency: code,
        currencyDisplay: 'symbol',
      },
    );

    const resolved =
      formatter.resolvedOptions();

    const currencyPart =
      formatter
        .formatToParts(0)
        .find(
          (part) =>
            part.type === 'currency',
        );

    const decimals =
      Number(
        resolved.maximumFractionDigits,
      );

    return {
      symbol:
        String(
          currencyPart?.value || code,
        ).trim() || code,

      /*
       * Storefront formatting should normally use the
       * customer's browser locale.
       *
       * This value remains available for compatibility with
       * any existing code that reads currency.locale.
       */
      locale: 'en',

      decimals:
        Number.isInteger(decimals) &&
        decimals >= 0 &&
        decimals <= 4
          ? decimals
          : 2,
    };
  } catch {
    return {
      symbol: code,
      locale: 'en',
      decimals: 2,
    };
  }
}

const POPULAR_USER_CURRENCY_ORDER =
  new Map(
    POPULAR_USER_CURRENCY_CODES.map(
      (code, index) => [
        code,
        index,
      ],
    ),
  );

const SUPPORTED_USER_CURRENCIES =
  Object.freeze(
    RAW_SUPPORTED_USER_CURRENCIES
      .map(([code, name]) => {
        const metadata =
          getIntlCurrencyMetadata(
            code,
          );

        return Object.freeze({
          code,
          name,

          symbol:
            metadata.symbol,

          locale:
            metadata.locale,

          decimals:
            metadata.decimals,

          popular:
            POPULAR_USER_CURRENCY_CODE_SET
              .has(code),
        });
      })
      .sort((left, right) => {
        const leftRank =
          POPULAR_USER_CURRENCY_ORDER
            .has(left.code)
            ? POPULAR_USER_CURRENCY_ORDER
                .get(left.code)
            : Number.MAX_SAFE_INTEGER;

        const rightRank =
          POPULAR_USER_CURRENCY_ORDER
            .has(right.code)
            ? POPULAR_USER_CURRENCY_ORDER
                .get(right.code)
            : Number.MAX_SAFE_INTEGER;

        if (leftRank !== rightRank) {
          return leftRank - rightRank;
        }

        return left.name.localeCompare(
          right.name,
          'en',
          {
            sensitivity: 'base',
          },
        );
      }),
  );

const SUPPORTED_USER_CURRENCY_CODES =
  new Set(
    SUPPORTED_USER_CURRENCIES.map(
      (currency) =>
        currency.code,
    ),
  );

const SUPPORTED_USER_CURRENCY_BY_CODE =
  new Map(
    SUPPORTED_USER_CURRENCIES.map(
      (currency) => [
        currency.code,
        currency,
      ],
    ),
  );

function normalizeCurrencyCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase();
}

function isSupportedUserCurrency(value) {
  return SUPPORTED_USER_CURRENCY_CODES.has(
    normalizeCurrencyCode(value),
  );
}

function getSupportedUserCurrency(value) {
  const code =
    normalizeCurrencyCode(value);

  const currency =
    SUPPORTED_USER_CURRENCY_BY_CODE
      .get(code);

  return currency
    ? {
        ...currency,
      }
    : null;
}

function getSupportedUserCurrencies() {
  return SUPPORTED_USER_CURRENCIES.map(
    (currency) => ({
      ...currency,
    }),
  );
}

function getPopularUserCurrencies() {
  return SUPPORTED_USER_CURRENCIES
    .filter(
      (currency) =>
        currency.popular === true,
    )
    .map(
      (currency) => ({
        ...currency,
      }),
    );
}

module.exports = {
  SUPPORTED_USER_CURRENCIES,
  POPULAR_USER_CURRENCY_CODES,
  normalizeCurrencyCode,
  isSupportedUserCurrency,
  getSupportedUserCurrency,
  getSupportedUserCurrencies,
  getPopularUserCurrencies,
};
