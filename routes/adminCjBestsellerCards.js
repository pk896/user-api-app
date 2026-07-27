// routes/adminCjBestsellerCards.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const { logAdminAction } = require('../utils/logAdminAction');

const CjBestsellerCard = require('../models/CjBestsellerCard');
const CjProduct = require('../models/CjProduct');

/*
 * Completely separate CJ Bestseller Cards admin flow.
 *
 * This router must never reference:
 *
 * - Product
 * - Product.customId
 * - BestsellerCard
 * - Internal Kasyora cart, checkout, payment or orders
 */

function themeCssFromSession(req) {
  const theme =
    req.session?.theme || 'light';

  return theme === 'dark'
    ? '/css/dark.css'
    : '/css/light.css';
}

function normalizeSlot(value) {
  const slot =
    String(value || '')
      .trim()
      .toLowerCase();

  return ['left', 'right'].includes(slot)
    ? slot
    : '';
}

function normalizePayload(body) {
  const rawSortOrder =
    Number(body?.sortOrder || 0);

  return {
    cjProductId:
      String(
        body?.cjProductId || '',
      ).trim(),

    eyebrowText:
      String(
        body?.eyebrowText || '',
      ).trim(),

    titleOverride:
      String(
        body?.titleOverride || '',
      ).trim(),

    discountText:
      String(
        body?.discountText || '',
      ).trim(),

    buttonText:
      String(
        body?.buttonText ||
        'Explore Product',
      ).trim(),

    supportingText:
      String(
        body?.supportingText || '',
      ).trim(),

    active:
      String(
        body?.active || '',
      ) === 'on',

    sortOrder:
      Number.isFinite(rawSortOrder)
        ? Math.min(
            Math.max(
              Math.floor(rawSortOrder),
              0,
            ),
            1000,
          )
        : 0,
  };
}

function cjBestsellerCardSnapshot(card) {
  if (!card) {
    return null;
  }

  return {
    slot:
      String(
        card.slot || '',
      ),

    cjProductId:
      String(
        card.cjProductId || '',
      ),

    eyebrowText:
      String(
        card.eyebrowText || '',
      ),

    titleOverride:
      String(
        card.titleOverride || '',
      ),

    discountText:
      String(
        card.discountText || '',
      ),

    buttonText:
      String(
        card.buttonText || '',
      ),

    supportingText:
      String(
        card.supportingText || '',
      ),

    active:
      card.active === true,

    sortOrder:
      Number(
        card.sortOrder || 0,
      ),
  };
}

/*
 * Every selectable CJ product must:
 *
 * - be active
 * - contain an enabled variant
 * - contain a CJ variant ID
 * - contain a variant SKU
 * - contain a valid Kasyora selling price excluding VAT
 */
function eligibleCjProductQuery(extraQuery = {}) {
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

function getEnabledEligibleVariants(product) {
  if (!Array.isArray(product?.variants)) {
    return [];
  }

  return product.variants.filter(
    (variant) => {
      const cjVariantId =
        String(
          variant?.cjVariantId || '',
        ).trim();

      const variantSku =
        String(
          variant?.variantSku || '',
        ).trim();

      const price =
        Number(
          variant?.sellingPriceExVat
            ?.value,
        );

      return (
        variant?.isEnabled === true &&
        Boolean(cjVariantId) &&
        Boolean(variantSku) &&
        Number.isFinite(price) &&
        price >= 0
      );
    },
  );
}

function mapAdminCjProduct(product) {
  if (!product) {
    return null;
  }

  const eligibleVariants =
    getEnabledEligibleVariants(
      product,
    );

  if (
    eligibleVariants.length < 1
  ) {
    return null;
  }

  const prices =
    eligibleVariants
      .map((variant) =>
        Number(
          variant?.sellingPriceExVat
            ?.value,
        ),
      )
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value >= 0,
      );

  const lowestPrice =
    prices.length > 0
      ? Math.min(...prices)
      : 0;

  const firstVariant =
    eligibleVariants[0] || null;

  const imageUrl =
    String(
      firstVariant?.imageUrl ||
      firstVariant?.image ||
      product?.mainImageUrl ||
      '',
    ).trim();

  const category =
    String(
      product?.category?.name ||
      product?.category?.secondName ||
      product?.category?.firstName ||
      product?.productType ||
      'CJ Product',
    ).trim();

  return {
    cjProductId:
      String(
        product.cjProductId || '',
      ).trim(),

    productSku:
      String(
        product.productSku || '',
      ).trim(),

    name:
      String(
        product.name ||
        'CJ Product',
      ).trim(),

    imageUrl,

    category,

    price:
      Number(
        lowestPrice.toFixed(2),
      ),

    enabledVariantCount:
      eligibleVariants.length,
  };
}

