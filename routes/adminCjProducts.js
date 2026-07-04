// routes/adminCjProducts.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const CjProduct = require('../models/CjProduct');
const CjProductSyncLog = require('../models/CjProductSyncLog');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require(
  '../middleware/requireAdminPermission',
);

const { logAdminAction } = require(
  '../utils/logAdminAction',
);

const {
  BASE_CURRENCY,
  getCategories,
  searchCatalogue,
  getProductDetail,
  calculateSellingPriceFromMarkup,
  safeNonNegativeNumber,
} = require('../utils/cj/cjProductService');

const router = express.Router();

/*
 * CJ product catalogue/import management belongs to the
 * store and inventory departments.
 *
 * Allowed:
 * - super_admin
 * - store_admin with cj.products.manage
 * - inventory_admin with cj.products.manage
 */
router.use(
  '/admin/cj/products',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin', 'inventory_admin']),
  requireAdminPermission('cj.products.manage'),
);

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(
    String(value ?? '').trim(),
    10,
  );

  if (!Number.isFinite(parsed)) return fallback;

  return Math.max(
    minimum,
    Math.min(maximum, parsed),
  );
}

function getAdminId(req) {
  const value =
    req.admin?._id ||
    req.session?.admin?._id ||
    null;

  return mongoose.Types.ObjectId.isValid(value)
    ? value
    : null;
}

function normalizeSelectedVariantIds(value) {
  const rows = Array.isArray(value)
    ? value
    : value
      ? [value]
      : [];

  return [
    ...new Set(
      rows
        .map((entry) => safeString(entry, 300))
        .filter(Boolean),
    ),
  ];
}

function toObjectMap(value) {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value)
    ? value
    : {};
}

function calculateProductPriceRange(variants) {
  const prices = (Array.isArray(variants) ? variants : [])
    .filter((variant) => variant.isEnabled)
    .map((variant) =>
      Number(variant?.sellingPriceExVat?.value),
    )
    .filter((price) => Number.isFinite(price));

  if (!prices.length) {
    return {
      minimum: 0,
      maximum: 0,
    };
  }

  return {
    minimum: Math.min(...prices),
    maximum: Math.max(...prices),
  };
}

async function writeSyncLog({
  req,
  cjProduct = null,
  cjProductId,
  action,
  status,
  requestId = '',
  message = '',
  before = null,
  after = null,
  meta = null,
}) {
  try {
    await CjProductSyncLog.create({
      cjProduct: cjProduct?._id || null,
      cjProductId,
      action,
      status,
      requestId,
      message,
      before,
      after,
      meta,
      admin: getAdminId(req),
    });
  } catch (error) {
    console.error(
      '[CJ products] Failed to write sync log:',
      error?.message || error,
    );
  }
}

/* =====================================================
 * CJ catalogue search
 * =================================================== */

router.get('/admin/cj/products', async (req, res) => {
  try {
    const filters = {
      keyword: safeString(req.query.keyword, 200),
      categoryId: safeString(
        req.query.categoryId,
        300,
      ),

      countryCode: safeString(
        req.query.countryCode,
        2,
      ).toUpperCase(),

      startSellPrice: safeString(
        req.query.startSellPrice,
        30,
      ),

      endSellPrice: safeString(
        req.query.endSellPrice,
        30,
      ),

      page: safeInteger(
        req.query.page,
        1,
        1,
        1000,
      ),

      size: 20,
    };

    const categoryResult = await getCategories();

    const hasSearch =
      filters.keyword ||
      filters.categoryId ||
      filters.countryCode ||
      filters.startSellPrice ||
      filters.endSellPrice ||
      String(req.query.search || '') === '1';

    let searchResult = {
      products: [],
      pagination: {
        page: filters.page,
        size: 20,
        totalRecords: 0,
        totalPages: 0,
      },
      requestId: '',
    };

    if (hasSearch) {
      searchResult = await searchCatalogue(filters);

      await writeSyncLog({
        req,
        cjProductId: 'CATALOGUE',
        action: 'CATALOGUE_VIEW',
        status: 'SUCCESS',
        requestId: searchResult.requestId,
        meta: {
          filters,
          resultCount: searchResult.products.length,
        },
      });
    }

    const importedRows = await CjProduct.find({
      cjProductId: {
        $in: searchResult.products.map(
          (product) => product.cjProductId,
        ),
      },
    })
      .select('cjProductId status')
      .lean();

    const importedMap = new Map(
      importedRows.map((row) => [
        String(row.cjProductId),
        {
          _id: row._id,
          status: row.status,
        },
      ]),
    );

    const products = searchResult.products.map(
      (product) => ({
        ...product,
        imported: importedMap.get(
          String(product.cjProductId),
        ) || null,
      }),
    );

    return res.render('admin/cj/products', {
      layout: 'layout',
      title: 'CJ Product Catalogue',
      active: 'admin-cj-products',
      fullWidthPage: true,

      products,
      categories: categoryResult.categories,
      filters,
      hasSearch,
      pagination: searchResult.pagination,
      requestId: searchResult.requestId,
      baseCurrency: BASE_CURRENCY,
    });
  } catch (error) {
    console.error(
      '[CJ products] Catalogue error:',
      error?.stack || error,
    );

    req.flash(
      'error',
      `CJ catalogue could not be loaded: ${
        safeString(error?.message, 1000) ||
        'Unknown error'
      }`,
    );

    return res.redirect('/admin/cj');
  }
});

