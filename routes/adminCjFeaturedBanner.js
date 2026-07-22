// routes/adminCjFeaturedBanner.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const CjFeaturedBanner = require('../models/CjFeaturedBanner');
const CjProduct = require('../models/CjProduct');

const router = express.Router();

/*
 * This router manages only the Kasyora CJ Store homepage
 * Featured Right-side Banner.
 *
 * It must never import or query:
 *
 * - Product
 * - FeaturedBanner
 * - Internal carts
 * - Internal orders
 * - Internal checkout
 */

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';

  return theme === 'dark'
    ? '/css/dark.css'
    : '/css/light.css';
}

function safeString(value, maxLength = 500) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function escapeRegex(value) {
  return String(value || '')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getEnabledPricedVariants(product) {
  return Array.isArray(product?.variants)
    ? product.variants.filter((variant) => {
        const price = Number(
          variant?.sellingPriceExVat?.value,
        );

        return (
          variant?.isEnabled === true &&
          safeString(
            variant?.cjVariantId,
            300,
          ) &&
          Number.isFinite(price) &&
          price >= 0
        );
      })
    : [];
}

function getCjProductPreview(product) {
  if (!product) {
    return null;
  }

  const variants =
    getEnabledPricedVariants(product);

  const defaultVariant =
    variants[0] || null;

  const prices = variants
    .map((variant) =>
      Number(
        variant?.sellingPriceExVat?.value,
      ),
    )
    .filter(
      (price) =>
        Number.isFinite(price) &&
        price >= 0,
    );

  const lowestPrice =
    prices.length > 0
      ? Math.min(...prices)
      : 0;

  const categoryName = safeString(
    product?.category?.name ||
      product?.category?.secondName ||
      product?.category?.firstName ||
      product?.productType ||
      'CJ Product',
    500,
  );

  return {
    cjProductId: safeString(
      product?.cjProductId,
      300,
    ),

    productSku: safeString(
      product?.productSku,
      300,
    ),

    name: safeString(
      product?.name || 'CJ Product',
      500,
    ),

    imageUrl: safeString(
      defaultVariant?.imageUrl ||
        product?.mainImageUrl ||
        '',
      2000,
    ),

    category: categoryName,

    price: Number(
      lowestPrice.toFixed(2),
    ),

    enabledVariantCount:
      variants.length,

    status: safeString(
      product?.status,
      30,
    ),

    url:
      '/cj/product/' +
      encodeURIComponent(
        safeString(
          product?.cjProductId,
          300,
        ),
      ),
  };
}

function cjFeaturedBannerSnapshot(banner) {
  if (!banner) {
    return null;
  }

  return {
    slot: safeString(
      banner.slot,
      30,
    ),

    cjProductId: safeString(
      banner.cjProductId,
      300,
    ),

    badgeText: safeString(
      banner.badgeText,
      80,
    ),

    offerText: safeString(
      banner.offerText,
      120,
    ),

    active:
      banner.active === true,
  };
}

function normalizeBannerPayload(body = {}) {
  return {
    cjProductId: safeString(
      body.cjProductId,
      300,
    ),

    badgeText:
      safeString(
        body.badgeText,
        80,
      ) || 'Special Offer',

    offerText:
      safeString(
        body.offerText,
        120,
      ) || 'Featured CJ Product',

    active:
      String(
        body.active || '',
      ) === 'on',
  };
}

/*
 * A CJ product is eligible for the homepage banner only when:
 *
 * - it is an imported CjProduct
 * - its status is active
 * - it has an enabled variant
 * - that enabled variant has a valid CJ selling price
 */
function buildEligibleCjProductQuery(
  extraQuery = {},
) {
  return {
    status: 'active',

    variants: {
      $elemMatch: {
        isEnabled: true,

        cjVariantId: {
          $exists: true,
          $ne: '',
        },

        'sellingPriceExVat.value': {
          $gte: 0,
        },
      },
    },

    ...extraQuery,
  };
}

/* =====================================================
 * EDIT CJ FEATURED BANNER PAGE
 * =================================================== */

router.get(
  '/cj-featured-banner',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const banner =
        await CjFeaturedBanner.findOne({
          slot: 'right',
        })
          .sort({
            updatedAt: -1,
          })
          .lean();

      let selectedProduct = null;

      if (banner?.cjProductId) {
        const product =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                banner.cjProductId,
            }),
          ).lean();

        selectedProduct =
          getCjProductPreview(product);
      }

      return res.render(
        'admin/cj-featured-banner/edit',
        {
          title:
            'CJ Featured Right-side Banner',

          themeCss:
            themeCssFromSession(req),

          nonce:
            res.locals.nonce,

          banner,

          selectedProduct,

          success:
            req.flash('success'),

          error:
            req.flash('error'),

          info:
            req.flash('info'),

          warning:
            req.flash('warning'),
        },
      );
    } catch (error) {
      console.error(
        '❌ CJ featured banner edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ featured banner settings.',
      );

      return res.redirect(
        '/admin/home-banners',
      );
    }
  },
);

/* =====================================================
 * SEARCH IMPORTED CJ PRODUCTS
 * =================================================== */

