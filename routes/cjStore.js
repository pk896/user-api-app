// routes/cjStore.js
'use strict';

const express = require('express');

const CjProduct = require('../models/CjProduct');
const ShopHeaderImage = require('../models/ShopHeaderImage');

const {
  ensureCjCart,
  publicCjCart,
} = require('../utils/cj/cjCart');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '')
    .trim()
    .toUpperCase() || 'USD';

const VAT_RATE = Number.isFinite(
  Number(process.env.VAT_RATE),
)
  ? Number(process.env.VAT_RATE)
  : 0.15;

function safeString(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function round2(value) {
  return Math.round(
    Number(value || 0) * 100,
  ) / 100;
}

function enabledCjVariants(product) {
  return Array.isArray(product?.variants)
    ? product.variants.filter(
        (variant) =>
          variant?.isEnabled === true &&
          safeString(
            variant?.cjVariantId,
            300,
          ) &&
          safeString(
            variant?.variantSku,
            300,
          ) &&
          Number.isFinite(
            Number(
              variant?.sellingPriceExVat?.value,
            ),
          ),
      )
    : [];
}

function mapCjVariant(product, variant) {
  const priceExVat = round2(
    variant?.sellingPriceExVat?.value,
  );

  const vatRate = Number.isFinite(
    Number(product?.pricing?.vatRate),
  )
    ? Number(product.pricing.vatRate)
    : VAT_RATE;

  const priceIncVat = round2(
    priceExVat * (1 + vatRate),
  );

  const inventoryKnown =
    variant?.inventoryKnown === true;

  const totalInventory = Math.max(
    0,
    Math.floor(
      Number(variant?.totalInventory || 0),
    ),
  );

  return {
    cjVariantId: safeString(
      variant?.cjVariantId,
      300,
    ),

    variantSku: safeString(
      variant?.variantSku,
      300,
    ),

    variantName:
      safeString(
        variant?.variantName ||
          variant?.variantKey ||
          variant?.variantSku ||
          'Variant',
        500,
      ),

    variantKey: safeString(
      variant?.variantKey,
      500,
    ),

    imageUrl:
      safeString(
        variant?.imageUrl ||
          product?.mainImageUrl,
        2000,
      ),

    barcode: safeString(
      variant?.barcode,
      300,
    ),

    weightGrams:
      Number.isFinite(
        Number(variant?.weightGrams),
      )
        ? Number(variant.weightGrams)
        : null,

    dimensionsMm: {
      length:
        Number.isFinite(
          Number(
            variant?.dimensionsMm?.length,
          ),
        )
          ? Number(
              variant.dimensionsMm.length,
            )
          : null,

      width:
        Number.isFinite(
          Number(
            variant?.dimensionsMm?.width,
          ),
        )
          ? Number(
              variant.dimensionsMm.width,
            )
          : null,

      height:
        Number.isFinite(
          Number(
            variant?.dimensionsMm?.height,
          ),
        )
          ? Number(
              variant.dimensionsMm.height,
            )
          : null,
    },

    priceExVat,
    priceIncVat,

    currency:
      safeString(
        variant?.sellingPriceExVat
          ?.currency ||
          product?.pricing?.baseCurrency ||
          BASE_CURRENCY,
        3,
      ).toUpperCase(),

    vatRate,

    inventoryKnown,
    totalInventory,

    available:
      !inventoryKnown ||
      totalInventory > 0,
  };
}

function mapCjProduct(product) {
  const variants = enabledCjVariants(
    product,
  ).map((variant) =>
    mapCjVariant(product, variant),
  );

  const availableVariants =
    variants.filter(
      (variant) => variant.available,
    );

  const displayedVariants =
    availableVariants.length
      ? availableVariants
      : variants;

  const prices = displayedVariants
    .map((variant) =>
      Number(variant.priceIncVat),
    )
    .filter(
      (price) =>
        Number.isFinite(price) &&
        price >= 0,
    );

  const minimumPriceIncVat =
    prices.length > 0
      ? Math.min(...prices)
      : 0;

  const maximumPriceIncVat =
    prices.length > 0
      ? Math.max(...prices)
      : 0;

  const defaultVariant =
    displayedVariants[0] || null;

  const images = [
    safeString(
      product?.mainImageUrl,
      2000,
    ),

    ...(Array.isArray(product?.images)
      ? product.images.map((image) =>
          safeString(
            image?.url,
            2000,
          ),
        )
      : []),

    ...displayedVariants.map(
      (variant) =>
        safeString(
          variant?.imageUrl,
          2000,
        ),
    ),
  ].filter(Boolean);

  const uniqueImages = [
    ...new Set(images),
  ];

  return {
    source: 'CJ',

    cjProductId: safeString(
      product?.cjProductId,
      300,
    ),

    productSku: safeString(
      product?.productSku,
      300,
    ),

    name: safeString(
      product?.name ||
        'CJ Product',
      500,
    ),

    originalName: safeString(
      product?.originalName,
      1000,
    ),

    descriptionHtml:
      String(
        product?.descriptionHtml || '',
      ),

    mainImageUrl:
      safeString(
        defaultVariant?.imageUrl ||
          product?.mainImageUrl,
        2000,
      ),

    images: uniqueImages,

    productType: safeString(
      product?.productType,
      500,
    ),

    productUnit: safeString(
      product?.productUnit,
      100,
    ),

    category: {
      id: safeString(
        product?.category?.id,
        300,
      ),

      name:
        safeString(
          product?.category?.name ||
            product?.category
              ?.secondName ||
            product?.category
              ?.firstName ||
            product?.productType ||
            'CJ Product',
          500,
        ),

      firstName: safeString(
        product?.category?.firstName,
        500,
      ),

      secondName: safeString(
        product?.category?.secondName,
        500,
      ),
    },

    customs: {
      hsCode: safeString(
        product?.customs?.hsCode,
        300,
      ),

      nameEn: safeString(
        product?.customs?.nameEn,
        500,
      ),

      materialNameEn: safeString(
        product?.customs
          ?.materialNameEn,
        500,
      ),

      packingNameEn: safeString(
        product?.customs
          ?.packingNameEn,
        500,
      ),

      logisticsProperties:
        Array.isArray(
          product?.customs
            ?.logisticsProperties,
        )
          ? product.customs
              .logisticsProperties
              .map((value) =>
                safeString(
                  value,
                  300,
                ),
              )
              .filter(Boolean)
          : [],
    },

    productWeightGrams:
      Number.isFinite(
        Number(
          product?.productWeightGrams,
        ),
      )
        ? Number(
            product.productWeightGrams,
          )
        : null,

    packingWeightGrams:
      Number.isFinite(
        Number(
          product?.packingWeightGrams,
        ),
      )
        ? Number(
            product.packingWeightGrams,
          )
        : null,

    variants: displayedVariants,

    defaultVariant,

    minimumPriceIncVat,
    maximumPriceIncVat,

    hasPriceRange:
      maximumPriceIncVat >
      minimumPriceIncVat,

    currency:
      safeString(
        product?.pricing
          ?.baseCurrency ||
          BASE_CURRENCY,
        3,
      ).toUpperCase(),

    vatRate:
      Number.isFinite(
        Number(
          product?.pricing?.vatRate,
        ),
      )
        ? Number(
            product.pricing.vatRate,
          )
        : VAT_RATE,
  };
}

async function getShopHeaderImage() {
  try {
    return await ShopHeaderImage.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();
  } catch (error) {
    console.warn(
      '[CJ store] Header image could not be loaded:',
      error?.message || error,
    );

    return null;
  }
}

/*
 * Public CJ product page.
 *
 * This route reads only CjProduct.
 * It does not query the internal Product model.
 */
router.get(
  '/cj/product/:cjProductId',
  async (req, res) => {
    const cjProductId = safeString(
      req.params.cjProductId,
      300,
    );

    try {
      const rawProduct =
        await CjProduct.findOne({
          cjProductId,
          status: 'active',

          variants: {
            $elemMatch: {
              isEnabled: true,
            },
          },
        }).lean();

      if (!rawProduct) {
        req.flash(
          'error',
          'This CJ product is not currently available.',
        );

        return res.redirect('/store');
      }

      const product =
        mapCjProduct(rawProduct);

      if (!product.variants.length) {
        req.flash(
          'error',
          'This CJ product does not currently have an available variant.',
        );

        return res.redirect('/store');
      }

      const relatedQuery = {
        _id: {
          $ne: rawProduct._id,
        },

        status: 'active',

        variants: {
          $elemMatch: {
            isEnabled: true,
          },
        },
      };

      if (rawProduct?.category?.id) {
        relatedQuery[
          'category.id'
        ] = rawProduct.category.id;
      } else if (
        rawProduct?.category?.name
      ) {
        relatedQuery[
          'category.name'
        ] = rawProduct.category.name;
      } else if (
        rawProduct?.productType
      ) {
        relatedQuery.productType =
          rawProduct.productType;
      }

      const relatedRows =
        await CjProduct.find(
          relatedQuery,
        )
          .sort({
            updatedAt: -1,
            importedAt: -1,
          })
          .limit(4)
          .lean();

      const relatedProducts =
        relatedRows
          .map(mapCjProduct)
          .filter(
            (row) =>
              row.variants.length > 0,
          );

      const shopHeaderImage =
        await getShopHeaderImage();

      /*
       * Visiting a CJ product page activates only the
       * visible CJ department. The internal cart remains
       * untouched.
       */
      req.session.storeDepartment = 'cj';

      return res.render(
        'cj/product',
        {
          layout: 'layouts/store',

          title:
            product.name ||
            'CJ Product',

          storeDepartment: 'cj',
          productSource: 'CJ',

          product,
          relatedProducts,

          shopHeaderImage,

          baseCurrency:
            BASE_CURRENCY,

          vatRate:
            product.vatRate,
        },
      );
    } catch (error) {
      console.error(
        '[CJ store] Product page error:',
        error?.stack || error,
      );

      req.flash(
        'error',
        'The CJ product page could not be loaded.',
      );

      return res.redirect('/store');
    }
  },
);

/*
 * Public CJ cart page.
 *
 * This route reads only req.session.cjCart.
 * It never reads req.session.cart.
 */
router.get(
  '/cj/cart',
  async (req, res) => {
    try {
      const cart = publicCjCart(
        ensureCjCart(req),
      );

      const shopHeaderImage =
        await getShopHeaderImage();

      req.session.storeDepartment = 'cj';

      return res.render(
        'cj/cart',
        {
          layout: 'layouts/store',

          title: 'CJ Cart',

          storeDepartment: 'cj',
          productSource: 'CJ',

          cart,
          cartItems: cart.items,

          itemCount:
            cart.itemCount,

          subtotalExVat:
            cart.subtotalExVat,

          vatAmount:
            cart.vatAmount,

          totalIncVat:
            cart.totalIncVat,

          shopHeaderImage,

          baseCurrency:
            BASE_CURRENCY,

          vatRate:
            VAT_RATE,
        },
      );
    } catch (error) {
      console.error(
        '[CJ store] Cart page error:',
        error?.stack || error,
      );

      return res.render(
        'cj/cart',
        {
          layout: 'layouts/store',

          title: 'CJ Cart',

          storeDepartment: 'cj',
          productSource: 'CJ',

          cart: {
            source: 'CJ',
            department: 'cj',
            items: [],
            itemCount: 0,
            subtotalExVat: 0,
            vatAmount: 0,
            totalIncVat: 0,
          },

          cartItems: [],
          itemCount: 0,
          subtotalExVat: 0,
          vatAmount: 0,
          totalIncVat: 0,

          shopHeaderImage: null,

          baseCurrency:
            BASE_CURRENCY,

          vatRate:
            VAT_RATE,
        },
      );
    }
  },
);

module.exports = router;
