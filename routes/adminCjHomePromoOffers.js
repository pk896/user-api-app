// routes/adminCjHomePromoOffers.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const CjHomePromoOffer = require('../models/CjHomePromoOffer');
const CjProduct = require('../models/CjProduct');

const router = express.Router();

/*
 * This router manages only the Kasyora CJ Store
 * homepage promo-offer cards.
 *
 * It must never import or query:
 *
 * - Product
 * - HomePromoOffer
 * - Internal carts
 * - Internal checkout
 * - Internal orders
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

function normalizeSlot(value) {
  const slot = safeString(value, 20).toLowerCase();

  return ['left', 'right'].includes(slot)
    ? slot
    : null;
}

function normalizeSortOrder(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? Math.trunc(number)
    : fallback;
}

function normalizePayload(body = {}, slot) {
  return {
    cjProductId: safeString(
      body.cjProductId,
      300,
    ),

    eyebrowText: safeString(
      body.eyebrowText,
      120,
    ),

    titleOverride: safeString(
      body.titleOverride,
      120,
    ),

    discountText: safeString(
      body.discountText,
      40,
    ),

    active:
      String(body.active || '') === 'on',

    sortOrder: normalizeSortOrder(
      body.sortOrder,
      slot === 'left' ? 1 : 2,
    ),
  };
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
          safeString(
            variant?.variantSku,
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

function promoOfferSnapshot(offer) {
  if (!offer) {
    return null;
  }

  return {
    slot: safeString(
      offer.slot,
      20,
    ),

    cjProductId: safeString(
      offer.cjProductId,
      300,
    ),

    eyebrowText: safeString(
      offer.eyebrowText,
      120,
    ),

    titleOverride: safeString(
      offer.titleOverride,
      120,
    ),

    discountText: safeString(
      offer.discountText,
      40,
    ),

    active:
      offer.active === true,

    sortOrder: normalizeSortOrder(
      offer.sortOrder,
      0,
    ),
  };
}

/*
 * A CJ product is eligible for a promo card only when:
 *
 * - it is an imported CjProduct
 * - its status is active
 * - it has at least one enabled variant
 * - the enabled variant has a valid selling price
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

        variantSku: {
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
 * CJ HOME PROMO OFFERS DASHBOARD
 * =================================================== */

router.get(
  '/cj-home-promo-offers',
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
      const offers =
        await CjHomePromoOffer.find({})
          .sort({
            sortOrder: 1,
            createdAt: 1,
          })
          .lean();

      const offersWithProducts =
        await Promise.all(
          offers.map(async (offer) => {
            let product = null;

            if (offer?.cjProductId) {
              const rawProduct =
                await CjProduct.findOne(
                  buildEligibleCjProductQuery({
                    cjProductId:
                      offer.cjProductId,
                  }),
                ).lean();

              product =
                getCjProductPreview(
                  rawProduct,
                );
            }

            return {
              ...offer,
              product,
            };
          }),
        );

      return res.render(
        'admin/cj-home-promo-offers/index',
        {
          title:
            'CJ Homepage Promo Offers',

          themeCss:
            themeCssFromSession(req),

          nonce:
            res.locals.nonce,

          offers:
            offersWithProducts,

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
        '❌ CJ homepage promo offers dashboard error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ homepage promo offers.',
      );

      return res.redirect(
        '/admin/home-banners',
      );
    }
  },
);

/* =====================================================
 * EDIT CJ PROMO OFFER BY SLOT
 * =================================================== */

router.get(
  '/cj-home-promo-offers/:slot/edit',
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
      const slot =
        normalizeSlot(
          req.params.slot,
        );

      if (!slot) {
        req.flash(
          'error',
          'Invalid CJ promo-offer slot.',
        );

        return res.redirect(
          '/admin/cj-home-promo-offers',
        );
      }

      const offer =
        await CjHomePromoOffer.findOne({
          slot,
        }).lean();

      let selectedProduct = null;

      if (offer?.cjProductId) {
        const product =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                offer.cjProductId,
            }),
          ).lean();

        selectedProduct =
          getCjProductPreview(product);
      }

      return res.render(
        'admin/cj-home-promo-offers/edit',
        {
          title:
            `${slot === 'left' ? 'Left' : 'Right'} CJ Promo Offer`,

          themeCss:
            themeCssFromSession(req),

          nonce:
            res.locals.nonce,

          slot,
          offer,
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
        '❌ CJ promo-offer edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ promo offer.',
      );

      return res.redirect(
        '/admin/cj-home-promo-offers',
      );
    }
  },
);

/* =====================================================
 * SEARCH IMPORTED CJ PRODUCTS
 * =================================================== */