/* =====================================================
 * Imported CJ products
 * =================================================== */

router.get(
  '/admin/cj/products/imported',
  async (req, res) => {
    try {
      const status = safeString(req.query.status, 30);
      const keyword = safeString(
        req.query.keyword,
        200,
      );

      const query = {};

      if (
        ['draft', 'active', 'paused', 'archived'].includes(
          status,
        )
      ) {
        query.status = status;
      }

      if (keyword) {
        query.$or = [
          {
            name: {
              $regex: keyword,
              $options: 'i',
            },
          },
          {
            productSku: {
              $regex: keyword,
              $options: 'i',
            },
          },
          {
            cjProductId: {
              $regex: keyword,
              $options: 'i',
            },
          },
          {
            'variants.variantSku': {
              $regex: keyword,
              $options: 'i',
            },
          },
        ];
      }

      const products = await CjProduct.find(query)
        .sort({
          updatedAt: -1,
          createdAt: -1,
        })
        .lean();

      return res.render(
        'admin/cj/imported-products',
        {
          layout: 'layout',
          title: 'Imported CJ Products',
          active: 'admin-cj-imported-products',
          fullWidthPage: true,

          products,
          filters: {
            status,
            keyword,
          },

          baseCurrency: BASE_CURRENCY,
          vatRate: Number(
            process.env.VAT_RATE || 0.15,
          ),
        },
      );
    } catch (error) {
      console.error(
        '[CJ products] Imported list error:',
        error?.stack || error,
      );

      req.flash(
        'error',
        'Imported CJ products could not be loaded.',
      );

      return res.redirect('/admin/cj');
    }
  },
);

/* =====================================================
 * Product preview
 *
 * Keep this route AFTER /imported so Express does not
 * treat "imported" as a CJ product ID.
 * =================================================== */

router.get(
  '/admin/cj/products/:cjProductId',
  async (req, res) => {
    const cjProductId = safeString(
      req.params.cjProductId,
      300,
    );

    try {
      const [detailResult, existingProduct] =
        await Promise.all([
          getProductDetail(cjProductId),

          CjProduct.findOne({
            cjProductId,
          }).lean(),
        ]);

      await writeSyncLog({
        req,
        cjProduct: existingProduct,
        cjProductId,
        action: 'DETAIL_VIEW',
        status: 'SUCCESS',
        requestId:
          detailResult.requestIds.detail ||
          detailResult.requestIds.variants,
      });

      return res.render(
        'admin/cj/product-detail',
        {
          layout: 'layout',
          title: detailResult.product.name,
          active: 'admin-cj-products',
          fullWidthPage: true,

          product: detailResult.product,
          existingProduct,
          requestIds: detailResult.requestIds,

          baseCurrency: BASE_CURRENCY,
          vatRate: Number(
            process.env.VAT_RATE || 0.15,
          ),

          defaultMarkupPercent: Number(
            existingProduct?.pricing
              ?.defaultMarkupPercent ?? 30,
          ),
        },
      );
    } catch (error) {
      console.error(
        '[CJ products] Detail error:',
        error?.stack || error,
      );

      await writeSyncLog({
        req,
        cjProductId,
        action: 'DETAIL_VIEW',
        status: 'FAILED',
        requestId: safeString(
          error?.requestId,
          200,
        ),

        message: safeString(
          error?.message,
          2000,
        ),
      });

      req.flash(
        'error',
        `CJ product could not be loaded: ${
          safeString(error?.message, 1000) ||
          'Unknown error'
        }`,
      );

      return res.redirect('/admin/cj/products');
    }
  },
);

/* =====================================================
 * Import or reimport selected variants
 * =================================================== */