router.get(
  '/cj-featured-banner/products/search',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const keyword = safeString(
        req.query.q,
        200,
      );

      if (!keyword) {
        return res.json({
          success: true,
          products: [],
        });
      }

      const keywordRegex =
        new RegExp(
          escapeRegex(keyword),
          'i',
        );

      const products =
        await CjProduct.find(
          buildEligibleCjProductQuery({
            $or: [
              {
                cjProductId:
                  keywordRegex,
              },

              {
                name:
                  keywordRegex,
              },

              {
                originalName:
                  keywordRegex,
              },

              {
                productSku:
                  keywordRegex,
              },

              {
                productType:
                  keywordRegex,
              },

              {
                'category.name':
                  keywordRegex,
              },

              {
                'category.firstName':
                  keywordRegex,
              },

              {
                'category.secondName':
                  keywordRegex,
              },

              {
                'variants.variantSku':
                  keywordRegex,
              },

              {
                'variants.variantName':
                  keywordRegex,
              },
            ],
          }),
        )
          .sort({
            updatedAt: -1,
            importedAt: -1,
            _id: -1,
          })
          .limit(20)
          .lean();

      const safeProducts =
        products
          .map(
            getCjProductPreview,
          )
          .filter(
            (product) =>
              product &&
              product.cjProductId &&
              product
                .enabledVariantCount > 0,
          );

      return res.json({
        success: true,
        products: safeProducts,
      });
    } catch (error) {
      console.error(
        '❌ CJ featured banner product search error:',
        error,
      );

      return res.status(500).json({
        success: false,
        products: [],
        message:
          'Failed to search imported CJ products.',
      });
    }
  },
);

/* =====================================================
 * SAVE CJ FEATURED BANNER
 * =================================================== */

router.post(
  '/cj-featured-banner',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const payload =
        normalizeBannerPayload(
          req.body,
        );

      if (!payload.cjProductId) {
        req.flash(
          'error',
          'Please search for and select an imported CJ product.',
        );

        return res.redirect(
          '/admin/cj-featured-banner',
        );
      }

      const product =
        await CjProduct.findOne(
          buildEligibleCjProductQuery({
            cjProductId:
              payload.cjProductId,
          }),
        ).lean();

      const productPreview =
        getCjProductPreview(product);

      if (
        !productPreview ||
        !productPreview.cjProductId ||
        productPreview
          .enabledVariantCount < 1
      ) {
        req.flash(
          'error',
          'The selected CJ product is unavailable, inactive, or has no enabled variant with a valid selling price.',
        );

        return res.redirect(
          '/admin/cj-featured-banner',
        );
      }

      let banner =
        await CjFeaturedBanner.findOne({
          slot: 'right',
        });

      const before =
        cjFeaturedBannerSnapshot(
          banner,
        );

      const isCreate =
        !banner;

      if (!banner) {
        banner =
          new CjFeaturedBanner({
            slot: 'right',

            cjProductId:
              payload.cjProductId,

            badgeText:
              payload.badgeText,

            offerText:
              payload.offerText,

            active:
              payload.active,
          });
      } else {
        banner.cjProductId =
          payload.cjProductId;

        banner.badgeText =
          payload.badgeText;

        banner.offerText =
          payload.offerText;

        banner.active =
          payload.active;
      }

      await banner.save();

      await logAdminAction(req, {
        action: isCreate
          ? 'cj.featured_banner.create'
          : 'cj.featured_banner.update',

        entityType:
          'CjFeaturedBanner',

        entityId:
          String(banner._id),

        status:
          'success',

        before,

        after:
          cjFeaturedBannerSnapshot(
            banner,
          ),

        meta: {
          department:
            'cj',

          section:
            'cj_featured_right_banner',

          slot:
            'right',

          cjProductId:
            productPreview.cjProductId,

          productName:
            productPreview.name,

          productSku:
            productPreview.productSku,

          enabledVariantCount:
            productPreview
              .enabledVariantCount,
        },
      });

      req.flash(
        'success',
        isCreate
          ? 'CJ Featured Right-side Banner created successfully.'
          : 'CJ Featured Right-side Banner updated successfully.',
      );

      return res.redirect(
        '/admin/cj-featured-banner',
      );
    } catch (error) {
      console.error(
        '❌ save CJ featured banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to save the CJ Featured Right-side Banner.',
      );

      return res.redirect(
        '/admin/cj-featured-banner',
      );
    }
  },
);

/* =====================================================
 * TOGGLE CJ FEATURED BANNER STATUS
 * =================================================== */

router.get(
  '/cj-featured-banner/toggle',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const banner =
        await CjFeaturedBanner.findOne({
          slot: 'right',
        });

      if (!banner) {
        req.flash(
          'error',
          'The CJ Featured Right-side Banner has not been configured yet.',
        );

        return res.redirect(
          '/admin/cj-featured-banner',
        );
      }

      const before =
        cjFeaturedBannerSnapshot(
          banner,
        );

      banner.active =
        !banner.active;

      await banner.save();

      await logAdminAction(req, {
        action:
          banner.active
            ? 'cj.featured_banner.activate'
            : 'cj.featured_banner.deactivate',

        entityType:
          'CjFeaturedBanner',

        entityId:
          String(banner._id),

        status:
          'success',

        before,

        after:
          cjFeaturedBannerSnapshot(
            banner,
          ),

        meta: {
          department:
            'cj',

          section:
            'cj_featured_right_banner',

          slot:
            'right',
        },
      });

      req.flash(
        'success',
        `CJ Featured Right-side Banner ${
          banner.active
            ? 'activated'
            : 'deactivated'
        } successfully.`,
      );

      return res.redirect(
        '/admin/cj-featured-banner',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ featured banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to update the CJ featured banner status.',
      );

      return res.redirect(
        '/admin/cj-featured-banner',
      );
    }
  },
);

/* =====================================================
 * ROUTER ERROR HANDLER
 * =================================================== */

router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjFeaturedBanner route error:',
      error?.message || error,
    );

    req.flash(
      'error',
      error?.message ||
        'Unexpected CJ featured banner error.',
    );

    const back =
      req.get('referer');

    if (back) {
      return res.redirect(
        back,
      );
    }

    return res.redirect(
      '/admin/cj-featured-banner',
    );
  },
);

module.exports = router;
