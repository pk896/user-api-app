// utils/cj/cjLogisticsService.js
'use strict';

const { cjRequest } = require('./cjClient');

const {
  convertMoneyAmount,
  FX_PROVIDER,
} = require('../fx/getFxRate');

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase() || 'USD';

const DEFAULT_ORIGIN_COUNTRY_CODE =
  String(
    process.env.CJ_DEFAULT_ORIGIN_COUNTRY_CODE || '',
  )
    .trim()
    .toUpperCase();

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed)
    ? parsed
    : fallback;
}

function round2(value) {
  return Math.round(
    Number(value || 0) * 100,
  ) / 100;
}

function normalizeCountryCode(value) {
  const code = safeString(value, 2).toUpperCase();

  return /^[A-Z]{2}$/.test(code)
    ? code
    : '';
}

function normalizeQuantity(value) {
  const parsed = Number.parseInt(
    String(value ?? '').trim(),
    10,
  );

  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(
    1,
    Math.min(100, parsed),
  );
}

function validateOriginCountryCode(value) {
  const originCountryCode =
    normalizeCountryCode(value);

  if (!originCountryCode) {
    const error = new Error(
      'CJ_DEFAULT_ORIGIN_COUNTRY_CODE must be configured using a valid two-letter country code.',
    );

    error.code =
      'CJ_ORIGIN_COUNTRY_CODE_INVALID';

    throw error;
  }

  return originCountryCode;
}

function validateDestinationCountryCode(value) {
  const destinationCountryCode =
    normalizeCountryCode(value);

  if (!destinationCountryCode) {
    const error = new Error(
      'Please select a valid destination country.',
    );

    error.code =
      'CJ_DESTINATION_COUNTRY_CODE_INVALID';

    throw error;
  }

  return destinationCountryCode;
}

function normalizeFreightProducts(items) {
  const rows = Array.isArray(items)
    ? items
    : [];

  const products = rows
    .map((item) => {
      const vid = safeString(
        item?.cjVariantId,
        200,
      );

      if (!vid) {
        return null;
      }

      return {
        vid,
        quantity: normalizeQuantity(
          item?.quantity,
        ),
      };
    })
    .filter(Boolean);

  if (!products.length) {
    const error = new Error(
      'The CJ cart does not contain any valid product variants.',
    );

    error.code = 'CJ_FREIGHT_PRODUCTS_EMPTY';
    throw error;
  }

  return products;
}

async function convertUsdToBaseCurrency(
  amountUsd,
) {
  const safeUsd = Math.max(
    0,
    safeNumber(amountUsd, 0),
  );

  if (BASE_CURRENCY === 'USD') {
    return {
      value: round2(safeUsd),
      currency: 'USD',

      fx: {
        rate: 1,
        from: 'USD',
        to: 'USD',
        provider: 'IDENTITY',
        convertedAt:
          new Date().toISOString(),
      },
    };
  }

  const converted =
    await convertMoneyAmount(
      safeUsd,
      'USD',
      BASE_CURRENCY,
    );

  const convertedValue = Number(
    converted?.value,
  );

  if (
    !Number.isFinite(convertedValue) ||
    convertedValue < 0
  ) {
    const error = new Error(
      'CJ shipping cost could not be converted into the Kasyora base currency.',
    );

    error.code =
      'CJ_FREIGHT_CURRENCY_CONVERSION_FAILED';

    throw error;
  }

  return {
    value: round2(convertedValue),
    currency: BASE_CURRENCY,

    fx: {
      rate: safeNumber(
        converted?.fx?.rate,
        0,
      ),

      from: 'USD',
      to: BASE_CURRENCY,

      provider:
        safeString(
          converted?.fx?.provider,
          100,
        ) || FX_PROVIDER,

      convertedAt:
        converted?.fx?.convertedAt ||
        new Date().toISOString(),
    },
  };
}

function getFreightUsd(row) {
  const candidates = [
    row?.totalPostageFee,
    row?.logisticPrice,
    row?.postageAmount,
    row?.wrapPostage,
    row?.discountFee,
    row?.postage,
  ];

  for (const candidate of candidates) {
    const parsed = Number(candidate);

    if (
      Number.isFinite(parsed) &&
      parsed >= 0
    ) {
      return round2(parsed);
    }
  }

  return null;
}

function getLogisticsName(row) {
  return safeString(
    row?.logisticName ||
      row?.option?.enName ||
      row?.optionName ||
      row?.channel?.enName,
    300,
  );
}

function getDeliveryEstimate(row) {
  return safeString(
    row?.logisticAging ||
      row?.arrivalTime ||
      row?.option?.arrivalTime,
    100,
  );
}