router.post(
  '/admin/cj/products/:cjProductId/import',
  async (req, res) => {
    const cjProductId = safeString(
      req.params.cjProductId,
      300,
    );

    try {
      const selectedVariantIds =
        normalizeSelectedVariantIds(
          req.body.selectedVariants,
        );

      if (!selectedVariantIds.length) {
        req.flash(
          'error',
          'Select at least one CJ variant to import.',
        );

        return res.redirect(
          `/admin/cj/products/${encodeURIComponent(
            cjProductId,
          )}`,
        );
      }

      const markupPercent = Math.max(
        0,
        Math.min(
          10000,
          safeNonNegativeNumber(
            req.body.markupPercent,
            30,
          ),
        ),
      );

      const status = [
        'draft',
        'active',
        'paused',
      ].includes(
        safeString(req.body.status, 30),
      )
        ? safeString(req.body.status, 30)
        : 'draft';

      const submittedPrices = toObjectMap(
        req.body.variantSellingPrice,
      );

      /*
       * Re-query CJ now.
       * Never trust product costs or variants submitted by
       * the browser.
       */
      const detailResult =
        await getProductDetail(cjProductId);

      const sourceProduct = detailResult.product;

      const sourceVariantsById = new Map(
        sourceProduct.variants.map((variant) => [
          String(variant.cjVariantId),
          variant,
        ]),
      );

      const importedVariants = [];

      for (const selectedId of selectedVariantIds) {
        const sourceVariant =
          sourceVariantsById.get(selectedId);

        if (!sourceVariant) {
          continue;
        }

        const convertedCost =
          safeNonNegativeNumber(
            sourceVariant?.convertedSourceCost
              ?.value,
            0,
          );

        const manuallyEnteredPrice =
          safeNonNegativeNumber(
            submittedPrices[selectedId],
            0,
          );

        const sellingPriceExVat =
          manuallyEnteredPrice > 0
            ? Number(
                manuallyEnteredPrice.toFixed(2),
              )
            : calculateSellingPriceFromMarkup(
                convertedCost,
                markupPercent,
              );

        if (sellingPriceExVat < convertedCost) {
          const error = new Error(
            `Selling price for ${sourceVariant.variantSku} cannot be lower than the converted CJ source cost.`,
          );

          error.code =
            'CJ_SELLING_PRICE_BELOW_COST';

          throw error;
        }

        importedVariants.push({
          cjVariantId:
            sourceVariant.cjVariantId,

          variantSku:
            sourceVariant.variantSku,

          variantName:
            sourceVariant.variantName,

          variantKey:
            sourceVariant.variantKey,

          imageUrl:
            sourceVariant.imageUrl ||
            sourceProduct.mainImageUrl,

          barcode:
            sourceVariant.barcode,

          barcode2:
            sourceVariant.barcode2,

          weightGrams:
            sourceVariant.weightGrams,

          dimensionsMm:
            sourceVariant.dimensionsMm,

          sourceCostUsd: {
            value:
              sourceVariant.sourceCostUsd,

            currency: 'USD',
          },

          convertedSourceCost: {
            value: convertedCost,
            currency: BASE_CURRENCY,
          },

          sellingPriceExVat: {
            value: sellingPriceExVat,
            currency: BASE_CURRENCY,
          },

          fxSnapshot:
            sourceVariant.fxSnapshot,

          inventory:
            sourceVariant.inventory,

          totalInventory:
            sourceVariant.totalInventory,

          inventoryKnown:
            sourceVariant.inventoryKnown,

          isEnabled: true,
          lastSyncedAt: new Date(),

          lastInventorySyncAt:
            sourceVariant.inventoryKnown
              ? new Date()
              : null,
        });
      }

      if (!importedVariants.length) {
        const error = new Error(
          'None of the selected variants were found in the current CJ product response.',
        );

        error.code =
          'CJ_SELECTED_VARIANTS_NOT_FOUND';

        throw error;
      }

      const existingProduct =
        await CjProduct.findOne({
          cjProductId,
        });

      const before = existingProduct
        ? existingProduct.toObject()
        : null;

      /*
       * Preserve previously imported variants that were
       * not selected during this reimport, but disable them.
       * This protects historical order references later.
       */
      const selectedIdSet = new Set(
        importedVariants.map((variant) =>
          String(variant.cjVariantId),
        ),
      );

      const preservedDisabledVariants =
        Array.isArray(existingProduct?.variants)
          ? existingProduct.variants
              .filter(
                (variant) =>
                  !selectedIdSet.has(
                    String(
                      variant.cjVariantId,
                    ),
                  ),
              )
              .map((variant) => ({
                ...variant.toObject(),
                isEnabled: false,
              }))
          : [];

      const allVariants = [
        ...importedVariants,
        ...preservedDisabledVariants,
      ];

      const priceRange =
        calculateProductPriceRange(allVariants);

      const update = {
        source: 'CJ',
        cjProductId:
          sourceProduct.cjProductId,

        productSku:
          sourceProduct.productSku,

        name:
          safeString(
            req.body.kasyoraName,
            300,
          ) || sourceProduct.name,

        originalName:
          sourceProduct.originalName,

        descriptionHtml:
          sourceProduct.descriptionHtml,

        mainImageUrl:
          sourceProduct.mainImageUrl,

        images:
          sourceProduct.images,

        productType:
          sourceProduct.productType,

        productUnit:
          sourceProduct.productUnit,

        category:
          sourceProduct.category,

        customs:
          sourceProduct.customs,

        productWeightGrams:
          sourceProduct.productWeightGrams,

        packingWeightGrams:
          sourceProduct.packingWeightGrams,

        variants: allVariants,

        pricing: {
          baseCurrency: BASE_CURRENCY,

          vatRate: Number(
            process.env.VAT_RATE || 0.15,
          ),

          defaultMarkupPercent:
            markupPercent,

          minimumSellingPriceExVat:
            priceRange.minimum,

          maximumSellingPriceExVat:
            priceRange.maximum,
        },

        status,

        cjSaleStatus:
          sourceProduct.saleStatus,

        cjListedNumber:
          sourceProduct.listedNumber,

        sourceCreatedAt:
          sourceProduct.sourceCreatedAt,

        importedByAdmin:
          existingProduct
            ?.importedByAdmin ||
          getAdminId(req),

        importedAt:
          existingProduct?.importedAt ||
          new Date(),

        lastFullSyncAt: new Date(),

        lastSyncStatus: 'SUCCESS',
        lastSyncError: '',

        lastCjRequestId:
          detailResult.requestIds.detail ||
          detailResult.requestIds.variants,
      };

      const savedProduct =
        await CjProduct.findOneAndUpdate(
          {
            cjProductId,
          },
          {
            $set: update,
          },
          {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
            runValidators: true,
          },
        );

      const action = existingProduct
        ? 'REIMPORT'
        : 'IMPORT';

      await writeSyncLog({
        req,
        cjProduct: savedProduct,
        cjProductId,
        action,
        status: 'SUCCESS',

        requestId:
          detailResult.requestIds.detail ||
          detailResult.requestIds.variants,

        before,

        after: {
          status: savedProduct.status,
          variantCount:
            savedProduct.variants.length,

          enabledVariantCount:
            savedProduct.variants.filter(
              (variant) => variant.isEnabled,
            ).length,

          minimumSellingPriceExVat:
            savedProduct.pricing
              .minimumSellingPriceExVat,

          maximumSellingPriceExVat:
            savedProduct.pricing
              .maximumSellingPriceExVat,
        },
      });

      await logAdminAction(req, {
        action: `cj.product.${action.toLowerCase()}`,
        entityType: 'CjProduct',
        entityId: String(savedProduct._id),
        status: 'success',

        before,

        after: {
          cjProductId,
          status:
            savedProduct.status,

          enabledVariantCount:
            savedProduct.variants.filter(
              (variant) => variant.isEnabled,
            ).length,
        },
      });

      req.flash(
        'success',
        existingProduct
          ? 'CJ product updated successfully.'
          : 'CJ product imported successfully.',
      );

      return res.redirect(
        '/admin/cj/products/imported',
      );
    } catch (error) {
      console.error(
        '[CJ products] Import error:',
        error?.stack || error,
      );

      await writeSyncLog({
        req,
        cjProductId,
        action: 'IMPORT',
        status: 'FAILED',
        requestId: safeString(
          error?.requestId,
          200,
        ),

        message: safeString(
          error?.message,
          2000,
        ),
      });

      await logAdminAction(req, {
        action: 'cj.product.import',
        entityType: 'CjProduct',
        entityId: cjProductId,
        status: 'failure',

        meta: {
          code: safeString(
            error?.code,
            100,
          ),

          message: safeString(
            error?.message,
            1000,
          ),
        },
      });

      req.flash(
        'error',
        `CJ product import failed: ${
          safeString(error?.message, 1000) ||
          'Unknown error'
        }`,
      );

      return res.redirect(
        `/admin/cj/products/${encodeURIComponent(
          cjProductId,
        )}`,
      );
    }
  },
);

