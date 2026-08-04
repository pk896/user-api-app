// routes/cjStore.js
'use strict';

const express = require('express');

const CjProduct = require('../models/CjProduct');
const CjRating = require('../models/CjRating');
const ShopHeaderImage = require('../models/ShopHeaderImage');

const { ensureCjCart, publicCjCart } = require('../utils/cj/cjCart');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '')
    .trim()
    .toUpperCase() || 'USD';

function safeString(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

/*
 * Read the separate CJ guest-rating identity cookie.
 *
 * This must remain separate from the internal product
 * rating cookie and internal Rating collection.
 */
function readCjGuestRatingKey(req) {
  try {
    if (req.cookies && req.cookies.cjRatingGuestKey) {
      return safeString(req.cookies.cjRatingGuestKey, 200);
    }

    const rawCookie = req.headers.cookie || '';

    const match = rawCookie.match(/(?:^|;\s*)cjRatingGuestKey=([^;]+)/);

    if (!match) {
      return null;
    }

    return safeString(decodeURIComponent(match[1]), 200);
  } catch {
    return null;
  }
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function enabledCjVariants(product) {
  return Array.isArray(product?.variants)
    ? product.variants.filter(
        (variant) =>
          variant?.isEnabled === true &&
          safeString(variant?.cjVariantId, 300) &&
          safeString(variant?.variantSku, 300) &&
          Number.isFinite(Number(variant?.sellingPriceExVat?.value)),
      )
    : [];
}

/*
 * Map one CJ variant for the public storefront.
 *
 * Kasyora adds and collects no VAT in the CJ flow.
 * sellingPriceExVat is therefore the authoritative CJ
 * selling price before shipping.
 */
function mapCjVariant(product, variant) {
  const price = round2(variant?.sellingPriceExVat?.value);

  const inventoryKnown = variant?.inventoryKnown === true;

  const totalInventory = Math.max(0, Math.floor(Number(variant?.totalInventory || 0)));

  return {
    cjVariantId: safeString(variant?.cjVariantId, 300),

    variantSku: safeString(variant?.variantSku, 300),

    variantName: safeString(
      variant?.variantName || variant?.variantKey || variant?.variantSku || 'Variant',
      500,
    ),

    variantKey: safeString(variant?.variantKey, 500),

    imageUrl: safeString(variant?.imageUrl || product?.mainImageUrl, 2000),

    barcode: safeString(variant?.barcode, 300),

    weightGrams: Number.isFinite(Number(variant?.weightGrams)) ? Number(variant.weightGrams) : null,

    dimensionsMm: {
      length: Number.isFinite(Number(variant?.dimensionsMm?.length))
        ? Number(variant.dimensionsMm.length)
        : null,

      width: Number.isFinite(Number(variant?.dimensionsMm?.width))
        ? Number(variant.dimensionsMm.width)
        : null,

      height: Number.isFinite(Number(variant?.dimensionsMm?.height))
        ? Number(variant.dimensionsMm.height)
        : null,
    },

    /*
     * New authoritative VAT-free fields.
     */
    price,
    priceExVat: price,

    /*
     * Temporary compatibility field.
     *
     * It contains the same VAT-free price and does not
     * include VAT.
     */
    priceIncVat: price,

    currency: safeString(
      variant?.sellingPriceExVat?.currency || product?.pricing?.baseCurrency || BASE_CURRENCY,
      3,
    ).toUpperCase(),

    vatRate: 0,

    inventoryKnown,
    totalInventory,

    available: !inventoryKnown || totalInventory > 0,
  };
}

function mapCjProduct(product) {
  const variants = enabledCjVariants(product).map((variant) => mapCjVariant(product, variant));

  const availableVariants = variants.filter((variant) => variant.available);

  const displayedVariants = availableVariants.length ? availableVariants : variants;

  /*
   * Use only VAT-free CJ variant selling prices.
   */
  const prices = displayedVariants
    .map((variant) => Number(variant.priceExVat ?? variant.price ?? 0))
    .filter((price) => Number.isFinite(price) && price >= 0);

  const minimumPrice = prices.length > 0 ? Math.min(...prices) : 0;

  const maximumPrice = prices.length > 0 ? Math.max(...prices) : 0;

  const defaultVariant = displayedVariants[0] || null;

  const images = [
    safeString(product?.mainImageUrl, 2000),

    ...(Array.isArray(product?.images)
      ? product.images.map((image) => safeString(image?.url, 2000))
      : []),

    ...displayedVariants.map((variant) => safeString(variant?.imageUrl, 2000)),
  ].filter(Boolean);

  const uniqueImages = [...new Set(images)];

  return {
    source: 'CJ',

    cjProductId: safeString(product?.cjProductId, 300),

    productSku: safeString(product?.productSku, 300),

    name: safeString(product?.name || 'CJ Product', 500),

    originalName: safeString(product?.originalName, 1000),

    descriptionHtml: String(product?.descriptionHtml || ''),

    mainImageUrl: safeString(defaultVariant?.imageUrl || product?.mainImageUrl, 2000),

    images: uniqueImages,

    productType: safeString(product?.productType, 500),

    productUnit: safeString(product?.productUnit, 100),

    category: {
      id: safeString(product?.category?.id, 300),

      name: safeString(
        product?.category?.name ||
          product?.category?.secondName ||
          product?.category?.firstName ||
          product?.productType ||
          'CJ Product',
        500,
      ),

      firstName: safeString(product?.category?.firstName, 500),

      secondName: safeString(product?.category?.secondName, 500),
    },

    customs: {
      hsCode: safeString(product?.customs?.hsCode, 300),

      nameEn: safeString(product?.customs?.nameEn, 500),

      materialNameEn: safeString(product?.customs?.materialNameEn, 500),

      packingNameEn: safeString(product?.customs?.packingNameEn, 500),

      logisticsProperties: Array.isArray(product?.customs?.logisticsProperties)
        ? product.customs.logisticsProperties.map((value) => safeString(value, 300)).filter(Boolean)
        : [],
    },

    productWeightGrams: Number.isFinite(Number(product?.productWeightGrams))
      ? Number(product.productWeightGrams)
      : null,

    packingWeightGrams: Number.isFinite(Number(product?.packingWeightGrams))
      ? Number(product.packingWeightGrams)
      : null,

    variants: displayedVariants,

    defaultVariant,

    /*
     * Real published CJ rating aggregates.
     *
     * These values come only from CjProduct and are
     * maintained by the separate CJ rating flow.
     */
    avgRating: Math.max(0, Math.min(5, Number(product?.avgRating || 0))),

    ratingsCount: Math.max(0, Math.floor(Number(product?.ratingsCount || 0))),

    /*
     * New authoritative VAT-free public price fields.
     */
    minimumPrice,
    maximumPrice,

    minimumPriceExVat: minimumPrice,

    maximumPriceExVat: maximumPrice,

    /*
     * Temporary compatibility aliases.
     *
     * These contain the same VAT-free values and do not
     * include VAT.
     */
    minimumPriceIncVat: minimumPrice,

    maximumPriceIncVat: maximumPrice,

    hasPriceRange: maximumPrice > minimumPrice,

    currency: safeString(product?.pricing?.baseCurrency || BASE_CURRENCY, 3).toUpperCase(),

    vatRate: 0,
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
    console.warn('[CJ store] Header image could not be loaded:', error?.message || error);

    return null;
  }
}

/*
 * Public CJ product page.
 *
 * This route reads only CjProduct.
 * It does not query the internal Product model.
 */
router.get('/cj/product/:cjProductId', async (req, res) => {
  const cjProductId = safeString(req.params.cjProductId, 300);

  try {
    const rawProduct = await CjProduct.findOne({
      cjProductId,
      status: 'active',

      variants: {
        $elemMatch: {
          isEnabled: true,
        },
      },
    }).lean();

    if (!rawProduct) {
      req.flash('error', 'This CJ product is not currently available.');

      return res.redirect('/store');
    }

    const product = mapCjProduct(rawProduct);

    if (!product.variants.length) {
      req.flash('error', 'This CJ product does not currently have an available variant.');

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
      relatedQuery['category.id'] = rawProduct.category.id;
    } else if (rawProduct?.category?.name) {
      relatedQuery['category.name'] = rawProduct.category.name;
    } else if (rawProduct?.productType) {
      relatedQuery.productType = rawProduct.productType;
    }

    const relatedRows = await CjProduct.find(relatedQuery)
      .sort({
        updatedAt: -1,
        importedAt: -1,
      })
      .limit(4)
      .lean();

    const relatedProducts = relatedRows.map(mapCjProduct).filter((row) => row.variants.length > 0);

    /*
     * Load only published CJ reviews for the public page.
     *
     * This query never reads the internal Rating model.
     */
    const cjReviews = await CjRating.find({
      cjProduct: rawProduct._id,
      status: 'published',
    })
      .select('_id stars title body raterType raterUser raterBusiness createdAt updatedAt')
      .sort({
        createdAt: -1,
        _id: -1,
      })
      .limit(20)
      .lean();

    /*
     * Find the current visitor's own CJ rating so the form
     * can display "Update Rating" and prefill their values.
     */
    let myCjRating = null;
    let currentRatingActor = null;

    const sessionUser = req.session?.user || null;

    const sessionBusiness = req.session?.business || null;

    if (sessionUser?._id) {
      currentRatingActor = {
        type: 'user',
        id: String(sessionUser._id),
        displayName: sessionUser.name || 'User',
      };

      myCjRating = await CjRating.findOne({
        cjProduct: rawProduct._id,
        raterType: 'user',
        raterUser: sessionUser._id,
      })
        .select('_id stars title body status createdAt updatedAt')
        .lean();
    } else if (sessionBusiness?._id) {
      currentRatingActor = {
        type: 'business',
        id: String(sessionBusiness._id),
        displayName: sessionBusiness.name || 'Business',
      };

      myCjRating = await CjRating.findOne({
        cjProduct: rawProduct._id,
        raterType: 'business',
        raterBusiness: sessionBusiness._id,
      })
        .select('_id stars title body status createdAt updatedAt')
        .lean();
    } else {
      const cjGuestRatingKey = readCjGuestRatingKey(req);

      currentRatingActor = {
        type: 'guest',
        id: cjGuestRatingKey || null,
        displayName: 'Guest',
      };

      if (cjGuestRatingKey) {
        myCjRating = await CjRating.findOne({
          cjProduct: rawProduct._id,
          raterType: 'guest',
          guestKey: cjGuestRatingKey,
        })
          .select('_id stars title body status createdAt updatedAt')
          .lean();
      }
    }

    const shopHeaderImage = await getShopHeaderImage();

    /*
     * Visiting a CJ product page activates only the
     * visible CJ department. The internal cart remains
     * untouched.
     */
    req.session.storeDepartment = 'cj';

    return res.render('cj/product', {
      layout: 'layouts/store',

      title: product.name || 'CJ Product',

      storeDepartment: 'cj',
      productSource: 'CJ',

      product,
      relatedProducts,

      /*
       * Separate CJ rating page data.
       */
      cjReviews,

      cjRatingsTotal: Number(product.ratingsCount || 0),

      myCjRating,

      currentRatingActor,

      shopHeaderImage,

      baseCurrency: BASE_CURRENCY,
    });
  } catch (error) {
    console.error('[CJ store] Product page error:', error?.stack || error);

    req.flash('error', 'The CJ product page could not be loaded.');

    return res.redirect('/store');
  }
});

/*
 * Public CJ cart page.
 *
 * This route reads only req.session.cjCart.
 * It never reads req.session.cart.
 */
router.get('/cj/cart', async (req, res) => {
  try {
    const cart = publicCjCart(ensureCjCart(req));

    const shopHeaderImage = await getShopHeaderImage();

    req.session.storeDepartment = 'cj';

    return res.render('cj/cart', {
      layout: 'layouts/store',

      title: 'CJ Cart',

      storeDepartment: 'cj',
      productSource: 'CJ',

      cart,
      cartItems: cart.items,

      itemCount: cart.itemCount,

      /*
       * New authoritative VAT-free cart fields.
       */
      subtotal: cart.subtotal ?? cart.subtotalExVat ?? 0,

      total: cart.total ?? cart.totalIncVat ?? cart.subtotal ?? cart.subtotalExVat ?? 0,

      vatAmount: 0,

      /*
       * Temporary compatibility aliases for any remaining
       * historical view references.
       */
      subtotalExVat: cart.subtotal ?? cart.subtotalExVat ?? 0,

      totalIncVat: cart.total ?? cart.totalIncVat ?? cart.subtotal ?? cart.subtotalExVat ?? 0,

      shopHeaderImage,

      baseCurrency: BASE_CURRENCY,
    });
  } catch (error) {
    console.error('[CJ store] Cart page error:', error?.stack || error);

    return res.render('cj/cart', {
      layout: 'layouts/store',

      title: 'CJ Cart',

      storeDepartment: 'cj',
      productSource: 'CJ',

      cart: {
        source: 'CJ',
        department: 'cj',
        items: [],
        itemCount: 0,

        subtotal: 0,

        vatAmount: 0,

        total: 0,

        /*
         * Temporary compatibility aliases.
         */
        subtotalExVat: 0,

        totalIncVat: 0,
      },

      cartItems: [],

      itemCount: 0,

      subtotal: 0,

      vatAmount: 0,

      total: 0,

      /*
       * Temporary compatibility aliases.
       */
      subtotalExVat: 0,

      totalIncVat: 0,

      shopHeaderImage: null,

      baseCurrency: BASE_CURRENCY,
    });
  }
});

module.exports = router;