async function normalizeFreightOption(
  row,
  index,
) {
  const logisticsName =
    getLogisticsName(row);

  const freightUsd =
    getFreightUsd(row);

  if (
    !logisticsName ||
    freightUsd === null
  ) {
    return null;
  }

  const converted =
    await convertUsdToBaseCurrency(
      freightUsd,
    );

  const taxesFeeUsd = Math.max(
    0,
    safeNumber(
      row?.taxesFee,
      0,
    ),
  );

  const clearanceFeeUsd = Math.max(
    0,
    safeNumber(
      row?.clearanceOperationFee,
      0,
    ),
  );

  const tariffUsd = Math.max(
    0,
    safeNumber(
      row?.tariff,
      0,
    ),
  );

  return {
    id:
      safeString(
        row?.optionId ||
          row?.option?.id ||
          row?.logisticsModel ||
          row?.channelId,
        300,
      ) ||
      `cj-logistics-${index + 1}`,

    logisticsName,

    logisticsModel: safeString(
      row?.logisticsModel,
      200,
    ),

    deliveryEstimate:
      getDeliveryEstimate(row),

    freightUsd,

    freight: {
      value: converted.value,
      currency: converted.currency,
    },

    fxSnapshot: converted.fx,

    taxesFeeUsd:
      round2(taxesFeeUsd),

    clearanceOperationFeeUsd:
      round2(clearanceFeeUsd),

    tariffUsd:
      round2(tariffUsd),

    remoteFeeUsd:
      round2(
        Math.max(
          0,
          safeNumber(
            row?.remoteFee,
            0,
          ),
        ),
      ),

    message: safeString(
      row?.message ||
        row?.tip,
      1000,
    ),

    optionId: safeString(
      row?.optionId ||
        row?.option?.id,
      300,
    ),

    channelId: safeString(
      row?.channelId ||
        row?.channel?.id,
      300,
    ),

    raw: row,
  };
}

async function calculateCjFreight({
  cartItems,
  destinationCountryCode,
  postalCode = '',
  houseNumber = '',
  taxId = '',
  iossNumber = '',
  originCountryCode =
    DEFAULT_ORIGIN_COUNTRY_CODE,
}) {
  const startCountryCode =
    validateOriginCountryCode(
      originCountryCode,
    );

  const endCountryCode =
    validateDestinationCountryCode(
      destinationCountryCode,
    );

  const products =
    normalizeFreightProducts(
      cartItems,
    );

  const requestBody = {
    startCountryCode,
    endCountryCode,
    products,
  };

  const cleanPostalCode =
    safeString(postalCode, 200);

  const cleanHouseNumber =
    safeString(houseNumber, 200);

  const cleanTaxId =
    safeString(taxId, 200);

  const cleanIossNumber =
    safeString(iossNumber, 200);

  if (cleanPostalCode) {
    requestBody.zip =
      cleanPostalCode;
  }

  if (cleanHouseNumber) {
    requestBody.houseNumber =
      cleanHouseNumber;
  }

  if (cleanTaxId) {
    requestBody.taxId =
      cleanTaxId;
  }

  if (cleanIossNumber) {
    requestBody.iossNumber =
      cleanIossNumber;
  }

  const response = await cjRequest(
    '/logistic/freightCalculate',
    {
      method: 'POST',
      body: requestBody,
    },
  );

  const rows = Array.isArray(
    response?.data,
  )
    ? response.data
    : [];

  const options = [];

  for (
    let index = 0;
    index < rows.length;
    index += 1
  ) {
    const normalized =
      await normalizeFreightOption(
        rows[index],
        index,
      );

    if (normalized) {
      options.push(normalized);
    }
  }

  options.sort((a, b) => {
    return (
      Number(a?.freight?.value || 0) -
      Number(b?.freight?.value || 0)
    );
  });

  if (!options.length) {
    const error = new Error(
      'CJ did not return any available shipping methods for this destination and cart.',
    );

    error.code =
      'CJ_NO_LOGISTICS_OPTIONS';

    error.requestId =
      safeString(
        response?.requestId,
        200,
      );

    throw error;
  }

  return {
    source: 'CJ',

    requestId: safeString(
      response?.requestId,
      200,
    ),

    originCountryCode:
      startCountryCode,

    destinationCountryCode:
      endCountryCode,

    postalCode:
      cleanPostalCode,

    products,

    options,
  };
}

module.exports = {
  BASE_CURRENCY,
  DEFAULT_ORIGIN_COUNTRY_CODE,
  calculateCjFreight,
  normalizeFreightProducts,
};