/* =====================================================
 * Update imported product status
 * =================================================== */

router.post(
  '/admin/cj/products/imported/:id/status',
  async (req, res) => {
    try {
      const status = safeString(
        req.body.status,
        30,
      );

      if (
        ![
          'draft',
          'active',
          'paused',
          'archived',
        ].includes(status)
      ) {
        req.flash(
          'error',
          'Invalid CJ product status.',
        );

        return res.redirect(
          '/admin/cj/products/imported',
        );
      }

      const product = await CjProduct.findById(
        req.params.id,
      );

      if (!product) {
        req.flash(
          'error',
          'Imported CJ product was not found.',
        );

        return res.redirect(
          '/admin/cj/products/imported',
        );
      }

      const before = {
        status: product.status,
      };

      product.status = status;
      await product.save();

      await writeSyncLog({
        req,
        cjProduct: product,
        cjProductId:
          product.cjProductId,

        action: 'STATUS_UPDATE',
        status: 'SUCCESS',
        before,

        after: {
          status,
        },
      });

      await logAdminAction(req, {
        action: 'cj.product.status-update',
        entityType: 'CjProduct',
        entityId: String(product._id),
        status: 'success',
        before,
        after: {
          status,
        },
      });

      req.flash(
        'success',
        `CJ product status changed to ${status}.`,
      );

      return res.redirect(
        '/admin/cj/products/imported',
      );
    } catch (error) {
      console.error(
        '[CJ products] Status update error:',
        error?.stack || error,
      );

      req.flash(
        'error',
        'CJ product status could not be updated.',
      );

      return res.redirect(
        '/admin/cj/products/imported',
      );
    }
  },
);