async function findEligibleCjProduct(
  cjProductId,
) {
  const safeCjProductId =
    String(
      cjProductId || '',
    ).trim();

  if (!safeCjProductId) {
    return null;
  }

  return CjProduct.findOne(
    eligibleCjProductQuery({
      cjProductId:
        safeCjProductId,
    }),
  ).lean();
}

/*
 * =====================================================
 * INDEX
 * =====================================================
 */
router.get(
  '/cj-bestseller-cards',

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
      const cards =
        await CjBestsellerCard
          .find({})
          .sort({
            sortOrder: 1,
            createdAt: 1,
          })
          .lean();

      const cardsWithProducts =
        await Promise.all(
          cards.map(
            async (card) => {
              let product = null;

              if (
                card?.cjProductId
              ) {
                const rawProduct =
                  await findEligibleCjProduct(
                    card.cjProductId,
                  );

                product =
                  mapAdminCjProduct(
                    rawProduct,
                  );
              }

              return {
                ...card,
                product,
              };
            },
          ),
        );

      return res.render(
        'admin/cj-bestseller-cards/index',
        {
          title:
            'CJ Bestseller Cards',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          cards:
            cardsWithProducts,

          success:
            req.flash(
              'success',
            ),

          error:
            req.flash(
              'error',
            ),

          info:
            req.flash(
              'info',
            ),

          warning:
            req.flash(
              'warning',
            ),
        },
      );
    } catch (error) {
      console.error(
        '❌ CJ bestseller cards index error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ bestseller cards.',
      );

      return res.redirect(
        '/admin/dashboard',
      );
    }
  },
);

/*
 * =====================================================
 * EDIT
 * =====================================================
 */
router.get(
  '/cj-bestseller-cards/:slot/edit',

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
          'Invalid CJ bestseller card slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards',
        );
      }

      const cardRaw =
        await CjBestsellerCard
          .findOne({
            slot,
          })
          .lean();

      let selectedProduct = null;

      if (
        cardRaw?.cjProductId
      ) {
        const rawProduct =
          await findEligibleCjProduct(
            cardRaw.cjProductId,
          );

        selectedProduct =
          mapAdminCjProduct(
            rawProduct,
          );
      }

      const card =
        cardRaw
          ? {
              ...cardRaw,
              product:
                selectedProduct,
            }
          : null;

      return res.render(
        'admin/cj-bestseller-cards/edit',
        {
          title:
            'Edit ' +
            (
              slot === 'left'
                ? 'Left'
                : 'Right'
            ) +
            ' CJ Bestseller Card',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          slot,

          card,

          selectedProduct,

          success:
            req.flash(
              'success',
            ),

          error:
            req.flash(
              'error',
            ),

          info:
            req.flash(
              'info',
            ),

          warning:
            req.flash(
              'warning',
            ),
        },
      );
    } catch (error) {
      console.error(
        '❌ CJ bestseller card edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ bestseller card.',
      );

      return res.redirect(
        '/admin/cj-bestseller-cards',
      );
    }
  },
);

/*
 * =====================================================
 * SEARCH ELIGIBLE CJ PRODUCTS
 * =====================================================
 */