router.get(
  '/cj-home-promo-offers/products/search',
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
                productSku:
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
        '❌ CJ promo-offer product search error:',
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
 * CREATE OR UPDATE CJ PROMO OFFER
 * =================================================== */

router.post(
  '/cj-home-promo-offers/:slot',
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
      const slot =
        normalizeSlot(
          req.params.slot,
        );

      if (!slot) {
        req.flash(
          'error',
          'Invalid CJ promo-offer slot.',
        );

        return res.redirect(
          '/admin/cj-home-promo-offers',
        );
      }

      const payload =
        normalizePayload(
          req.body,
          slot,
        );

      if (!payload.cjProductId) {
        req.flash(
          'error',
          'Please search for and select an imported CJ product.',
        );

        return res.redirect(
          `/admin/cj-home-promo-offers/${slot}/edit`,
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
          `/admin/cj-home-promo-offers/${slot}/edit`,
        );
      }

      let offer =
        await CjHomePromoOffer.findOne({
          slot,
        });

      const before =
        promoOfferSnapshot(offer);

      const isCreate =
        !offer;

      if (!offer) {
        offer =
          new CjHomePromoOffer({
            slot,

            cjProductId:
              payload.cjProductId,

            eyebrowText:
              payload.eyebrowText,

            titleOverride:
              payload.titleOverride,

            discountText:
              payload.discountText,

            active:
              payload.active,

            sortOrder:
              payload.sortOrder,
          });
      } else {
        offer.cjProductId =
          payload.cjProductId;

        offer.eyebrowText =
          payload.eyebrowText;

        offer.titleOverride =
          payload.titleOverride;

        offer.discountText =
          payload.discountText;

        offer.active =
          payload.active;

        offer.sortOrder =
          payload.sortOrder;
      }

      await offer.save();

      await logAdminAction(req, {
        action: isCreate
          ? 'cj.home_promo_offer.create'
          : 'cj.home_promo_offer.update',

        entityType:
          'CjHomePromoOffer',

        entityId:
          String(offer._id),

        status:
          'success',

        before,

        after:
          promoOfferSnapshot(offer),

        meta: {
          department:
            'cj',

          section:
            'cj_home_promo_offers',

          slot,

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
        `${slot === 'left' ? 'Left' : 'Right'} CJ promo offer ${
          isCreate
            ? 'created'
            : 'updated'
        } successfully.`,
      );

      return res.redirect(
        '/admin/cj-home-promo-offers',
      );
    } catch (error) {
      console.error(
        '❌ save CJ homepage promo offer error:',
        error,
      );

      req.flash(
        'error',
        'Failed to save the CJ homepage promo offer.',
      );

      const slot =
        normalizeSlot(
          req.params.slot,
        );

      return res.redirect(
        slot
          ? `/admin/cj-home-promo-offers/${slot}/edit`
          : '/admin/cj-home-promo-offers',
      );
    }
  },
);

/* =====================================================
 * ACTIVATE OR DEACTIVATE CJ PROMO OFFER
 * =================================================== */

router.get(
  '/cj-home-promo-offers/:slot/toggle',
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
      const slot =
        normalizeSlot(
          req.params.slot,
        );

      if (!slot) {
        req.flash(
          'error',
          'Invalid CJ promo-offer slot.',
        );

        return res.redirect(
          '/admin/cj-home-promo-offers',
        );
      }

      const offer =
        await CjHomePromoOffer.findOne({
          slot,
        });

      if (!offer) {
        req.flash(
          'error',
          `The ${slot} CJ promo offer has not been configured yet.`,
        );

        return res.redirect(
          '/admin/cj-home-promo-offers',
        );
      }

      const before =
        promoOfferSnapshot(offer);

      offer.active =
        !offer.active;

      await offer.save();

      await logAdminAction(req, {
        action:
          offer.active
            ? 'cj.home_promo_offer.activate'
            : 'cj.home_promo_offer.deactivate',

        entityType:
          'CjHomePromoOffer',

        entityId:
          String(offer._id),

        status:
          'success',

        before,

        after:
          promoOfferSnapshot(offer),

        meta: {
          department:
            'cj',

          section:
            'cj_home_promo_offers',

          slot,
        },
      });

      req.flash(
        'success',
        `${slot === 'left' ? 'Left' : 'Right'} CJ promo offer ${
          offer.active
            ? 'activated'
            : 'deactivated'
        } successfully.`,
      );

      return res.redirect(
        '/admin/cj-home-promo-offers',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ homepage promo offer error:',
        error,
      );

      req.flash(
        'error',
        'Failed to update the CJ promo-offer status.',
      );

      return res.redirect(
        '/admin/cj-home-promo-offers',
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
      '❌ adminCjHomePromoOffers route error:',
      error?.message || error,
    );

    req.flash(
      'error',
      error?.message ||
        'Unexpected CJ homepage promo-offer error.',
    );

    const back =
      req.get('referer');

    if (back) {
      return res.redirect(back);
    }

    return res.redirect(
      '/admin/cj-home-promo-offers',
    );
  },
);

module.exports = router;