/* =====================================================
 * Update imported variant selling prices
 * =================================================== */

router.post(
  '/admin/cj/products/imported/:id/pricing',
  async (req, res) => {
    try {
      const product = await CjProduct.findById(
        req.params.id,
      );

      if (!product) {
        req.flash(
          'error',
          'Imported CJ product was not found.',
        );

        return res.redirect(
          '/admin/cj/products/imported',
        );
      }

      const submittedPrices = toObjectMap(
        req.body.variantSellingPrice,
      );

      const before = {
        pricing:
          product.pricing?.toObject?.() ||
          product.pricing,

        variants: product.variants.map(
          (variant) => ({
            cjVariantId:
              variant.cjVariantId,

            sellingPriceExVat:
              variant.sellingPriceExVat,
          }),
        ),
      };

      product.variants.forEach((variant) => {
        const submitted =
          safeNonNegativeNumber(
            submittedPrices[
              String(variant.cjVariantId)
            ],
            0,
          );

        if (submitted <= 0) {
          return;
        }

        const convertedCost =
          Number(
            variant?.convertedSourceCost
              ?.value || 0,
          );

        if (submitted < convertedCost) {
          const error = new Error(
            `Selling price for ${variant.variantSku} cannot be lower than its converted CJ cost.`,
          );

          error.code =
            'CJ_SELLING_PRICE_BELOW_COST';

          throw error;
        }

        variant.sellingPriceExVat.value =
          Number(submitted.toFixed(2));

        variant.sellingPriceExVat.currency =
          BASE_CURRENCY;
      });

      const priceRange =
        calculateProductPriceRange(
          product.variants,
        );

      product.pricing.minimumSellingPriceExVat =
        priceRange.minimum;

      product.pricing.maximumSellingPriceExVat =
        priceRange.maximum;

      await product.save();

      await writeSyncLog({
        req,
        cjProduct: product,
        cjProductId:
          product.cjProductId,

        action: 'PRICE_UPDATE',
        status: 'SUCCESS',
        before,

        after: {
          minimumSellingPriceExVat:
            priceRange.minimum,

          maximumSellingPriceExVat:
            priceRange.maximum,
        },
      });

      await logAdminAction(req, {
        action: 'cj.product.price-update',
        entityType: 'CjProduct',
        entityId: String(product._id),
        status: 'success',
        before,

        after: {
          minimumSellingPriceExVat:
            priceRange.minimum,

          maximumSellingPriceExVat:
            priceRange.maximum,
        },
      });

      req.flash(
        'success',
        'CJ product selling prices updated successfully.',
      );

      return res.redirect(
        '/admin/cj/products/imported',
      );
    } catch (error) {
      console.error(
        '[CJ products] Price update error:',
        error?.stack || error,
      );

      req.flash(
        'error',
        safeString(
          error?.message,
          1000,
        ) ||
          'CJ product prices could not be updated.',
      );

      return res.redirect(
        '/admin/cj/products/imported',
      );
    }
  },
);

module.exports = router;