router.get(
  '/cj-bestseller-cards/products/search',

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
      const queryText =
        String(
          req.query.q || '',
        ).trim();

      if (!queryText) {
        return res.json({
          success: true,
          products: [],
        });
      }

      const safeQuery =
        queryText.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );

      const queryRegex =
        new RegExp(
          safeQuery,
          'i',
        );

      const products =
        await CjProduct.find(
          eligibleCjProductQuery({
            $or: [
              {
                cjProductId:
                  queryRegex,
              },

              {
                productSku:
                  queryRegex,
              },

              {
                name:
                  queryRegex,
              },

              {
                originalName:
                  queryRegex,
              },

              {
                productType:
                  queryRegex,
              },

              {
                'category.name':
                  queryRegex,
              },

              {
                'category.firstName':
                  queryRegex,
              },

              {
                'category.secondName':
                  queryRegex,
              },

              {
                'variants.variantSku':
                  queryRegex,
              },

              {
                'variants.variantName':
                  queryRegex,
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

      const mappedProducts =
        products
          .map(
            mapAdminCjProduct,
          )
          .filter(
            (product) =>
              product &&
              product.cjProductId &&
              product.enabledVariantCount >
                0,
          );

      return res.json({
        success: true,
        products:
          mappedProducts,
      });
    } catch (error) {
      console.error(
        '❌ CJ bestseller card product search error:',
        error,
      );

      return res.status(500).json({
        success: false,
        products: [],
        message:
          'Failed to search eligible CJ products.',
      });
    }
  },
);

/*
 * =====================================================
 * SAVE
 * =====================================================
 */
router.post(
  '/cj-bestseller-cards/:slot',

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
          'Invalid CJ bestseller card slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards',
        );
      }

      const payload =
        normalizePayload(
          req.body,
        );

      if (
        !payload.cjProductId
      ) {
        req.flash(
          'error',
          'Please select a CJ product.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards/' +
          slot +
          '/edit',
        );
      }

      const rawProduct =
        await findEligibleCjProduct(
          payload.cjProductId,
        );

      const product =
        mapAdminCjProduct(
          rawProduct,
        );

      if (!product) {
        req.flash(
          'error',
          'The selected CJ product was not found, is inactive, or has no enabled checkout-ready variant.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards/' +
          slot +
          '/edit',
        );
      }

      let card =
        await CjBestsellerCard
          .findOne({
            slot,
          });

      const before =
        cjBestsellerCardSnapshot(
          card,
        );

      const isCreate =
        !card;

      if (!card) {
        card =
          new CjBestsellerCard({
            slot,
            ...payload,
          });
      } else {
        card.cjProductId =
          payload.cjProductId;

        card.eyebrowText =
          payload.eyebrowText;

        card.titleOverride =
          payload.titleOverride;

        card.discountText =
          payload.discountText;

        card.buttonText =
          payload.buttonText;

        card.supportingText =
          payload.supportingText;

        card.active =
          payload.active;

        card.sortOrder =
          payload.sortOrder;
      }

      await card.save();

      await logAdminAction(
        req,
        {
          action:
            isCreate
              ? 'store.cj_bestseller_card.create'
              : 'store.cj_bestseller_card.update',

          entityType:
            'cj_bestseller_card',

          entityId:
            String(
              card._id,
            ),

          status:
            'success',

          before,

          after:
            cjBestsellerCardSnapshot(
              card,
            ),

          meta: {
            section:
              'cj_bestseller_cards',

            department:
              'CJ',

            slot,

            cjProductId:
              payload.cjProductId,

            productSku:
              product.productSku || '',

            productName:
              product.name || '',
          },
        },
      );

      req.flash(
        'success',
        (
          slot === 'left'
            ? 'Left'
            : 'Right'
        ) +
          ' CJ bestseller card saved successfully.',
      );

      return res.redirect(
        '/admin/cj-bestseller-cards',
      );
    } catch (error) {
      console.error(
        '❌ save CJ bestseller card error:',
        error,
      );

      req.flash(
        'error',
        error?.message ||
          'Failed to save the CJ bestseller card.',
      );

      return res.redirect(
        '/admin/cj-bestseller-cards',
      );
    }
  },
);

/*
 * =====================================================
 * TOGGLE
 * =====================================================
 */
router.get(
  '/cj-bestseller-cards/:slot/toggle',

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
          'Invalid CJ bestseller card slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards',
        );
      }

      const card =
        await CjBestsellerCard
          .findOne({
            slot,
          });

      if (!card) {
        req.flash(
          'error',
          'CJ bestseller card not found for that slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-cards',
        );
      }

      const before =
        cjBestsellerCardSnapshot(
          card,
        );

      card.active =
        !card.active;

      await card.save();

      await logAdminAction(
        req,
        {
          action:
            card.active
              ? 'store.cj_bestseller_card.activate'
              : 'store.cj_bestseller_card.deactivate',

          entityType:
            'cj_bestseller_card',

          entityId:
            String(
              card._id,
            ),

          status:
            'success',

          before,

          after:
            cjBestsellerCardSnapshot(
              card,
            ),

          meta: {
            section:
              'cj_bestseller_cards',

            department:
              'CJ',

            slot,

            cjProductId:
              String(
                card.cjProductId || '',
              ),
          },
        },
      );

      req.flash(
        'success',
        (
          slot === 'left'
            ? 'Left'
            : 'Right'
        ) +
          ' CJ bestseller card ' +
          (
            card.active
              ? 'activated'
              : 'deactivated'
          ) +
          ' successfully.',
      );

      return res.redirect(
        '/admin/cj-bestseller-cards',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ bestseller card error:',
        error,
      );

      req.flash(
        'error',
        'Failed to toggle the CJ bestseller card.',
      );

      return res.redirect(
        '/admin/cj-bestseller-cards',
      );
    }
  },
);

/*
 * =====================================================
 * ROUTE ERROR HANDLER
 * =====================================================
 */
router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjBestsellerCards route error:',
      error?.message ||
      error,
    );

    req.flash(
      'error',
      error?.message ||
        'Unexpected CJ bestseller card server error.',
    );

    const back =
      req.get(
        'referer',
      );

    if (back) {
      return res.redirect(
        back,
      );
    }

    return res.redirect(
      '/admin/cj-bestseller-cards',
    );
  },
);

module.exports = router;