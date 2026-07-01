// utils/cj/cjProductService.js
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

const CATEGORY_CACHE_TTL_MS = 30 * 60 * 1000;

let categoryCache = {
  expiresAt: 0,
  data: [],
  requestId: '',
};

function safeString(value, max = 5000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeNonNegativeNumber(value, fallback = 0) {
  const parsed = safeNumber(value, fallback);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(0, parsed);
}

function safeInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeDate(value) {
  if (!value) return null;

  const date =
    typeof value === 'number'
      ? new Date(value)
      : new Date(String(value));

  return Number.isNaN(date.getTime()) ? null : date;
}

function uniqueStrings(values) {
  return [
    ...new Set(
      (Array.isArray(values) ? values : [])
        .map((value) => safeString(value, 1000))
        .filter(Boolean),
    ),
  ];
}

function normalizeImageSet(detail) {
  const urls = [];

  if (detail?.bigImage) {
    urls.push(detail.bigImage);
  }

  if (Array.isArray(detail?.productImageSet)) {
    urls.push(...detail.productImageSet);
  }

  return uniqueStrings(urls).map((url, index) => ({
    url,
    sortOrder: index,
  }));
}

function flattenCategories(categoryData) {
  const firstLevelRows = Array.isArray(categoryData)
    ? categoryData
    : [];

  const flattened = [];

  firstLevelRows.forEach((first, firstIndex) => {
    const firstName = safeString(
      first?.categoryFirstName || first?.name,
      300,
    );

    const firstId = safeString(
      first?.categoryFirstId || first?.id,
      300,
    );

    const secondLevelRows = Array.isArray(first?.categoryFirstList)
      ? first.categoryFirstList
      : [];

    secondLevelRows.forEach((second, secondIndex) => {
      const secondName = safeString(
        second?.categorySecondName || second?.name,
        300,
      );

      const secondId = safeString(
        second?.categorySecondId || second?.id,
        300,
      );

      const thirdLevelRows = Array.isArray(
        second?.categorySecondList,
      )
        ? second.categorySecondList
        : [];

      thirdLevelRows.forEach((third, thirdIndex) => {
        const categoryId = safeString(
          third?.categoryId || third?.id,
          300,
        );

        const categoryName = safeString(
          third?.categoryName || third?.name,
          300,
        );

        if (!categoryId || !categoryName) {
          return;
        }

        flattened.push({
          categoryId,
          categoryName,
          firstId,
          firstName,
          secondId,
          secondName,
          sortKey:
            firstIndex * 1000000 +
            secondIndex * 1000 +
            thirdIndex,
        });
      });
    });
  });

  return flattened;
}

async function getCategories({ force = false } = {}) {
  if (
    !force &&
    categoryCache.expiresAt > Date.now() &&
    categoryCache.data.length
  ) {
    return {
      categories: categoryCache.data,
      requestId: categoryCache.requestId,
      fromCache: true,
    };
  }

  const response = await cjRequest('/product/getCategory');

  const categories = flattenCategories(response?.data);

  categoryCache = {
    expiresAt: Date.now() + CATEGORY_CACHE_TTL_MS,
    data: categories,
    requestId: safeString(response?.requestId, 200),
  };

  return {
    categories,
    requestId: categoryCache.requestId,
    fromCache: false,
  };
}

function extractListV2Products(response) {
  const content = Array.isArray(response?.data?.content)
    ? response.data.content
    : [];

  const products = [];

  content.forEach((group) => {
    if (Array.isArray(group?.productList)) {
      products.push(...group.productList);
      return;
    }

    if (group && typeof group === 'object' && group.id) {
      products.push(group);
    }
  });

  return products;
}

function normalizeCatalogueProduct(row) {
  const sourcePrice =
    safeNumber(row?.nowPrice) ??
    safeNumber(row?.discountPrice) ??
    safeNumber(row?.sellPrice) ??
    0;

  return {
    cjProductId: safeString(row?.id || row?.pid, 300),
    name: safeString(
      row?.nameEn || row?.productNameEn || row?.name,
      500,
    ),

    productSku: safeString(
      row?.sku || row?.spu || row?.productSku,
      300,
    ),

    mainImageUrl: safeString(
      row?.bigImage || row?.productImage,
      2000,
    ),

    sourcePriceUsd: safeNonNegativeNumber(sourcePrice, 0),

    originalSellPriceUsd: safeNonNegativeNumber(
      row?.sellPrice,
      sourcePrice,
    ),

    totalInventory: safeNonNegativeNumber(
      row?.totalVerifiedInventory ??
        row?.warehouseInventoryNum,
      0,
    ),

    categoryId: safeString(row?.categoryId, 300),
    categoryName: safeString(
      row?.threeCategoryName || row?.categoryName,
      500,
    ),

    firstCategoryId: safeString(row?.oneCategoryId, 300),
    firstCategoryName: safeString(row?.oneCategoryName, 300),

    secondCategoryId: safeString(row?.twoCategoryId, 300),
    secondCategoryName: safeString(row?.twoCategoryName, 300),

    productType: safeString(row?.productType, 200),

    listedNumber: safeNonNegativeNumber(row?.listedNum, 0),

    supplierName: safeString(row?.supplierName, 300),

    deliveryCycle: safeString(row?.deliveryCycle, 100),

    saleStatus: safeString(row?.saleStatus, 100),

    authorityStatus: safeString(row?.authorityStatus, 100),

    freeShipping: Number(row?.addMarkStatus) === 1,

    createdAt: safeDate(row?.createAt),

    raw: row,
  };
}

async function convertUsdAmount(amountUsd) {
  const safeAmount = safeNonNegativeNumber(amountUsd, 0);

  const converted = await convertMoneyAmount(
    safeAmount,
    'USD',
    BASE_CURRENCY,
  );

  return {
    value: safeNonNegativeNumber(converted?.value, 0),
    currency: BASE_CURRENCY,
    fx: {
      rate: safeNumber(converted?.fx?.rate, 1),
      from: 'USD',
      to: BASE_CURRENCY,
      provider:
        safeString(converted?.fx?.provider, 100) ||
        FX_PROVIDER,
      convertedAt: new Date(),
    },
  };
}

async function searchCatalogue({
  keyword = '',
  categoryId = '',
  countryCode = '',
  page = 1,
  size = 20,
  startSellPrice = '',
  endSellPrice = '',
} = {}) {
  const safePage = safeInteger(page, 1, 1, 1000);
  const safeSize = safeInteger(size, 20, 1, 40);

  const response = await cjRequest('/product/listV2', {
    query: {
      page: safePage,
      size: safeSize,
      keyWord: safeString(keyword, 200),
      categoryId: safeString(categoryId, 300),
      countryCode: safeString(countryCode, 2).toUpperCase(),
      startSellPrice:
        startSellPrice === ''
          ? undefined
          : safeNonNegativeNumber(startSellPrice, 0),

      endSellPrice:
        endSellPrice === ''
          ? undefined
          : safeNonNegativeNumber(endSellPrice, 0),

      features: 'enable_category',
    },
  });

  const products = extractListV2Products(response).map(
    normalizeCatalogueProduct,
  );

  const data = response?.data || {};

  return {
    products,
    pagination: {
      page: safeInteger(
        data?.pageNumber ?? safePage,
        safePage,
        1,
        1000,
      ),

      size: safeInteger(
        data?.pageSize ?? safeSize,
        safeSize,
        1,
        100,
      ),

      totalRecords: safeNonNegativeNumber(
        data?.totalRecords,
        products.length,
      ),

      totalPages: safeNonNegativeNumber(
        data?.totalPages,
        products.length ? 1 : 0,
      ),
    },

    requestId: safeString(response?.requestId, 200),
  };
}

function normalizeInventory(inventoryRows) {
  const rows = Array.isArray(inventoryRows)
    ? inventoryRows
    : [];

  return rows.map((inventory) => ({
    countryCode: safeString(
      inventory?.countryCode,
      10,
    ).toUpperCase(),

    warehouseName: safeString(
      inventory?.areaEn || inventory?.warehouseName,
      300,
    ),

    warehouseId: safeString(
      inventory?.areaId || inventory?.warehouseId,
      300,
    ),

    totalInventory: safeNonNegativeNumber(
      inventory?.totalInventory ??
        inventory?.totalInventoryNum ??
        inventory?.storageNum,
      0,
    ),

    cjInventory: safeNonNegativeNumber(
      inventory?.cjInventory ??
        inventory?.cjInventoryNum,
      0,
    ),

    factoryInventory: safeNonNegativeNumber(
      inventory?.factoryInventory ??
        inventory?.factoryInventoryNum,
      0,
    ),
  }));
}

function totalInventoryFromRows(rows) {
  return (Array.isArray(rows) ? rows : []).reduce(
    (sum, row) =>
      sum + safeNonNegativeNumber(row?.totalInventory, 0),
    0,
  );
}

function normalizeVariant(row) {
  const inventories = normalizeInventory(row?.inventories);

  return {
    cjVariantId: safeString(row?.vid, 300),
    variantSku: safeString(row?.variantSku, 300),

    variantName: safeString(
      row?.variantNameEn || row?.variantName,
      500,
    ),

    variantKey: safeString(
      row?.variantKey || row?.variantProperty,
      500,
    ),

    imageUrl: safeString(
      row?.variantImage || row?.image,
      2000,
    ),

    barcode: safeString(row?.barcode, 300),
    barcode2: safeString(row?.barcode2, 300),

    weightGrams: safeNumber(row?.variantWeight),

    dimensionsMm: {
      length: safeNumber(row?.variantLength),
      width: safeNumber(row?.variantWidth),
      height: safeNumber(row?.variantHeight),
    },

    sourceCostUsd: safeNonNegativeNumber(
      row?.variantSellPrice,
      0,
    ),

    suggestedSellingPriceUsd: safeNonNegativeNumber(
      row?.variantSugSellPrice,
      0,
    ),

    inventory: inventories,

    totalInventory: totalInventoryFromRows(inventories),

    inventoryKnown: inventories.length > 0,

    raw: row,
  };
}

async function getProductDetail(cjProductId) {
  const cleanProductId = safeString(cjProductId, 300);

  if (!cleanProductId) {
    const error = new Error('CJ product ID is required.');
    error.code = 'CJ_PRODUCT_ID_REQUIRED';
    throw error;
  }

  const [detailResponse, variantsResponse] =
    await Promise.all([
      cjRequest('/product/query', {
        query: {
          pid: cleanProductId,
        },
      }),

      cjRequest('/product/variant/query', {
        query: {
          pid: cleanProductId,
        },
      }),
    ]);

  const detail = detailResponse?.data || {};

  let variantRows = Array.isArray(variantsResponse?.data)
    ? variantsResponse.data
    : [];

  if (!variantRows.length && Array.isArray(detail?.variants)) {
    variantRows = detail.variants;
  }

  const variants = variantRows
    .map(normalizeVariant)
    .filter(
      (variant) =>
        variant.cjVariantId &&
        variant.variantSku,
    );

  const convertedVariants = [];

  for (const variant of variants) {
    const converted = await convertUsdAmount(
      variant.sourceCostUsd,
    );

    convertedVariants.push({
      ...variant,

      convertedSourceCost: {
        value: converted.value,
        currency: converted.currency,
      },

      fxSnapshot: converted.fx,
    });
  }

  return {
    product: {
      cjProductId: safeString(
        detail?.pid || cleanProductId,
        300,
      ),

      productSku: safeString(detail?.productSku, 300),

      name: safeString(
        detail?.productNameEn ||
          detail?.productName ||
          'CJ Product',
        500,
      ),

      originalName: safeString(detail?.productName, 1000),

      descriptionHtml: safeString(
        detail?.description,
        100000,
      ),

      mainImageUrl: safeString(detail?.bigImage, 2000),

      images: normalizeImageSet(detail),

      productWeightGrams: safeNumber(
        detail?.productWeight,
      ),

      packingWeightGrams: safeNumber(
        detail?.packingWeight ?? detail?.packWeight,
      ),

      productUnit: safeString(detail?.productUnit, 100),

      productType: safeString(
        detail?.productType,
        200,
      ),

      category: {
        id: safeString(detail?.categoryId, 300),
        name: safeString(detail?.categoryName, 1000),
      },

      customs: {
        hsCode: safeString(detail?.entryCode, 300),

        name: safeString(detail?.entryName, 500),

        nameEn: safeString(detail?.entryNameEn, 500),

        materialNameEn: safeString(
          detail?.materialNameEn,
          1000,
        ),

        packingNameEn: safeString(
          detail?.packingNameEn,
          1000,
        ),

        logisticsProperties: uniqueStrings(
          detail?.productProEnSet,
        ),
      },

      sellPriceUsd: safeNonNegativeNumber(
        detail?.sellPrice,
        0,
      ),

      suggestedSellPrice: safeString(
        detail?.suggestSellPrice,
        100,
      ),

      listedNumber: safeNonNegativeNumber(
        detail?.listedNum,
        0,
      ),

      saleStatus: safeString(detail?.status, 100),

      supplierName: safeString(
        detail?.supplierName,
        300,
      ),

      supplierId: safeString(
        detail?.supplierId,
        300,
      ),

      sourceCreatedAt: safeDate(
        detail?.createrTime || detail?.createTime,
      ),

      variants: convertedVariants,
    },

    requestIds: {
      detail: safeString(
        detailResponse?.requestId,
        200,
      ),

      variants: safeString(
        variantsResponse?.requestId,
        200,
      ),
    },
  };
}

function calculateSellingPriceFromMarkup(
  convertedCost,
  markupPercent,
) {
  const cost = safeNonNegativeNumber(convertedCost, 0);

  const markup = Math.max(
    0,
    Math.min(
      10000,
      safeNonNegativeNumber(markupPercent, 0),
    ),
  );

  return Number(
    (cost * (1 + markup / 100)).toFixed(2),
  );
}

module.exports = {
  BASE_CURRENCY,
  getCategories,
  searchCatalogue,
  getProductDetail,
  calculateSellingPriceFromMarkup,
  safeNonNegativeNumber,
};
