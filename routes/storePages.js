// routes/storePages.js
'use strict';
const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const CjProduct = require('../models/CjProduct');

/*
 * Internal Kasyora orders.
 *
 * This model is used only when finding qualifying
 * Internal Kasyora products.
 */
const Order = require('../models/Order');

/*
 * Separate CJ Dropshipping orders.
 *
 * This model is used only when finding qualifying
 * CJ products.
 */
const CjOrder = require('../models/CjOrder');

const Rating = require('../models/Rating');
const HeroSlide = require('../models/HeroSlide');
const FeaturedBanner = require('../models/FeaturedBanner');

/*
 * Separate Kasyora CJ Store homepage Featured Right-side Banner.
 * This model never references the Internal Product model.
 */
const CjFeaturedBanner = require('../models/CjFeaturedBanner');

/*
 * Separate Kasyora CJ Store homepage Promo Offers.
 * This model stores only CjProduct.cjProductId values.
 */
const CjHomePromoOffer = require('../models/CjHomePromoOffer');

const HomePromoOffer = require('../models/HomePromoOffer');
const HomeMidBanner = require('../models/HomeMidBanner');

/*
 * Completely separate Kasyora CJ Store
 * Home Mid Banners.
 *
 * The same left and right CJ records are shared by
 * the CJ homepage and CJ Shop page.
 */
const CjHomeMidBanner = require('../models/CjHomeMidBanner');

const BestsellerCard = require('../models/BestsellerCard');

/*
 * Completely separate Kasyora CJ Store
 * Bestseller Cards.
 *
 * This model stores only CjProduct.cjProductId.
 */
const CjBestsellerCard = require('../models/CjBestsellerCard');

const BestsellerBottomBanner = require('../models/BestsellerBottomBanner');

/*
 * Completely separate Kasyora CJ Store
 * Bestseller Bottom Banners.
 *
 * This model stores only CjProduct.cjProductId.
 */
const CjBestsellerBottomBanner = require('../models/CjBestsellerBottomBanner');

/*
 * Existing Internal Kasyora Store
 * Shop Sidebar Banner.
 */
const ShopSidebarBanner = require('../models/ShopSidebarBanner');

/*
 * Completely separate Kasyora CJ Store
 * Shop Sidebar Banner.
 *
 * This model stores only CjProduct.cjProductId.
 */
const CjShopSidebarBanner = require('../models/CjShopSidebarBanner');

const ShopMainBanner = require('../models/ShopMainBanner');

/*
 * Completely separate CJ Shop Main Banner.
 *
 * This model stores only CjProduct.cjProductId.
 */
const CjShopMainBanner = require('../models/CjShopMainBanner');

const ShopHeaderImage = require('../models/ShopHeaderImage');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const { CJ_KASYORA_VAT_RATE, TAX_COUNTRY_SOURCES } = require('../utils/tax/taxConfig');

const { resolveInternalTaxTreatment } = require('../utils/tax/resolveInternalTaxTreatment');

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '')
    .trim()
    .toUpperCase() || 'USD';
const APP_URL = String(process.env.APP_URL || 'http://localhost:3000')
  .trim()
  .replace(/\/+$/, '');

/*
 * Resolve the provisional storefront tax treatment.
 *
 * INTERNAL:
 * Uses the country selected by the customer, trusted GeoIP fallback,
 * or configured default country supplied by taxCountry middleware.
 *
 * CJ:
 * Kasyora-added VAT is always zero and the Internal tax resolver
 * is never called.
 *
 * This storefront result is provisional only. The validated Internal
 * checkout shipping address will later make the authoritative decision.
 */
function resolveStorefrontTaxContext(req, storeDepartment) {
  const department = normalizeStoreDepartment(storeDepartment);

  /*
   * CJ storefront tax context
   * =========================
   *
   * CJ remains completely isolated from the Internal
   * Kasyora tax resolver.
   *
   * The delivery country may still be retained for:
   *
   * - delivery presentation;
   * - shipping;
   * - customs information;
   * - checkout convenience.
   *
   * It must never cause Internal Kasyora VAT to be
   * added to a CJ product, cart or order.
   */
  if (department === 'cj') {
    return {
      department: 'cj',

      success: true,

      jurisdiction: '',

      destinationCountryCode: String(req?.taxCountryContext?.countryCode || '')
        .trim()
        .toUpperCase()
        .slice(0, 2),

      countrySource: String(req?.taxCountryContext?.source || TAX_COUNTRY_SOURCES.DEFAULT)
        .trim()
        .toUpperCase(),

      authoritative: false,

      provisional: true,

      vatEnabled: false,

      treatmentCode: 'CJ_NO_KASYORA_VAT',

      vatRate: CJ_KASYORA_VAT_RATE,

      vatPercentage: 0,

      /*
       * Keep the label empty.
       *
       * CJ product cards must show the price only and must
       * not display Internal Kasyora VAT wording.
       */
      label: '',

      reason: 'The CJ department uses its separate Kasyora-added VAT policy.',

      exportEvidenceRequired: false,
    };
  }

  /*
   * Internal provisional country
   * ============================
   *
   * This country came from:
   *
   * 1. customer selection;
   * 2. trusted GeoIP;
   * 3. configured default.
   *
   * It remains provisional until the validated checkout
   * shipping address becomes authoritative.
   */
  const provisionalCountryCode = String(req?.taxCountryContext?.countryCode || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);

  const provisionalCountrySource = String(
    req?.taxCountryContext?.source || TAX_COUNTRY_SOURCES.DEFAULT,
  )
    .trim()
    .toUpperCase();

  /*
   * Internal Kasyora Store only.
   *
   * The resolver now distinguishes:
   *
   * VAT_DISABLED
   * ZA_STANDARD
   * ZA_EXPORT_ZERO_RATED
   * REVIEW_REQUIRED
   */
  const treatment = resolveInternalTaxTreatment({
    destinationCountryCode: provisionalCountryCode,

    countrySource: provisionalCountrySource,
  });

  return {
    department: 'internal',

    ...treatment,
  };
}

function mapStoreProduct(p) {
  /*
   * Product.price remains the authoritative VAT-exclusive
   * Internal Kasyora price in BASE_CURRENCY.
   *
   * Do not add VAT inside this mapper.
   *
   * The provisional storefront tax treatment is resolved
   * separately from the selected delivery country.
   */
  const storedPrice = Number(p?.price || 0);

  const price =
    Number.isFinite(storedPrice) && storedPrice >= 0 ? Number(storedPrice.toFixed(2)) : 0;

  /*
   * The sale comparison price must also remain VAT-exclusive.
   *
   * The active storefront VAT treatment will later be applied
   * consistently to both price and oldPrice for presentation.
   */
  const oldPrice = p?.isOnSale === true ? Number((price * 1.19).toFixed(2)) : null;

  return {
    id: p.customId,

    customId: p.customId,

    name: p.name || 'Product',

    description: p.description || '',

    image: p.imageUrl,

    imageUrl: p.imageUrl,

    category: p.category || p.type || 'Product',

    role: p.role || 'general',

    type: p.type || '',

    color: p.color || '',

    size: p.size || '',

    sizes: Array.isArray(p.sizes) ? p.sizes : [],

    colors: Array.isArray(p.colors) ? p.colors : [],

    colorImages: Array.isArray(p.colorImages) ? p.colorImages : [],

    keywords: Array.isArray(p.keywords) ? p.keywords : [],

    /*
     * Both amounts remain VAT-exclusive.
     */
    price,

    oldPrice,

    isNew: p.isNewItem === true,

    sale: p.isOnSale === true,

    popular: p.isPopular === true,

    stock: Number(p.stock || 0),

    rating: 4,

    avgRating: Number(p.avgRating || 0),

    ratingsCount: Number(p.ratingsCount || 0),

    url: `/store/product/${p.customId}`,
  };
}

function normalizeStoreDepartment(value) {
  return String(value || '')
    .trim()
    .toLowerCase() === 'cj'
    ? 'cj'
    : 'internal';
}

function getStoreDepartment(req) {
  /*
   * A department explicitly supplied in the URL must win.
   *
   * Examples:
   * /store?department=cj
   * /store/shop?department=cj
   * /store/bestseller?department=cj
   *
   * After resolving it, keep the same department in the session
   * so later store requests remain in the selected department.
   */
  const requestedDepartment = String(req.query?.department || '')
    .trim()
    .toLowerCase();

  const hasRequestedDepartment = requestedDepartment === 'cj' || requestedDepartment === 'internal';

  const storeDepartment = hasRequestedDepartment
    ? normalizeStoreDepartment(requestedDepartment)
    : normalizeStoreDepartment(req.session?.storeDepartment);

  if (req.session) {
    req.session.storeDepartment = storeDepartment;
  }

  return storeDepartment;
}

function buildStoreDepartmentUrl(pathname, storeDepartment, hash = '') {
  const department = normalizeStoreDepartment(storeDepartment);

  const params = new URLSearchParams();

  params.set('department', department);

  return String(pathname || '/store') + '?' + params.toString() + String(hash || '');
}

function getEnabledCjVariants(product) {
  return Array.isArray(product?.variants)
    ? product.variants.filter((variant) => variant?.isEnabled === true)
    : [];
}

function getCjVariantPriceExVat(variant) {
  const value = Number(variant?.sellingPriceExVat?.value);

  return Number.isFinite(value) && value >= 0 ? Number(value.toFixed(2)) : null;
}

function mapCjStoreProduct(product) {
  const enabledVariants = getEnabledCjVariants(product);

  const validVariants = enabledVariants
    .map((variant) => {
      const priceExVat = getCjVariantPriceExVat(variant);

      if (priceExVat === null) {
        return null;
      }

      return {
        cjVariantId: String(variant.cjVariantId || '').trim(),
        variantSku: String(variant.variantSku || '').trim(),
        variantName: String(
          variant.variantName || variant.variantKey || variant.variantSku || 'Variant',
        ).trim(),
        imageUrl: String(variant.imageUrl || product.mainImageUrl || '').trim(),
        priceExVat,
        weightGrams: Number.isFinite(Number(variant.weightGrams))
          ? Number(variant.weightGrams)
          : null,
        inventoryKnown: variant.inventoryKnown === true,
        totalInventory: Math.max(0, Number(variant.totalInventory || 0)),
      };
    })
    .filter((variant) => variant && variant.cjVariantId && variant.variantSku);

  const prices = validVariants
    .map((variant) => Number(variant.priceExVat))
    .filter((value) => Number.isFinite(value) && value >= 0);

  const lowestPrice = prices.length > 0 ? Math.min(...prices) : 0;

  const firstVariant = validVariants.length > 0 ? validVariants[0] : null;

  const categoryName = String(
    product?.category?.name ||
      product?.category?.secondName ||
      product?.category?.firstName ||
      product?.productType ||
      'CJ Product',
  ).trim();

  return {
    source: 'CJ',
    isCj: true,

    id: String(product.cjProductId || '').trim(),

    /*
     * customId is supplied only to keep the current card templates
     * renderable until we patch their button logic.
     *
     * The CJ cart server still validates cjProductId and cjVariantId.
     */
    customId: String(product.cjProductId || '').trim(),
    cjProductId: String(product.cjProductId || '').trim(),

    productSku: String(product.productSku || '').trim(),

    name: String(product.name || 'CJ Product').trim(),

    description: String(product.descriptionHtml || '').trim(),

    image: String(firstVariant?.imageUrl || product.mainImageUrl || '').trim(),

    imageUrl: String(firstVariant?.imageUrl || product.mainImageUrl || '').trim(),

    category: categoryName,
    role: 'cj',
    type: String(product.productType || '').trim(),

    color: '',
    size: '',
    sizes: [],
    colors: [],
    colorImages: [],

    keywords: [
      String(product.name || '').trim(),
      String(product.productSku || '').trim(),
      categoryName,
      String(product.productType || '').trim(),
      ...validVariants.map((variant) => variant.variantSku),
      ...validVariants.map((variant) => variant.variantName),
    ].filter(Boolean),

    /*
     * The existing homepage template expects the price excluding VAT.
     * It adds VAT only for display.
     */
    price: Number(lowestPrice.toFixed(2)),
    oldPrice: null,

    isNew: false,
    sale: false,
    popular: Number(product.cjListedNumber || 0) > 0,

    /*
     * Unknown CJ inventory must not be represented as zero stock.
     * This public stock field is only a display compatibility value.
     * The CJ cart and later checkout perform server validation.
     */
    stock: validVariants.length,

    /*
     * Real CJ rating aggregates maintained by CjRating.
     *
     * These values come from CjProduct only and remain
     * separate from the internal Rating model.
     */
    rating: Math.max(0, Math.min(5, Number(product.avgRating || 0))),

    avgRating: Math.max(0, Math.min(5, Number(product.avgRating || 0))),

    ratingsCount: Math.max(0, Math.floor(Number(product.ratingsCount || 0))),

    variants: validVariants,
    enabledVariantCount: validVariants.length,

    defaultCjVariantId: firstVariant?.cjVariantId || '',

    url: `/cj/product/${encodeURIComponent(String(product.cjProductId || '').trim())}`,
  };
}

function buildCjHomepageQuery({ keyword, category }) {
  const query = {
    status: 'active',

    variants: {
      $elemMatch: {
        isEnabled: true,
        'sellingPriceExVat.value': {
          $gte: 0,
        },
      },
    },
  };

  if (category) {
    query.$or = [
      { 'category.name': category },
      { 'category.firstName': category },
      { 'category.secondName': category },
      { productType: category },
    ];
  }

  if (keyword) {
    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const keywordRegex = new RegExp(escapedKeyword, 'i');

    const keywordConditions = [
      { name: keywordRegex },
      { originalName: keywordRegex },
      { productSku: keywordRegex },
      { productType: keywordRegex },
      { 'category.name': keywordRegex },
      { 'category.firstName': keywordRegex },
      { 'category.secondName': keywordRegex },
      { 'variants.variantSku': keywordRegex },
      { 'variants.variantName': keywordRegex },
    ];

    if (Array.isArray(query.$or)) {
      query.$and = [
        {
          $or: query.$or,
        },
        {
          $or: keywordConditions,
        },
      ];

      delete query.$or;
    } else {
      query.$or = keywordConditions;
    }
  }

  return query;
}

/*
 * Load storefront categories only from active CJ products
 * that were imported into Kasyora.
 *
 * This remains completely separate from the fixed internal
 * Kasyora category list exposed globally by server.js.
 */
async function loadCjStoreCategories() {
  const rows = await CjProduct.aggregate([
    {
      $match: {
        status: 'active',

        variants: {
          $elemMatch: {
            isEnabled: true,

            'sellingPriceExVat.value': {
              $gte: 0,
            },
          },
        },
      },
    },

    {
      $project: {
        categoryName: {
          $trim: {
            input: {
              $ifNull: [
                '$category.name',

                {
                  $ifNull: [
                    '$category.secondName',

                    {
                      $ifNull: [
                        '$category.firstName',

                        {
                          $ifNull: ['$productType', ''],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    },

    {
      $match: {
        categoryName: {
          $ne: '',
        },
      },
    },

    {
      $group: {
        _id: {
          $toLower: '$categoryName',
        },

        label: {
          $first: '$categoryName',
        },
      },
    },

    {
      $sort: {
        label: 1,
      },
    },
  ]);

  return rows
    .map((row) => {
      const categoryName = String(row?.label || '').trim();

      return {
        value: categoryName,
        label: categoryName,
      };
    })
    .filter((category) => category.value);
}

async function loadCjHomepageProducts({ keyword, category }) {
  const query = buildCjHomepageQuery({
    keyword,
    category,
  });

  const rows = await CjProduct.find(query)
    .sort({
      updatedAt: -1,
      importedAt: -1,
      _id: -1,
    })
    .limit(24)
    .lean();

  return rows
    .map(mapCjStoreProduct)
    .filter(
      (product) => product.cjProductId && product.enabledVariantCount > 0 && product.price >= 0,
    );
}

async function loadCjShopProducts({ keyword, category, selectedSort, requestedPage, perPage }) {
  const query = buildCjHomepageQuery({
    keyword,
    category,
  });

  /*
   * CJ selling prices live inside the variants array.
   * Mapping first gives every product one safe lowest
   * selling price excluding VAT.
   *
   * This also ensures disabled or invalid CJ variants
   * are never shown on the public shop page.
   */
  const rows = await CjProduct.find(query)
    .sort({
      updatedAt: -1,
      importedAt: -1,
      _id: -1,
    })
    .lean();

  let products = rows
    .map(mapCjStoreProduct)
    .filter(
      (product) =>
        product.cjProductId &&
        product.enabledVariantCount > 0 &&
        Number.isFinite(Number(product.price)) &&
        Number(product.price) >= 0,
    );

  if (selectedSort === 'popular') {
    products.sort((left, right) => {
      const popularDifference = Number(right.popular === true) - Number(left.popular === true);

      if (popularDifference !== 0) {
        return popularDifference;
      }

      return String(left.name || '').localeCompare(String(right.name || ''));
    });
  } else if (selectedSort === 'price_asc') {
    products.sort((left, right) => Number(left.price || 0) - Number(right.price || 0));
  } else if (selectedSort === 'price_desc') {
    products.sort((left, right) => Number(right.price || 0) - Number(left.price || 0));
  } else if (selectedSort === 'rating') {
    /*
     * Sort only by the separate CJ rating aggregates.
     *
     * Products with the highest average appear first.
     * When averages match, the product with more published
     * ratings appears first.
     */
    products.sort((left, right) => {
      const averageDifference = Number(right.avgRating || 0) - Number(left.avgRating || 0);

      if (averageDifference !== 0) {
        return averageDifference;
      }

      const countDifference = Number(right.ratingsCount || 0) - Number(left.ratingsCount || 0);

      if (countDifference !== 0) {
        return countDifference;
      }

      return String(left.name || '').localeCompare(String(right.name || ''));
    });
  }
  const totalProducts = products.length;

  const totalPages = Math.max(1, Math.ceil(totalProducts / perPage));

  const safeRequestedPage = Number.isFinite(Number(requestedPage))
    ? Math.floor(Number(requestedPage))
    : 1;

  const currentPage = Math.min(Math.max(safeRequestedPage, 1), totalPages);

  const skip = (currentPage - 1) * perPage;

  products = products.slice(skip, skip + perPage);

  return {
    products,
    totalProducts,
    totalPages,
    currentPage,
  };
}

/*
 * Map only Internal Kasyora Store promo offers.
 */
function mapPromoOffer(offer, product) {
  if (!offer || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    slot: offer.slot,
    eyebrowText: offer.eyebrowText || '',
    title: offer.titleOverride || mappedProduct.name,
    discountText: offer.discountText || '',
    url: `/store/product/${mappedProduct.customId}`,
    image: mappedProduct.image,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!offer.active,
    sortOrder: Number(offer.sortOrder || 0),
  };
}

/*
 * Map only Kasyora CJ Store promo offers.
 *
 * This function uses mapCjStoreProduct() and links only
 * to the separate CJ product-detail route.
 */
function mapCjPromoOffer(offer, product) {
  if (!offer || !product) return null;

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    slot: String(offer.slot || '').trim(),

    eyebrowText: String(offer.eyebrowText || '').trim(),

    title: String(offer.titleOverride || mappedProduct.name || 'CJ Product').trim(),

    discountText: String(offer.discountText || '').trim(),

    url: `/cj/product/${encodeURIComponent(mappedProduct.cjProductId)}`,

    image: mappedProduct.image,

    cjProductId: mappedProduct.cjProductId,

    productName: mappedProduct.name,

    active: offer.active === true,

    sortOrder: Number(offer.sortOrder || 0),
  };
}

function mapMidBanner(banner, product) {
  if (!banner || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    slot: banner.slot,
    title: banner.title || '',
    subtitle: banner.subtitle || '',
    priceText: banner.priceText || '',
    buttonText: banner.buttonText || 'Shop Now',
    image: banner.image || '',
    url: `/store/product/${mappedProduct.customId}`,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!banner.active,
    sortOrder: Number(banner.sortOrder || 0),
  };
}

/*
 * Map only the separate Kasyora CJ Store
 * Home Mid Banner.
 *
 * Never pass an Internal Product record into this function.
 */
function mapCjMidBanner(banner, product) {
  if (!banner || !product) {
    return null;
  }

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    slot: String(banner.slot || '').trim(),

    title: String(banner.title || '').trim(),

    subtitle: String(banner.subtitle || '').trim(),

    priceText: String(banner.priceText || '').trim(),

    buttonText: String(banner.buttonText || 'Shop Now').trim(),

    image: String(banner.image || '').trim(),

    url: '/cj/product/' + encodeURIComponent(mappedProduct.cjProductId),

    cjProductId: mappedProduct.cjProductId,

    productName: mappedProduct.name,

    active: banner.active === true,

    sortOrder: Number(banner.sortOrder || 0),
  };
}

function mapBestsellerCard(card, product) {
  if (!card || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    slot: card.slot,
    eyebrowText: card.eyebrowText || '',
    title: card.titleOverride || mappedProduct.name,
    discountText: card.discountText || '',
    image: mappedProduct.image,
    url: `/store/product/${mappedProduct.customId}`,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!card.active,
    sortOrder: Number(card.sortOrder || 0),
  };
}

/*
 * Map only the separate Kasyora CJ Store
 * Bestseller Card.
 *
 * Never pass an Internal Product record into this function.
 */
function mapCjBestsellerCard(card, product) {
  if (!card || !product) {
    return null;
  }

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    slot: String(card.slot || '').trim(),

    eyebrowText: String(card.eyebrowText || '').trim(),

    title: String(card.titleOverride || mappedProduct.name || 'CJ Product').trim(),

    supportingText: String(card.supportingText || '').trim(),

    discountText: String(card.discountText || '').trim(),

    buttonText: String(card.buttonText || 'Explore Product').trim(),

    image: String(mappedProduct.image || '').trim(),

    url: '/cj/product/' + encodeURIComponent(mappedProduct.cjProductId),

    cjProductId: mappedProduct.cjProductId,

    productSku: mappedProduct.productSku,

    productName: mappedProduct.name,

    category: mappedProduct.category,

    price: Number(mappedProduct.price || 0),

    enabledVariantCount: Number(mappedProduct.enabledVariantCount || 0),

    active: card.active === true,

    sortOrder: Number(card.sortOrder || 0),
  };
}

function mapBestsellerBottomBanner(banner, product) {
  if (!banner || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    slot: banner.slot,
    title: banner.title || '',
    subtitle: banner.subtitle || '',
    priceText: banner.priceText || '',
    buttonText: banner.buttonText || 'Shop Now',
    image: banner.image || '',
    overlayStyle: banner.overlayStyle || '',
    url: `/store/product/${mappedProduct.customId}`,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!banner.active,
    sortOrder: Number(banner.sortOrder || 0),
  };
}

/*
 * Map only the separate Kasyora CJ Store
 * Bestseller Bottom Banner.
 *
 * Never pass an Internal Product record into this function.
 */
function mapCjBestsellerBottomBanner(banner, product) {
  if (!banner || !product) {
    return null;
  }

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    slot: String(banner.slot || '').trim(),

    title: String(banner.title || '').trim(),

    subtitle: String(banner.subtitle || '').trim(),

    priceText: String(banner.priceText || '').trim(),

    buttonText: String(banner.buttonText || 'Shop Now').trim(),

    image: String(banner.image || '').trim(),

    overlayStyle: String(banner.overlayStyle || '').trim(),

    url: '/cj/product/' + encodeURIComponent(mappedProduct.cjProductId),

    cjProductId: mappedProduct.cjProductId,

    productName: mappedProduct.name,

    active: banner.active === true,

    sortOrder: Number(banner.sortOrder || 0),
  };
}

function mapShopSidebarBanner(banner, product) {
  if (!banner || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    title: banner.title || '',
    subtitle: banner.subtitle || '',
    buttonText: banner.buttonText || 'Shop Now',
    image: banner.image || '',
    url: `/store/product/${mappedProduct.customId}`,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!banner.active,
  };
}

/*
 * Map only the separate Kasyora CJ Store
 * Shop Sidebar Banner.
 *
 * Never pass an Internal Product record into this function.
 */
function mapCjShopSidebarBanner(banner, product) {
  if (!banner || !product) {
    return null;
  }

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    title: String(banner.title || '').trim(),

    subtitle: String(banner.subtitle || '').trim(),

    buttonText: String(banner.buttonText || 'Shop Now').trim(),

    image: String(banner.image || '').trim(),

    url: '/cj/product/' + encodeURIComponent(mappedProduct.cjProductId),

    cjProductId: mappedProduct.cjProductId,

    productName: mappedProduct.name,

    active: banner.active === true,
  };
}

function mapShopMainBanner(banner, product) {
  if (!banner || !product) return null;

  const mappedProduct = mapStoreProduct(product);

  return {
    title: banner.title || '',
    subtitle: banner.subtitle || '',
    buttonText: banner.buttonText || 'Shop Now',
    image: banner.image || '',
    url: `/store/product/${mappedProduct.customId}`,
    productCustomId: mappedProduct.customId,
    productName: mappedProduct.name,
    active: !!banner.active,
  };
}

/*
 * Map only the separate Kasyora CJ Store
 * Shop Main Banner.
 *
 * Never pass an Internal Product into this function.
 */
function mapCjShopMainBanner(banner, product) {
  if (!banner || !product) {
    return null;
  }

  const mappedProduct = mapCjStoreProduct(product);

  if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
    return null;
  }

  return {
    title: String(banner.title || '').trim(),

    subtitle: String(banner.subtitle || '').trim(),

    buttonText: String(banner.buttonText || 'Shop Now').trim(),

    image: String(banner.image || '').trim(),

    url: '/cj/product/' + encodeURIComponent(mappedProduct.cjProductId),

    cjProductId: mappedProduct.cjProductId,

    productName: mappedProduct.name,

    active: banner.active === true,
  };
}

/*
 * Load the same two CJ Home Mid Banners for:
 *
 * - /store?department=cj
 * - /store/shop?department=cj
 *
 * This helper reads only:
 *
 * - CjHomeMidBanner
 * - CjProduct
 *
 * It never reads Internal HomeMidBanner or Product.
 */
async function loadCjHomeMidBanners() {
  const banners = await CjHomeMidBanner.find({
    active: true,
  })
    .sort({
      sortOrder: 1,
      createdAt: 1,
    })
    .lean();

  let midBannerLeft = null;
  let midBannerRight = null;

  for (const banner of banners) {
    const cjProductId = String(banner?.cjProductId || '').trim();

    if (!cjProductId) {
      continue;
    }

    const rawProduct = await CjProduct.findOne({
      status: 'active',

      cjProductId,

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
    }).lean();

    if (!rawProduct) {
      continue;
    }

    const mappedBanner = mapCjMidBanner(banner, rawProduct);

    if (!mappedBanner) {
      continue;
    }

    if (banner.slot === 'left') {
      midBannerLeft = mappedBanner;
    }

    if (banner.slot === 'right') {
      midBannerRight = mappedBanner;
    }
  }

  return {
    midBannerLeft,
    midBannerRight,
  };
}

async function getFeaturedProducts(limit, excludeCustomId = null) {
  const safeLimit = Number(limit || 0) > 0 ? Number(limit) : 4;
  const excludeFilter = excludeCustomId ? { customId: { $ne: excludeCustomId } } : {};

  const pickedIds = new Set();
  const results = [];

  async function addBatch(query) {
    if (results.length >= safeLimit) return;

    const remaining = safeLimit - results.length;

    const rows = await Product.find({
      stock: { $gt: 0 },
      ...excludeFilter,
      ...query,
    })
      .sort({ createdAt: -1 })
      .limit(remaining + 8)
      .lean();

    for (const row of rows) {
      const id = String(row.customId || row._id || '');
      if (!id || pickedIds.has(id)) continue;

      pickedIds.add(id);
      results.push(row);

      if (results.length >= safeLimit) break;
    }
  }

  await addBatch({
    isOnSale: true,
    isNewItem: true,
    isPopular: true,
  });

  await addBatch({
    isPopular: true,
    $or: [{ isOnSale: true }, { isNewItem: true }],
  });

  await addBatch({
    isPopular: true,
  });

  await addBatch({});

  return results;
}

/*
 * Load Featured Products for the separate Kasyora CJ Store.
 *
 * This mirrors the Internal getFeaturedProducts() fallback flow,
 * but it reads only CjProduct and uses CJ-specific popularity,
 * rating and catalogue fields.
 *
 * It never queries:
 *
 * - Product
 * - Product.customId
 * - Internal ratings
 * - Internal cart, checkout or orders
 */
async function getCjFeaturedProducts(limit, excludeCjProductId = null) {
  const requestedLimit = Number(limit);

  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 4;

  const safeExcludedId = String(excludeCjProductId || '').trim();

  const excludeFilter = safeExcludedId
    ? {
        cjProductId: {
          $ne: safeExcludedId,
        },
      }
    : {};

  const pickedIds = new Set();

  const results = [];

  /*
   * Every selected CJ product must be active and must
   * contain at least one enabled checkout-ready variant.
   */
  const eligibleProductQuery = {
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
  };

  async function addBatch(
    extraQuery = {},
    sort = {
      createdAt: -1,

      _id: -1,
    },
  ) {
    if (results.length >= safeLimit) {
      return;
    }

    const remaining = safeLimit - results.length;

    const rows = await CjProduct.find({
      ...eligibleProductQuery,

      ...excludeFilter,

      ...extraQuery,
    })
      .sort(sort)
      .limit(remaining + 8)
      .lean();

    for (const row of rows) {
      const cjProductId = String(row?.cjProductId || '').trim();

      if (!cjProductId || pickedIds.has(cjProductId)) {
        continue;
      }

      /*
       * mapCjStoreProduct() performs the final variant
       * validation and gives the existing Shop EJS card
       * the same public product structure.
       */
      const mappedProduct = mapCjStoreProduct(row);

      if (!mappedProduct?.cjProductId || mappedProduct.enabledVariantCount < 1) {
        continue;
      }

      pickedIds.add(cjProductId);

      results.push(mappedProduct);

      if (results.length >= safeLimit) {
        break;
      }
    }
  }

  /*
   * First preference:
   * CJ products with marketplace interest and real ratings.
   */
  await addBatch(
    {
      cjListedNumber: {
        $gt: 0,
      },

      ratingsCount: {
        $gt: 0,
      },
    },
    {
      cjListedNumber: -1,

      avgRating: -1,

      ratingsCount: -1,

      createdAt: -1,
    },
  );

  /*
   * Second preference:
   * Popular/listed CJ products even when they have no
   * Kasyora rating yet.
   */
  await addBatch(
    {
      cjListedNumber: {
        $gt: 0,
      },
    },
    {
      cjListedNumber: -1,

      createdAt: -1,

      _id: -1,
    },
  );

  /*
   * Third preference:
   * CJ products that have received ratings.
   */
  await addBatch(
    {
      ratingsCount: {
        $gt: 0,
      },
    },
    {
      avgRating: -1,

      ratingsCount: -1,

      createdAt: -1,
    },
  );

  /*
   * Final fallback:
   * Fill the remaining spaces with the newest eligible
   * active CJ products.
   */
  await addBatch(
    {},
    {
      createdAt: -1,

      _id: -1,
    },
  );

  return results;
}

/*
 * Load TOP RATED PRODUCTS for the separate
 * Kasyora CJ Store Shop sidebar.
 *
 * This reads only the rating aggregates stored on CjProduct.
 * Those aggregates are maintained by the separate CjRating flow.
 *
 * It never queries:
 *
 * - Rating
 * - Product
 * - Product.customId
 * - Internal reviews
 */
async function getCjTopRatedProducts(limit) {
  const requestedLimit = Number(limit);

  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 8;

  const rows = await CjProduct.find({
    status: 'active',

    /*
     * Only products with published CJ ratings qualify.
     */
    ratingsCount: {
      $gt: 0,
    },

    avgRating: {
      $gt: 0,
      $lte: 5,
    },

    /*
     * The CJ product must still have at least one
     * enabled checkout-ready variant.
     */
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
  })
    .sort({
      /*
       * Highest average rating first.
       */
      avgRating: -1,

      /*
       * When averages match, the product with more
       * published CJ ratings appears first.
       */
      ratingsCount: -1,

      updatedAt: -1,
      _id: -1,
    })
    .limit(safeLimit + 8)
    .lean();

  return rows
    .map(mapCjStoreProduct)
    .filter((product) => {
      return (
        product &&
        product.cjProductId &&
        product.enabledVariantCount > 0 &&
        Number(product.avgRating || 0) > 0 &&
        Number(product.ratingsCount || 0) > 0
      );
    })
    .slice(0, safeLimit);
}

/*
 * Load the oldest Internal Kasyora products that have:
 *
 * 1. appeared in more than one distinct successful order;
 * 2. received at least one published rating;
 * 3. remained available for sale.
 *
 * This function reads only:
 *
 * - Order
 * - Product
 *
 * It never reads CjOrder or CjProduct.
 */
async function getInternalSoldRatedOldProducts(limit = 20) {
  const requestedLimit = Number(limit);

  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 20;

  /*
   * ==================================================
   * STEP 1: FIND PRODUCTS SOLD IN MORE THAN ONE ORDER
   * ==================================================
   *
   * This reads only the existing Internal Order model.
   *
   * A product qualifies for the sales requirement only
   * when it appears in at least two different paid-like
   * Internal Kasyora orders.
   */
  const soldProductRows = await Order.aggregate([
    {
      $match: {
        $or: [
          {
            status: {
              $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'],
            },
          },

          {
            paymentStatus: {
              $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'],
            },
          },
        ],
      },
    },

    {
      $unwind: '$items',
    },

    {
      $match: {
        'items.productId': {
          $type: 'string',
          $ne: '',
        },
      },
    },

    {
      $group: {
        _id: '$items.productId',

        successfulOrderIds: {
          $addToSet: '$_id',
        },
      },
    },

    {
      $project: {
        _id: 0,

        customId: '$_id',

        successfulOrderCount: {
          $size: '$successfulOrderIds',
        },
      },
    },

    {
      $match: {
        successfulOrderCount: {
          $gt: 1,
        },
      },
    },
  ]).allowDiskUse(true);

  const soldCustomIds = soldProductRows
    .map((row) => {
      return String(row?.customId || '').trim();
    })
    .filter(Boolean);

  if (soldCustomIds.length === 0) {
    return [];
  }

  /*
   * ==================================================
   * STEP 2: RESOLVE THE INTERNAL PRODUCT OBJECT IDS
   * ==================================================
   *
   * Internal Rating.productId points to Product._id,
   * not Product.customId.
   */
  const soldProducts = await Product.find({
    customId: {
      $in: soldCustomIds,
    },

    stock: {
      $gt: 0,
    },
  })
    .select({
      _id: 1,
      customId: 1,
    })
    .lean();

  if (soldProducts.length === 0) {
    return [];
  }

  const soldProductObjectIds = soldProducts.map((product) => product._id);

  /*
   * ==================================================
   * STEP 3: VERIFY REAL PUBLISHED RATINGS
   * ==================================================
   *
   * Rating is authoritative for Internal Kasyora reviews.
   *
   * Do not trust possibly stale Product.avgRating or
   * Product.ratingsCount values for qualification.
   */
  const ratingRows = await Rating.aggregate([
    {
      $match: {
        productId: {
          $in: soldProductObjectIds,
        },

        status: 'published',

        stars: {
          $gte: 1,
          $lte: 5,
        },
      },
    },

    {
      $group: {
        _id: '$productId',

        avgRating: {
          $avg: '$stars',
        },

        ratingsCount: {
          $sum: 1,
        },
      },
    },

    {
      $match: {
        ratingsCount: {
          $gt: 0,
        },

        avgRating: {
          $gt: 0,
          $lte: 5,
        },
      },
    },
  ]).allowDiskUse(true);

  if (ratingRows.length === 0) {
    return [];
  }

  const ratingByProductId = new Map(
    ratingRows.map((row) => {
      return [
        String(row._id),

        {
          avgRating: Number(Number(row.avgRating || 0).toFixed(2)),

          ratingsCount: Math.max(0, Math.floor(Number(row.ratingsCount || 0))),
        },
      ];
    }),
  );

  const ratedProductObjectIds = ratingRows.map((row) => row._id);

  /*
   * ==================================================
   * STEP 4: LOAD THE 20 OLDEST QUALIFYING PRODUCTS
   * ==================================================
   *
   * createdAt: 1 means the oldest qualifying Internal
   * Product records appear first.
   */
  const rows = await Product.find({
    _id: {
      $in: ratedProductObjectIds,
    },

    customId: {
      $in: soldCustomIds,
    },

    stock: {
      $gt: 0,
    },
  })
    .sort({
      createdAt: 1,
      _id: 1,
    })
    .limit(safeLimit)
    .lean();

  /*
   * Attach the live authoritative rating aggregates
   * from Rating before mapping the products for EJS.
   */
  return rows
    .map((product) => {
      const liveRating = ratingByProductId.get(String(product._id));

      if (!liveRating || liveRating.ratingsCount < 1 || liveRating.avgRating <= 0) {
        return null;
      }

      return mapStoreProduct({
        ...product,

        avgRating: liveRating.avgRating,

        ratingsCount: liveRating.ratingsCount,
      });
    })
    .filter(Boolean);
}

/*
 * Load the oldest CJ products that have:
 *
 * 1. appeared in more than one distinct successful CJ order;
 * 2. received at least one published CJ rating;
 * 3. remained active with a checkout-ready CJ variant.
 *
 * This function reads only:
 *
 * - CjOrder
 * - CjProduct
 *
 * It never reads Order, Product or Internal ratings.
 */
async function getCjSoldRatedOldProducts(limit = 20) {
  const requestedLimit = Number(limit);

  const safeLimit =
    Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 20;

  /*
   * A CJ product qualifies only when it appeared in
   * at least two different successfully paid CJ orders.
   *
   * Fully refunded, cancelled and failed orders are excluded.
   * Partially refunded orders remain valid sales because at
   * least part of the order was retained.
   */
  const soldProductRows = await CjOrder.aggregate([
    {
      $match: {
        paymentStatus: {
          $in: ['COMPLETED', 'PARTIALLY_REFUNDED'],
        },

        status: {
          $nin: ['PAYMENT_PENDING', 'CANCELLED', 'REFUNDED', 'PAYMENT_FAILED'],
        },
      },
    },

    {
      $unwind: '$items',
    },

    {
      $match: {
        'items.cjProductId': {
          $type: 'string',
          $ne: '',
        },
      },
    },

    {
      $group: {
        _id: '$items.cjProductId',

        successfulOrderIds: {
          $addToSet: '$_id',
        },
      },
    },

    {
      $project: {
        _id: 0,

        cjProductId: '$_id',

        successfulOrderCount: {
          $size: '$successfulOrderIds',
        },
      },
    },

    {
      $match: {
        successfulOrderCount: {
          $gt: 1,
        },
      },
    },
  ]).allowDiskUse(true);

  const qualifyingCjProductIds = soldProductRows
    .map((row) => {
      return String(row?.cjProductId || '').trim();
    })
    .filter(Boolean);

  if (qualifyingCjProductIds.length === 0) {
    return [];
  }

  /*
   * This final query remains completely inside CjProduct.
   *
   * createdAt: 1 means oldest imported database records first.
   */
  const rows = await CjProduct.find({
    status: 'active',

    cjProductId: {
      $in: qualifyingCjProductIds,
    },

    ratingsCount: {
      $gt: 0,
    },

    avgRating: {
      $gt: 0,
      $lte: 5,
    },

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
  })
    .sort({
      createdAt: 1,
      _id: 1,
    })
    .limit(safeLimit + 8)
    .lean();

  return rows
    .map(mapCjStoreProduct)
    .filter((product) => {
      return (
        product &&
        product.cjProductId &&
        product.enabledVariantCount > 0 &&
        Number(product.avgRating || 0) > 0 &&
        Number(product.ratingsCount || 0) > 0
      );
    })
    .slice(0, safeLimit);
}

/*
 * Build the five bestselling Internal Kasyora categories.
 *
 * Each returned category contains no more than twenty
 * bestselling in-stock Internal products.
 *
 * This function reads only:
 *
 * - Order
 * - Product
 *
 * It never reads CjOrder or CjProduct.
 */
async function getInternalBestsellingCategories(categoryLimit = 5, productsPerCategory = 20) {
  const safeCategoryLimit =
    Number.isFinite(Number(categoryLimit)) && Number(categoryLimit) > 0
      ? Math.floor(Number(categoryLimit))
      : 5;

  const safeProductsPerCategory =
    Number.isFinite(Number(productsPerCategory)) && Number(productsPerCategory) > 0
      ? Math.floor(Number(productsPerCategory))
      : 20;

  const salesRows = await Order.aggregate([
    {
      $match: {
        $or: [
          {
            status: {
              $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'],
            },
          },
          {
            paymentStatus: {
              $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'],
            },
          },
        ],
      },
    },

    {
      $unwind: '$items',
    },

    {
      $match: {
        'items.productId': {
          $type: 'string',
          $ne: '',
        },

        'items.quantity': {
          $gt: 0,
        },

        'items.refundStatus': {
          $ne: 'REFUNDED',
        },
      },
    },

    {
      $group: {
        _id: '$items.productId',

        soldQuantity: {
          $sum: {
            $subtract: [
              {
                $ifNull: ['$items.quantity', 1],
              },

              {
                $ifNull: ['$items.refundedQuantity', 0],
              },
            ],
          },
        },

        successfulOrders: {
          $addToSet: '$_id',
        },
      },
    },

    {
      $match: {
        soldQuantity: {
          $gt: 0,
        },
      },
    },

    {
      $project: {
        _id: 0,

        productCustomId: '$_id',

        soldQuantity: 1,

        successfulOrderCount: {
          $size: '$successfulOrders',
        },
      },
    },

    {
      $sort: {
        soldQuantity: -1,
        successfulOrderCount: -1,
        productCustomId: 1,
      },
    },
  ]).allowDiskUse(true);

  if (salesRows.length === 0) {
    return [];
  }

  const salesByProductId = new Map(
    salesRows.map((row) => {
      return [
        String(row?.productCustomId || '').trim(),

        {
          soldQuantity: Math.max(0, Number(row?.soldQuantity || 0)),

          successfulOrderCount: Math.max(0, Number(row?.successfulOrderCount || 0)),
        },
      ];
    }),
  );

  const productCustomIds = Array.from(salesByProductId.keys()).filter(Boolean);

  const rawProducts = await Product.find({
    customId: {
      $in: productCustomIds,
    },

    stock: {
      $gt: 0,
    },
  }).lean();

  const categoryMap = new Map();

  for (const rawProduct of rawProducts) {
    const mappedProduct = mapStoreProduct(rawProduct);

    const categoryName = String(mappedProduct.category || 'Product').trim() || 'Product';

    const categoryKey = categoryName.toLowerCase();

    const sales = salesByProductId.get(String(mappedProduct.customId || '').trim());

    if (!sales || sales.soldQuantity < 1) {
      continue;
    }

    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {
        category: categoryName,

        soldQuantity: 0,

        successfulOrderCount: 0,

        products: [],
      });
    }

    const categoryEntry = categoryMap.get(categoryKey);

    categoryEntry.soldQuantity += sales.soldQuantity;

    categoryEntry.successfulOrderCount += sales.successfulOrderCount;

    categoryEntry.products.push({
      ...mappedProduct,

      soldQuantity: sales.soldQuantity,

      successfulOrderCount: sales.successfulOrderCount,
    });
  }

  return Array.from(categoryMap.values())
    .map((categoryEntry) => {
      categoryEntry.products.sort((left, right) => {
        const quantityDifference = Number(right.soldQuantity || 0) - Number(left.soldQuantity || 0);

        if (quantityDifference !== 0) {
          return quantityDifference;
        }

        const orderDifference =
          Number(right.successfulOrderCount || 0) - Number(left.successfulOrderCount || 0);

        if (orderDifference !== 0) {
          return orderDifference;
        }

        return String(left.name || '').localeCompare(String(right.name || ''));
      });

      return {
        ...categoryEntry,

        products: categoryEntry.products.slice(0, safeProductsPerCategory),
      };
    })
    .filter((categoryEntry) => {
      return categoryEntry.category && categoryEntry.products.length > 0;
    })
    .sort((left, right) => {
      const quantityDifference = Number(right.soldQuantity || 0) - Number(left.soldQuantity || 0);

      if (quantityDifference !== 0) {
        return quantityDifference;
      }

      const orderDifference =
        Number(right.successfulOrderCount || 0) - Number(left.successfulOrderCount || 0);

      if (orderDifference !== 0) {
        return orderDifference;
      }

      return String(left.category || '').localeCompare(String(right.category || ''));
    })
    .slice(0, safeCategoryLimit);
}

/*
 * Build the five bestselling CJ categories.
 *
 * Each returned category contains no more than twenty
 * bestselling active CJ products.
 *
 * This function reads only:
 *
 * - CjOrder
 * - CjProduct
 *
 * It never reads Order or Product.
 */
async function getCjBestsellingCategories(categoryLimit = 5, productsPerCategory = 20) {
  const safeCategoryLimit =
    Number.isFinite(Number(categoryLimit)) && Number(categoryLimit) > 0
      ? Math.floor(Number(categoryLimit))
      : 5;

  const safeProductsPerCategory =
    Number.isFinite(Number(productsPerCategory)) && Number(productsPerCategory) > 0
      ? Math.floor(Number(productsPerCategory))
      : 20;

  const salesRows = await CjOrder.aggregate([
    {
      $match: {
        /*
         * A successful CJ sale may be proven by either:
         *
         * 1. the PayPal payment lifecycle; or
         * 2. the CJ order lifecycle.
         *
         * This keeps historical CJ orders compatible while
         * remaining completely isolated from Internal Order.
         */
        $or: [
          {
            paymentStatus: {
              $in: ['COMPLETED', 'PARTIALLY_REFUNDED'],
            },
          },

          {
            status: {
              $in: [
                'PAID',
                'CJ_ORDER_PENDING',
                'CJ_ORDER_CREATED',
                'PROCESSING',
                'SHIPPED',
                'DELIVERED',
                'PARTIALLY_REFUNDED',
              ],
            },
          },
        ],

        /*
         * Never count unpaid, cancelled, fully refunded
         * or failed CJ orders as successful sales.
         */
        status: {
          $nin: ['PAYMENT_PENDING', 'CANCELLED', 'REFUNDED', 'PAYMENT_FAILED'],
        },
      },
    },

    {
      $unwind: '$items',
    },

    {
      $match: {
        'items.cjProductId': {
          $type: 'string',
          $ne: '',
        },

        'items.quantity': {
          $gt: 0,
        },
      },
    },

    {
      $group: {
        _id: '$items.cjProductId',

        soldQuantity: {
          $sum: {
            $ifNull: ['$items.quantity', 1],
          },
        },

        successfulOrders: {
          $addToSet: '$_id',
        },
      },
    },

    {
      $match: {
        soldQuantity: {
          $gt: 0,
        },
      },
    },

    {
      $project: {
        _id: 0,

        cjProductId: '$_id',

        soldQuantity: 1,

        successfulOrderCount: {
          $size: '$successfulOrders',
        },
      },
    },

    {
      $sort: {
        soldQuantity: -1,
        successfulOrderCount: -1,
        cjProductId: 1,
      },
    },
  ]).allowDiskUse(true);

  if (salesRows.length === 0) {
    return [];
  }

  const salesByCjProductId = new Map(
    salesRows.map((row) => {
      return [
        String(row?.cjProductId || '').trim(),

        {
          soldQuantity: Math.max(0, Number(row?.soldQuantity || 0)),

          successfulOrderCount: Math.max(0, Number(row?.successfulOrderCount || 0)),
        },
      ];
    }),
  );

  const cjProductIds = Array.from(salesByCjProductId.keys()).filter(Boolean);

  const rawProducts = await CjProduct.find({
    status: 'active',

    cjProductId: {
      $in: cjProductIds,
    },

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
  }).lean();

  const categoryMap = new Map();

  for (const rawProduct of rawProducts) {
    const mappedProduct = mapCjStoreProduct(rawProduct);

    if (!mappedProduct.cjProductId || mappedProduct.enabledVariantCount < 1) {
      continue;
    }

    const sales = salesByCjProductId.get(String(mappedProduct.cjProductId || '').trim());

    if (!sales || sales.soldQuantity < 1) {
      continue;
    }

    const categoryName = String(mappedProduct.category || 'CJ Product').trim() || 'CJ Product';

    const categoryKey = categoryName.toLowerCase();

    if (!categoryMap.has(categoryKey)) {
      categoryMap.set(categoryKey, {
        category: categoryName,

        soldQuantity: 0,

        successfulOrderCount: 0,

        products: [],
      });
    }

    const categoryEntry = categoryMap.get(categoryKey);

    categoryEntry.soldQuantity += sales.soldQuantity;

    categoryEntry.successfulOrderCount += sales.successfulOrderCount;

    categoryEntry.products.push({
      ...mappedProduct,

      soldQuantity: sales.soldQuantity,

      successfulOrderCount: sales.successfulOrderCount,
    });
  }

  return Array.from(categoryMap.values())
    .map((categoryEntry) => {
      categoryEntry.products.sort((left, right) => {
        const quantityDifference = Number(right.soldQuantity || 0) - Number(left.soldQuantity || 0);

        if (quantityDifference !== 0) {
          return quantityDifference;
        }

        const orderDifference =
          Number(right.successfulOrderCount || 0) - Number(left.successfulOrderCount || 0);

        if (orderDifference !== 0) {
          return orderDifference;
        }

        return String(left.name || '').localeCompare(String(right.name || ''));
      });

      return {
        ...categoryEntry,

        products: categoryEntry.products.slice(0, safeProductsPerCategory),
      };
    })
    .filter((categoryEntry) => {
      return categoryEntry.category && categoryEntry.products.length > 0;
    })
    .sort((left, right) => {
      const quantityDifference = Number(right.soldQuantity || 0) - Number(left.soldQuantity || 0);

      if (quantityDifference !== 0) {
        return quantityDifference;
      }

      const orderDifference =
        Number(right.successfulOrderCount || 0) - Number(left.successfulOrderCount || 0);

      if (orderDifference !== 0) {
        return orderDifference;
      }

      return String(left.category || '').localeCompare(String(right.category || ''));
    })
    .slice(0, safeCategoryLimit);
}

function getGuestKeyFromReq(req) {
  try {
    const fromCookies = req.cookies && req.cookies.guestKey ? String(req.cookies.guestKey) : null;

    const rawCookie = req.headers.cookie || '';
    const match = rawCookie.match(/(?:^|;\s*)guestKey=([^;]+)/);
    const fromHeader = match ? decodeURIComponent(match[1]) : null;

    const existing = fromCookies || fromHeader;
    return existing && existing.length >= 16 ? existing : null;
  } catch {
    return null;
  }
}

function storeMoney(amount) {
  const n = Number(amount || 0);

  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: BASE_CURRENCY,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

    if (BASE_CURRENCY === 'ZAR') {
      return formatted.replace(/^ZAR\s?/, 'R');
    }

    return formatted;
  } catch {
    return BASE_CURRENCY + ' ' + n.toFixed(2);
  }
}

function publicUrl(value) {
  const raw = String(value || '').trim();

  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;

  return APP_URL + '/' + raw.replace(/^\/+/, '');
}

function xmlSafe(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fitText(value, maxLength) {
  const text = String(value || '').trim();

  if (text.length <= maxLength) return text;

  return text.slice(0, Math.max(0, maxLength - 1)).trim() + '…';
}

function svgTextLines(value, maxLength, maxLines) {
  const words = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const nextLine = currentLine ? `${currentLine} ${word}` : word;

    if (nextLine.length <= maxLength) {
      currentLine = nextLine;
      continue;
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    currentLine = word;

    if (lines.length >= maxLines) {
      break;
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  if (lines.length > maxLines) {
    lines.length = maxLines;
  }

  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = fitText(lines[maxLines - 1], Math.max(1, maxLength - 1));
  }

  return lines.length ? lines : ['Product'];
}

function renderSvgTextLines(lines, x, firstY, fontSize, lineGap, color, weight) {
  return lines
    .map((line, index) => {
      const y = firstY + index * lineGap;

      return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${xmlSafe(line)}</text>`;
    })
    .join('');
}

function downloadImageBuffer(url) {
  return new Promise((resolve) => {
    try {
      const safeUrl = String(url || '').trim();

      if (!safeUrl) {
        return resolve(null);
      }

      const client = safeUrl.startsWith('https://') ? https : http;

      const request = client.get(safeUrl, (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.resume();
          return resolve(null);
        }

        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
      });

      request.setTimeout(10000, () => {
        request.destroy();
        resolve(null);
      });

      request.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

router.get('/store', async (req, res) => {
  const storeDepartment = getStoreDepartment(req);

  const storefrontTaxContext = resolveStorefrontTaxContext(req, storeDepartment);

  try {
    const keyword = String(req.query.keyword || '').trim();

    const category = String(req.query.category || '').trim();

    /*
     * Shared marketing slides may remain visible in both departments.
     *
     * Product-linked internal banners are intentionally hidden when
     * the CJ department is active so an internal Product is never
     * displayed inside the CJ-only storefront.
     */
    const heroSlidesRaw = await HeroSlide.find({
      active: true,
    })
      .sort({
        sortOrder: 1,
        createdAt: 1,
      })
      .lean();

    /*
     * Every homepage hero call-to-action opens the Shop page
     * at the top while preserving the active store department.
     *
     * Search and category links may still use #shopProductsSection,
     * but the general hero Shop Now button must not use a hash.
     */
    const activeHeroShopUrl = buildStoreDepartmentUrl('/store/shop', storeDepartment);

    const heroSlides = heroSlidesRaw.map((slide) => ({
      title: slide.title || '',
      subtitle: slide.subtitle || '',
      description: slide.description || '',
      image: slide.image || '',
      buttonText: slide.buttonText || 'Shop Now',
      buttonUrl: activeHeroShopUrl,
    }));

    if (storeDepartment === 'cj') {
      const [cjProducts, cjCategories, cjFeaturedBanner, cjHomePromoOffers, cjHomeMidBanners] =
        await Promise.all([
          loadCjHomepageProducts({
            keyword,
            category,
          }),

          loadCjStoreCategories(),

          /*
           * Load only the separate CJ Featured Right-side Banner.
           *
           * This never queries the Internal FeaturedBanner model.
           */
          CjFeaturedBanner.findOne({
            slot: 'right',
            active: true,
          })
            .sort({
              updatedAt: -1,
            })
            .lean(),

          /*
           * Load only active CJ homepage promo offers.
           *
           * These records contain CjProduct.cjProductId values
           * and never reference Internal Product.customId.
           */
          CjHomePromoOffer.find({
            active: true,
          })
            .sort({
              sortOrder: 1,
              createdAt: 1,
            })
            .lean(),

          /*
           * Load the shared left and right CJ Home Mid Banners.
           */
          loadCjHomeMidBanners(),
        ]);

      /*
       * The CJ banner product is loaded independently from the
       * visible search/category results.
       *
       * This means the configured banner remains visible even
       * when the customer searches for another product category.
       */
      let sideBannerProduct = null;

      if (cjFeaturedBanner?.cjProductId) {
        const rawCjBannerProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId: String(cjFeaturedBanner.cjProductId).trim(),

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
        }).lean();

        if (rawCjBannerProduct) {
          const mappedCjBannerProduct = mapCjStoreProduct(rawCjBannerProduct);

          if (mappedCjBannerProduct.cjProductId && mappedCjBannerProduct.enabledVariantCount > 0) {
            sideBannerProduct = {
              ...mappedCjBannerProduct,

              badgeText: cjFeaturedBanner.badgeText || 'Special Offer',

              offerText: cjFeaturedBanner.offerText || 'Featured CJ Product',
            };
          }
        }
      }

      /*
       * Resolve the separate left and right CJ promo offers.
       *
       * Each saved configuration is validated again against
       * an active imported CjProduct with an enabled,
       * valid-price variant.
       */
      let promoOfferLeft = null;
      let promoOfferRight = null;

      for (const offer of cjHomePromoOffers) {
        const cjProductId = String(offer?.cjProductId || '').trim();

        if (!cjProductId) {
          continue;
        }

        const rawPromoProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (!rawPromoProduct) {
          continue;
        }

        const mappedOffer = mapCjPromoOffer(offer, rawPromoProduct);

        if (!mappedOffer) {
          continue;
        }

        if (offer.slot === 'left') {
          promoOfferLeft = mappedOffer;
        }

        if (offer.slot === 'right') {
          promoOfferRight = mappedOffer;
        }
      }

      /*
       * CJ currently has no Kasyora sales history in this stage.
       * The arrays are therefore derived from the same isolated
       * active CJ catalogue using safe deterministic ordering.
       */
      const allProducts = cjProducts.slice(0, 8);

      const newArrivals = [...cjProducts].slice(0, 8);

      const featuredProducts = [...cjProducts]
        .sort((a, b) => {
          return Number(b.enabledVariantCount || 0) - Number(a.enabledVariantCount || 0);
        })
        .slice(0, 8);

      const bestSellerProducts = [...cjProducts]
        .sort((a, b) => {
          return Number(b.popular || 0) - Number(a.popular || 0);
        })
        .slice(0, 8);

      const productListProducts = cjProducts.slice(0, 12);

      return res.render('store/index', {
        layout: 'layouts/store',

        title: 'CJ Products | Kasyora',

        seoTitle: 'CJ Dropshipping Products | Kasyora Global Online Store',

        seoDescription:
          'Shop CJ Dropshipping products on Kasyora. Discover global products, product categories and international shopping opportunities through the Kasyora CJ Store.',

        seoCanonicalPath: '/store',

        storeDepartment: 'cj',
        productSource: 'CJ',

        /*
         * Override the global internal category list only while
         * the CJ storefront is active.
         */
        CATEGORIES: cjCategories,

        allProducts,
        newArrivals,
        featuredProducts,
        bestSellerProducts,
        productListProducts,

        heroSlides,

        /*
         * The Featured Right-side Banner and Promo Offers use
         * their own separate CJ configuration models and CjProduct.
         *
         * Internal mid banners still reference Product.customId,
         * so they remain hidden inside the CJ department.
         */
        sideBannerProduct,
        promoOfferLeft,
        promoOfferRight,

        /*
         * Separate CJ Home Mid Banners shared with
         * the CJ Shop page.
         */
        midBannerLeft: cjHomeMidBanners.midBannerLeft,

        midBannerRight: cjHomeMidBanners.midBannerRight,

        selectedKeyword: keyword,
        selectedCategory: category,

        baseCurrency: BASE_CURRENCY,

        /*
         * CJ receives no Kasyora-added VAT.
         */
        vatRate: storefrontTaxContext.vatRate,

        taxTreatment: storefrontTaxContext,

        taxCountryCode: storefrontTaxContext.destinationCountryCode,

        taxCountrySource: storefrontTaxContext.countrySource,

        taxProvisional: true,
        taxAuthoritative: false,
      });
    }

    /*
     * Existing internal seller/supplier storefront flow.
     * This block preserves the previous queries and mappings.
     */
    const baseQuery = {
      stock: {
        $gt: 0,
      },
    };

    if (category) {
      baseQuery.category = category;
    }

    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const keywordRegex = new RegExp(escapedKeyword, 'i');

      baseQuery.$or = [
        { name: keywordRegex },
        { category: keywordRegex },
        { type: keywordRegex },
        { description: keywordRegex },
        { color: keywordRegex },
        { size: keywordRegex },
        { keywords: keywordRegex },
      ];
    }

    const allProductsRaw = await Product.find(baseQuery)
      .sort({
        createdAt: -1,
      })
      .limit(8)
      .lean();

    const newArrivalsRaw = await Product.find(baseQuery)
      .sort({
        createdAt: -1,
        _id: -1,
      })
      .limit(8)
      .lean();

    const featuredProductsRaw = await getFeaturedProducts(8);

    const bestSellerProductsRaw = await Product.find(baseQuery)
      .sort({
        soldCount: -1,
        createdAt: -1,
      })
      .limit(8)
      .lean();

    const productListProductsRaw = await Product.find(baseQuery)
      .sort({
        createdAt: -1,
      })
      .limit(12)
      .lean();

    const allProducts = allProductsRaw.map(mapStoreProduct);

    const newArrivals = newArrivalsRaw.map(mapStoreProduct);

    const featuredProducts = featuredProductsRaw.map(mapStoreProduct);

    const bestSellerProducts = bestSellerProductsRaw.map(mapStoreProduct);

    const productListProducts = productListProductsRaw.map(mapStoreProduct);

    const featuredBanner = await FeaturedBanner.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();

    let sideBannerProduct = null;

    if (featuredBanner?.productCustomId) {
      const rawBannerProduct = await Product.findOne({
        customId: featuredBanner.productCustomId,
        stock: {
          $gt: 0,
        },
      }).lean();

      if (rawBannerProduct) {
        const mapped = mapStoreProduct(rawBannerProduct);

        sideBannerProduct = {
          ...mapped,

          badgeText: featuredBanner.badgeText || 'Special Offer',

          offerText: featuredBanner.offerText || 'Featured Product',
        };
      }
    }

    const homePromoOffersRaw = await HomePromoOffer.find({
      active: true,
    })
      .sort({
        sortOrder: 1,
        createdAt: 1,
      })
      .lean();

    let promoOfferLeft = null;
    let promoOfferRight = null;

    for (const offer of homePromoOffersRaw) {
      if (!offer?.productCustomId) {
        continue;
      }

      const rawProduct = await Product.findOne({
        customId: offer.productCustomId,
        stock: {
          $gt: 0,
        },
      }).lean();

      if (!rawProduct) {
        continue;
      }

      const mappedOffer = mapPromoOffer(offer, rawProduct);

      if (offer.slot === 'left') {
        promoOfferLeft = mappedOffer;
      }

      if (offer.slot === 'right') {
        promoOfferRight = mappedOffer;
      }
    }

    const homeMidBannersRaw = await HomeMidBanner.find({
      active: true,
    })
      .sort({
        sortOrder: 1,
        createdAt: 1,
      })
      .lean();

    let midBannerLeft = null;
    let midBannerRight = null;

    for (const banner of homeMidBannersRaw) {
      if (!banner?.productCustomId) {
        continue;
      }

      const rawProduct = await Product.findOne({
        customId: banner.productCustomId,
        stock: {
          $gt: 0,
        },
      }).lean();

      if (!rawProduct) {
        continue;
      }

      const mappedBanner = mapMidBanner(banner, rawProduct);

      if (banner.slot === 'left') {
        midBannerLeft = mappedBanner;
      }

      if (banner.slot === 'right') {
        midBannerRight = mappedBanner;
      }
    }

    return res.render('store/index', {
      layout: 'layouts/store',

      title: 'Kasyora Store',

      seoTitle: 'Kasyora Online Store | Shop Products from Sellers and Suppliers',

      seoDescription:
        'Shop online with Kasyora and discover products from independent sellers and suppliers. Explore categories, featured products, new arrivals and customer-proven products.',

      seoCanonicalPath: '/store',

      storeDepartment: 'internal',
      productSource: 'INTERNAL',

      allProducts,
      newArrivals,
      featuredProducts,
      bestSellerProducts,
      productListProducts,

      heroSlides,
      sideBannerProduct,
      promoOfferLeft,
      promoOfferRight,
      midBannerLeft,
      midBannerRight,

      selectedKeyword: keyword,
      selectedCategory: category,

      baseCurrency: BASE_CURRENCY,

      vatRate: storefrontTaxContext.vatRate,

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: storefrontTaxContext.provisional === true,

      taxAuthoritative: false,
    });
  } catch (err) {
    console.error('❌ store index error:', err);

    return res.render('store/index', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Products | Kasyora' : 'Kasyora Store',

      seoTitle:
        storeDepartment === 'cj'
          ? 'CJ Dropshipping Products | Kasyora Global Online Store'
          : 'Kasyora Online Store | Shop Products from Sellers and Suppliers',

      seoDescription:
        storeDepartment === 'cj'
          ? 'Shop CJ Dropshipping products on Kasyora. Discover global products, ' +
            'product categories and international shopping opportunities through ' +
            'the Kasyora CJ Store.'
          : 'Shop online with Kasyora and discover products from independent sellers ' +
            'and suppliers. Explore categories, featured products, new arrivals and ' +
            'customer-proven products.',

      seoCanonicalPath: '/store',

      storeDepartment,
      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

      /*
       * Never expose internal categories on a failed CJ response.
       * Internal responses retain the existing global category list.
       */
      CATEGORIES: storeDepartment === 'cj' ? [] : res.locals.CATEGORIES || [],

      allProducts: [],
      newArrivals: [],
      featuredProducts: [],
      bestSellerProducts: [],
      productListProducts: [],

      heroSlides: [],
      sideBannerProduct: null,
      promoOfferLeft: null,
      promoOfferRight: null,
      midBannerLeft: null,
      midBannerRight: null,

      selectedKeyword: String(req.query.keyword || '').trim(),

      selectedCategory: String(req.query.category || '').trim(),

      baseCurrency: BASE_CURRENCY,

      vatRate:
        storeDepartment === 'cj' ? CJ_KASYORA_VAT_RATE : Number(storefrontTaxContext.vatRate),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: true,
      taxAuthoritative: false,
    });
  }
});

router.get('/store/shop', async (req, res) => {
  const storeDepartment = getStoreDepartment(req);

  /*
   * Resolve the provisional storefront tax treatment once for this
   * entire Shop request.
   *
   * Internal:
   * - South Africa receives the configured Internal VAT rate.
   * - destinations outside South Africa receive provisional 0% SA VAT.
   *
   * CJ:
   * - always receives zero Kasyora-added VAT;
   * - never calls the Internal tax resolver.
   *
   * The validated Internal checkout shipping address will later make
   * the authoritative final VAT decision.
   */
  const storefrontTaxContext = resolveStorefrontTaxContext(req, storeDepartment);

  try {
    const keyword = String(req.query.keyword || '').trim();

    const category = String(req.query.category || '').trim();

    const requestedSort = String(req.query.sort || 'default').trim();

    const allowedSorts = new Set([
      'default',
      'popular',
      'newest',
      'rating',
      'price_asc',
      'price_desc',
    ]);

    const selectedSort = allowedSorts.has(requestedSort) ? requestedSort : 'default';

    const requestedPage = Number(req.query.page || 1);

    const perPage = 12;

    /*
     * ==================================================
     * CJ DROPSHIPPING SHOP DEPARTMENT
     * ==================================================
     *
     * This branch reads only CjProduct.
     * It does not query internal Product records,
     * internal ratings, or internal marketing banners.
     */
    if (storeDepartment === 'cj') {
      const [
        cjShopResult,
        cjCategories,
        shopHeaderImage,
        cjHomePromoOffers,
        cjShopMainBannerRaw,
        cjShopSidebarBannerRaw,
        featuredSidebarProducts,
        topRatedTagProducts,
        soldRatedOldProducts,
        bestsellingCategoryGroups,
        cjHomeMidBanners,
      ] = await Promise.all([
        loadCjShopProducts({
          keyword,
          category,
          selectedSort,
          requestedPage,
          perPage,
        }),

        loadCjStoreCategories(),

        /*
         * This is a shared decorative image only.
         * It does not load an Internal Product record.
         */
        ShopHeaderImage.findOne({
          active: true,
        })
          .sort({
            updatedAt: -1,
          })
          .lean(),

        /*
         * The CJ Shop page uses the same two separate
         * CjHomePromoOffer records as the CJ homepage.
         *
         * Do not create a separate CJ Shop promo-offer model.
         */
        CjHomePromoOffer.find({
          active: true,
        })
          .sort({
            sortOrder: 1,
            createdAt: 1,
          })
          .lean(),

        /*
         * Load only the separate CJ Shop Main Banner.
         *
         * This never queries the Internal ShopMainBanner model.
         */
        CjShopMainBanner.findOne({
          singletonKey: 'main',
          active: true,
        })
          .sort({
            updatedAt: -1,
          })
          .lean(),

        /*
         * Load only the separate CJ Shop Sidebar Banner.
         *
         * This never queries the Internal ShopSidebarBanner model.
         */
        CjShopSidebarBanner.findOne({
          active: true,
        })
          .sort({
            updatedAt: -1,
          })
          .lean(),

        /*
         * Load four Featured Products only from CjProduct.
         *
         * getCjFeaturedProducts() already maps the products
         * through mapCjStoreProduct().
         */
        getCjFeaturedProducts(4),

        /*
         * Load CJ TOP RATED PRODUCTS only from CjProduct.
         *
         * avgRating and ratingsCount are maintained by
         * the separate CjRating flow.
         */
        getCjTopRatedProducts(8),

        /*
         * Load no more than 20 oldest CJ products that
         * have sold in more than one distinct successful
         * CJ order and have at least one CJ rating.
         */
        getCjSoldRatedOldProducts(20),

        /*
         * Load the top five CJ sales categories and
         * no more than twenty bestselling CJ products
         * inside each category.
         */
        getCjBestsellingCategories(5, 20),

        /*
         * Load the same CJ Home Mid Banners already used
         * by the CJ homepage.
         */
        loadCjHomeMidBanners(),
      ]);

      /*
       * Resolve the same separate CJ left and right promo offers
       * already used by the CJ Store homepage.
       *
       * Every saved offer is validated against an active imported
       * CjProduct with at least one enabled variant containing:
       *
       * - a CJ variant ID
       * - a CJ variant SKU
       * - a valid selling price excluding VAT
       *
       * No Internal Product or HomePromoOffer record is queried here.
       */
      let promoOfferLeft = null;
      let promoOfferRight = null;

      for (const offer of cjHomePromoOffers) {
        const cjProductId = String(offer?.cjProductId || '').trim();

        if (!cjProductId) {
          continue;
        }

        const rawPromoProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (!rawPromoProduct) {
          continue;
        }

        const mappedOffer = mapCjPromoOffer(offer, rawPromoProduct);

        if (!mappedOffer) {
          continue;
        }

        if (offer.slot === 'left') {
          promoOfferLeft = mappedOffer;
        }

        if (offer.slot === 'right') {
          promoOfferRight = mappedOffer;
        }
      }

      /*
       * Resolve the product linked to the separate
       * CJ Shop Main Banner.
       *
       * This query uses only CjProduct.
       */
      let shopMainBanner = null;

      if (cjShopMainBannerRaw?.cjProductId) {
        const cjProductId = String(cjShopMainBannerRaw.cjProductId || '').trim();

        const rawMainBannerProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (rawMainBannerProduct) {
          shopMainBanner = mapCjShopMainBanner(cjShopMainBannerRaw, rawMainBannerProduct);
        }
      }

      /*
       * Resolve the product linked to the separate
       * CJ Shop Sidebar Banner.
       *
       * This query uses only CjProduct.
       */
      let shopSidebarBanner = null;

      if (cjShopSidebarBannerRaw?.cjProductId) {
        const cjProductId = String(cjShopSidebarBannerRaw.cjProductId || '').trim();

        const rawSidebarBannerProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (rawSidebarBannerProduct) {
          shopSidebarBanner = mapCjShopSidebarBanner(
            cjShopSidebarBannerRaw,
            rawSidebarBannerProduct,
          );
        }
      }

      return res.render('store/shop', {
        layout: 'layouts/store',

        title: 'CJ Shop | Kasyora',

        seoTitle: 'Shop Global CJ Products Online | Kasyora',

        seoDescription:
          'Browse the Kasyora CJ Store for global products across available categories. Compare products, explore popular items and shop through Kasyora online.',

        seoCanonicalPath: '/store/shop',

        storeDepartment: 'cj',
        productSource: 'CJ',

        /*
         * Replace the global internal category list only for
         * this CJ storefront response.
         */
        CATEGORIES: cjCategories,

        shopProducts: cjShopResult.products,

        /*
         * Separate CJ Featured Products loaded only from CjProduct.
         */
        featuredSidebarProducts,

        /*
         * Separate CJ TOP RATED PRODUCTS loaded only from
         * CjProduct rating aggregates maintained by CjRating.
         */
        topRatedTagProducts,

        /*
         * Oldest qualifying CJ products.
         *
         * Every product has:
         *
         * - more than one successful CJ order;
         * - one or more CJ ratings;
         * - an active checkout-ready CJ variant.
         */
        soldRatedOldProducts,

        /*
         * Separate CJ bestselling-category results.
         *
         * Every category contains only CJ products
         * derived from successful CjOrder records.
         */
        bestsellingCategoryGroups,

        /*
         * These are the same CjHomePromoOffer records used
         * by the CJ homepage.
         */
        promoOfferLeft,
        promoOfferRight,

        /*
         * Separate CJ Home Mid Banners shared with
         * the CJ homepage.
         */
        midBannerLeft: cjHomeMidBanners.midBannerLeft,

        midBannerRight: cjHomeMidBanners.midBannerRight,

        /*
         * Separate CJ Shop Sidebar Banner resolved only from
         * CjShopSidebarBanner and CjProduct.
         */
        shopSidebarBanner,

        /*
         * Separate CJ Shop Main Banner resolved above
         * from CjShopMainBanner and CjProduct.
         */
        shopMainBanner,

        shopHeaderImage,

        selectedKeyword: keyword,
        selectedCategory: category,
        selectedSort,

        currentPage: cjShopResult.currentPage,

        totalPages: cjShopResult.totalPages,

        totalProducts: cjShopResult.totalProducts,

        hasPrevPage: cjShopResult.currentPage > 1,

        hasNextPage: cjShopResult.currentPage < cjShopResult.totalPages,

        baseCurrency: BASE_CURRENCY,

        /*
         * CJ always receives zero Kasyora-added VAT.
         */
        vatRate: storefrontTaxContext.vatRate,

        taxTreatment: storefrontTaxContext,

        taxCountryCode: storefrontTaxContext.destinationCountryCode,

        taxCountrySource: storefrontTaxContext.countrySource,

        taxProvisional: storefrontTaxContext.provisional === true,

        taxAuthoritative: false,
      });
    }

    /*
     * ==================================================
     * EXISTING INTERNAL KASYORA SHOP DEPARTMENT
     * ==================================================
     *
     * Preserve the existing internal seller/supplier
     * queries, pagination, ratings and marketing records.
     */
    const shopQuery = {
      stock: {
        $gt: 0,
      },
    };

    if (category) {
      shopQuery.category = category;
    }

    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      const keywordRegex = new RegExp(escapedKeyword, 'i');

      shopQuery.$or = [
        {
          name: keywordRegex,
        },
        {
          category: keywordRegex,
        },
        {
          type: keywordRegex,
        },
        {
          description: keywordRegex,
        },
        {
          color: keywordRegex,
        },
        {
          size: keywordRegex,
        },
        {
          keywords: keywordRegex,
        },
      ];
    }

    let shopSort = {
      createdAt: -1,
      _id: -1,
    };

    if (selectedSort === 'popular') {
      shopSort = {
        soldCount: -1,
        createdAt: -1,
      };
    } else if (selectedSort === 'newest') {
      shopSort = {
        createdAt: -1,
        _id: -1,
      };
    } else if (selectedSort === 'rating') {
      shopSort = {
        avgRating: -1,
        ratingsCount: -1,
        createdAt: -1,
      };
    } else if (selectedSort === 'price_asc') {
      shopSort = {
        price: 1,
        createdAt: -1,
      };
    } else if (selectedSort === 'price_desc') {
      shopSort = {
        price: -1,
        createdAt: -1,
      };
    }

    const totalProducts = await Product.countDocuments(shopQuery);

    const totalPages = Math.max(1, Math.ceil(totalProducts / perPage));

    const safeRequestedPage = Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1;

    const currentPage = Math.min(Math.max(safeRequestedPage, 1), totalPages);

    const skip = (currentPage - 1) * perPage;

    const shopProductsRaw = await Product.find(shopQuery)
      .sort(shopSort)
      .skip(skip)
      .limit(perPage)
      .lean();

    const featuredSidebarRaw = await getFeaturedProducts(4);

    const topRatedTagProductsRaw = await Product.find({
      stock: {
        $gt: 0,
      },

      ratingsCount: {
        $gt: 0,
      },
    })
      .sort({
        ratingsCount: -1,
        avgRating: -1,
        createdAt: -1,
      })
      .limit(8)
      .lean();

    const shopProducts = shopProductsRaw.map(mapStoreProduct);

    const featuredSidebarProducts = featuredSidebarRaw.map(mapStoreProduct);

    const topRatedTagProducts = topRatedTagProductsRaw.map(mapStoreProduct);

    /*
     * Load no more than 20 oldest Internal Kasyora products
     * that have sold in more than one distinct successful
     * Internal order and received at least one rating.
     */
    const soldRatedOldProducts = await getInternalSoldRatedOldProducts(20);

    /*
     * Load the top five Internal sales categories
     * and no more than twenty bestselling Internal
     * products inside each category.
     */
    const bestsellingCategoryGroups = await getInternalBestsellingCategories(5, 20);

    const homePromoOffersRaw = await HomePromoOffer.find({
      active: true,
    })
      .sort({
        sortOrder: 1,
        createdAt: 1,
      })
      .lean();

    let promoOfferLeft = null;
    let promoOfferRight = null;

    for (const offer of homePromoOffersRaw) {
      if (!offer || !offer.productCustomId) {
        continue;
      }

      const rawProduct = await Product.findOne({
        customId: offer.productCustomId,

        stock: {
          $gt: 0,
        },
      }).lean();

      if (!rawProduct) {
        continue;
      }

      const mappedOffer = mapPromoOffer(offer, rawProduct);

      if (offer.slot === 'left') {
        promoOfferLeft = mappedOffer;
      }

      if (offer.slot === 'right') {
        promoOfferRight = mappedOffer;
      }
    }

    const homeMidBannersRaw = await HomeMidBanner.find({
      active: true,
    })
      .sort({
        sortOrder: 1,
        createdAt: 1,
      })
      .lean();

    let midBannerLeft = null;
    let midBannerRight = null;

    for (const banner of homeMidBannersRaw) {
      if (!banner || !banner.productCustomId) {
        continue;
      }

      const rawProduct = await Product.findOne({
        customId: banner.productCustomId,

        stock: {
          $gt: 0,
        },
      }).lean();

      if (!rawProduct) {
        continue;
      }

      const mappedBanner = mapMidBanner(banner, rawProduct);

      if (banner.slot === 'left') {
        midBannerLeft = mappedBanner;
      }

      if (banner.slot === 'right') {
        midBannerRight = mappedBanner;
      }
    }

    const shopSidebarBannerRaw = await ShopSidebarBanner.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();

    let shopSidebarBanner = null;

    if (shopSidebarBannerRaw && shopSidebarBannerRaw.productCustomId) {
      const rawSidebarProduct = await Product.findOne({
        customId: shopSidebarBannerRaw.productCustomId,

        stock: {
          $gt: 0,
        },
      }).lean();

      if (rawSidebarProduct) {
        shopSidebarBanner = mapShopSidebarBanner(shopSidebarBannerRaw, rawSidebarProduct);
      }
    }

    const shopMainBannerRaw = await ShopMainBanner.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();

    let shopMainBanner = null;

    if (shopMainBannerRaw && shopMainBannerRaw.productCustomId) {
      const rawMainProduct = await Product.findOne({
        customId: shopMainBannerRaw.productCustomId,

        stock: {
          $gt: 0,
        },
      }).lean();

      if (rawMainProduct) {
        shopMainBanner = mapShopMainBanner(shopMainBannerRaw, rawMainProduct);
      }
    }

    const shopHeaderImage = await ShopHeaderImage.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();

    return res.render('store/shop', {
      layout: 'layouts/store',

      title: 'Shop',

      seoTitle: 'Shop Products Online | Kasyora Marketplace',

      seoDescription:
        'Browse products on Kasyora by category, popularity, price and rating. Discover products offered by Kasyora sellers and suppliers through our online marketplace.',

      seoCanonicalPath: '/store/shop',

      storeDepartment: 'internal',
      productSource: 'INTERNAL',

      shopProducts,
      featuredSidebarProducts,
      topRatedTagProducts,

      /*
       * Oldest qualifying Internal Kasyora products.
       *
       * Every product has:
       *
       * - more than one successful Internal order;
       * - one or more Internal ratings;
       * - available stock.
       */
      soldRatedOldProducts,

      /*
       * Internal bestselling-category results.
       *
       * Every category contains only Internal products
       * derived from successful Order records.
       */
      bestsellingCategoryGroups,

      promoOfferLeft,
      promoOfferRight,
      midBannerLeft,
      midBannerRight,
      shopSidebarBanner,
      shopMainBanner,
      shopHeaderImage,

      selectedKeyword: keyword,
      selectedCategory: category,
      selectedSort,

      currentPage,
      totalPages,
      totalProducts,

      hasPrevPage: currentPage > 1,

      hasNextPage: currentPage < totalPages,

      baseCurrency: BASE_CURRENCY,

      /*
       * The selected provisional delivery country controls the
       * storefront VAT rate until checkout.
       */
      vatRate: storefrontTaxContext.vatRate,

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: storefrontTaxContext.provisional === true,

      taxAuthoritative: false,
    });
  } catch (err) {
    console.error('❌ store shop error:', err);

    return res.render('store/shop', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Shop | Kasyora' : 'Shop',

      seoTitle:
        storeDepartment === 'cj'
          ? 'Shop Global CJ Products Online | Kasyora'
          : 'Shop Products Online | Kasyora Marketplace',

      seoDescription:
        storeDepartment === 'cj'
          ? 'Browse the Kasyora CJ Store for global products across available ' +
            'categories. Compare products, explore popular items and shop through ' +
            'Kasyora online.'
          : 'Browse products on Kasyora by category, popularity, price and rating. ' +
            'Discover products offered by Kasyora sellers and suppliers through our ' +
            'online marketplace.',

      seoCanonicalPath: '/store/shop',

      storeDepartment,

      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

      /*
       * Never expose internal categories on a failed CJ response.
       * Internal responses retain the existing global category list.
       */
      CATEGORIES: storeDepartment === 'cj' ? [] : res.locals.CATEGORIES || [],

      shopProducts: [],
      featuredSidebarProducts: [],
      topRatedTagProducts: [],
      soldRatedOldProducts: [],
      bestsellingCategoryGroups: [],

      promoOfferLeft: null,
      promoOfferRight: null,
      midBannerLeft: null,
      midBannerRight: null,
      shopSidebarBanner: null,
      shopMainBanner: null,
      shopHeaderImage: null,

      selectedKeyword: String(req.query.keyword || '').trim(),

      selectedCategory: String(req.query.category || '').trim(),

      selectedSort: String(req.query.sort || 'default').trim(),

      currentPage: 1,
      totalPages: 1,
      totalProducts: 0,
      hasPrevPage: false,
      hasNextPage: false,

      baseCurrency: BASE_CURRENCY,

      /*
       * Preserve the correct department-specific tax context even when
       * the Shop product query fails.
       */
      vatRate:
        storeDepartment === 'cj' ? CJ_KASYORA_VAT_RATE : Number(storefrontTaxContext.vatRate),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: true,
      taxAuthoritative: false,
    });
  }
});

router.get('/store/product/:id/share-image', async (req, res) => {
  /*
   * Public sharing platforms usually fetch this URL without
   * the customer's storefront session.
   *
   * Prefer the provisional country embedded in the image URL.
   * Fall back to the normal storefront country context only when
   * the URL does not contain a valid two-letter country code.
   */
  const requestedCountryCode = String(req.query?.country || '')
    .trim()
    .toUpperCase()
    .slice(0, 2);

  const shareTaxContext = /^[A-Z]{2}$/.test(requestedCountryCode)
    ? resolveInternalTaxTreatment({
        destinationCountryCode: requestedCountryCode,

        countrySource: TAX_COUNTRY_SOURCES.CUSTOMER_SELECTION,
      })
    : resolveStorefrontTaxContext(req, 'internal');

  try {
    const rawProduct = await Product.findOne({
      customId: req.params.id,
      stock: { $gt: 0 },
    }).lean();

    if (!rawProduct) {
      return res.status(404).send('Product not found');
    }

    const product = mapStoreProduct(rawProduct);

    const productImageUrl = publicUrl(product.image || product.imageUrl || '');

    const productNameLines = svgTextLines(product.name || 'Product', 24, 2);

    const productCategory = fitText(product.category || 'Product', 28);

    const shareVatRateRaw = Number(shareTaxContext.vatRate || 0);

    const shareVatRate =
      Number.isFinite(shareVatRateRaw) && shareVatRateRaw >= 0 && shareVatRateRaw <= 1
        ? shareVatRateRaw
        : 0;

    const productPrice = storeMoney(
      Number((Number(product.price || 0) * (1 + shareVatRate)).toFixed(2)),
    );

    const productPriceLabel = shareVatRate > 0 ? productPrice + ' incl. VAT' : productPrice;

    const productImageBuffer = await downloadImageBuffer(productImageUrl);

    const productImage = productImageBuffer
      ? await sharp(productImageBuffer)
          .resize(520, 520, {
            fit: 'contain',
            background: '#ffffff',
          })
          .png()
          .toBuffer()
      : await sharp({
          create: {
            width: 520,
            height: 520,
            channels: 4,
            background: '#ffffff',
          },
        })
          .png()
          .toBuffer();

    const svg = `
      <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
        <rect width="1200" height="630" fill="#f8f9fa"/>
        <rect x="40" y="40" width="1120" height="550" rx="36" fill="#ffffff"/>
        <rect x="40" y="40" width="1120" height="550" rx="36" fill="none" stroke="#7C3AED" stroke-width="8"/>
        <rect x="80" y="80" width="520" height="470" rx="28" fill="#ffffff"/>
        <rect x="650" y="105" width="420" height="42" rx="21" fill="#22C55E"/>
        <text x="680" y="134" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">Kasyora STORE</text>
        ${renderSvgTextLines(productNameLines, 650, 215, 50, 58, '#7C3AED', 800)}
        <text x="650" y="340" font-family="Arial, sans-serif" font-size="34" font-weight="600" fill="#212529">Category: ${xmlSafe(productCategory)}</text>
        <text x="650" y="410" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#22C55E">${xmlSafe(productPriceLabel)}</text>
        <text x="650" y="500" font-family="Arial, sans-serif" font-size="28" font-weight="600" fill="#6c757d">Tap to view this product</text>
      </svg>
    `;

    const finalImage = await sharp(Buffer.from(svg))
      .composite([
        {
          input: productImage,
          left: 80,
          top: 80,
        },
      ])
      .jpeg({
        quality: 92,
        progressive: true,
      })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    });

    return res.send(finalImage);
  } catch (err) {
    console.error('❌ product share image error:', err);
    return res.status(500).send('Could not generate share image');
  }
});

router.get('/store/product/:id', async (req, res) => {
  /*
   * The Single Product page belongs only to the Internal
   * Kasyora commerce flow.
   *
   * It inherits the provisional delivery country already
   * resolved by the global tax-country middleware:
   *
   * - customer storefront selection;
   * - trusted GeoIP;
   * - configured default.
   *
   * Checkout shipping address remains authoritative later.
   */
  const storefrontTaxContext = resolveStorefrontTaxContext(req, 'internal');

  try {
    const rawProduct = await Product.findOne({
      customId: req.params.id,
      stock: { $gt: 0 },
    }).lean();

    if (!rawProduct) {
      return res.redirect('/store/shop');
    }

    const product = mapStoreProduct(rawProduct);

    let myRating = null;

    const actorUserId = req.user?._id || req.session?.user?._id || req.session?.userId || null;
    const actorBusinessId = req.session?.business?._id || req.session?.businessId || null;
    const guestKey = getGuestKeyFromReq(req);

    if (actorUserId) {
      myRating = await Rating.findOne({
        productId: rawProduct._id,
        raterType: 'user',
        raterUser: actorUserId,
      })
        .select('stars title body')
        .lean();
    } else if (actorBusinessId) {
      myRating = await Rating.findOne({
        productId: rawProduct._id,
        raterType: 'business',
        raterBusiness: actorBusinessId,
      })
        .select('stars title body')
        .lean();
    } else if (guestKey) {
      myRating = await Rating.findOne({
        productId: rawProduct._id,
        raterType: 'guest',
        guestKey,
      })
        .select('stars title body')
        .lean();
    }

    const featuredSidebarRaw = await getFeaturedProducts(4, rawProduct.customId);

    const relatedProductsRaw = await Product.find({
      stock: { $gt: 0 },
      customId: { $ne: rawProduct.customId },
      $or: [{ category: rawProduct.category || null }, { type: rawProduct.type || null }],
    })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const featuredSidebarProducts = featuredSidebarRaw.map(mapStoreProduct);
    const relatedProducts = relatedProductsRaw.map(mapStoreProduct);

    const shopSidebarBannerRaw = await ShopSidebarBanner.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    let shopSidebarBanner = null;

    if (shopSidebarBannerRaw && shopSidebarBannerRaw.productCustomId) {
      const rawSidebarProduct = await Product.findOne({
        customId: shopSidebarBannerRaw.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (rawSidebarProduct) {
        shopSidebarBanner = mapShopSidebarBanner(shopSidebarBannerRaw, rawSidebarProduct);
      }
    }

    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    const shareVersion = rawProduct.updatedAt
      ? new Date(rawProduct.updatedAt).getTime()
      : Date.now();

    return res.render('store/single', {
      layout: 'layouts/store',
      title: product.name || 'Single Product',
      product: {
        ...product,

        shareUrl: `/store/product/${product.customId}` + `?share=${shareVersion}`,

        /*
         * Include the provisional country in the public image URL.
         *
         * Social platforms normally fetch this image without the
         * customer's Kasyora session cookie. The query value also
         * prevents a South African cached image from being reused
         * for a foreign provisional destination.
         */
        shareImageUrl:
          `/store/product/${product.customId}/share-image` +
          `?v=${shareVersion}` +
          `&country=${encodeURIComponent(storefrontTaxContext.destinationCountryCode || '')}`,
      },
      myRating,
      featuredSidebarProducts,
      relatedProducts,
      shopSidebarBanner,
      shopHeaderImage,

      baseCurrency: BASE_CURRENCY,

      /*
       * Provisional country-aware Internal VAT:
       *
       * South Africa:
       * configured South African VAT rate
       *
       * Outside South Africa:
       * zero South African VAT
       */
      vatRate: Number(storefrontTaxContext.vatRate || 0),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode || '',

      taxCountrySource: storefrontTaxContext.countrySource || '',

      taxProvisional: storefrontTaxContext.provisional === true,

      taxAuthoritative: false,

      siteUrl: APP_URL,
    });
  } catch (err) {
    console.error('❌ store single product error:', err);
    return res.redirect('/store/shop');
  }
});

router.get('/store/cart', async (req, res) => {
  /*
   * The Internal cart page must use the same provisional
   * country-aware VAT treatment as the other Internal
   * storefront pages.
   *
   * The validated Checkout shipping address will later make
   * the authoritative final VAT decision.
   */
  const storefrontTaxContext = resolveStorefrontTaxContext(req, 'internal');

  try {
    const shopHeaderImage = await ShopHeaderImage.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();

    const cartItems = Array.isArray(req.session?.cart?.items) ? req.session.cart.items : [];

    /*
     * Internal cart item.price is VAT-exclusive.
     */
    const cartSubtotal = cartItems.reduce((sum, item) => {
      const price = Number(item?.priceExVat ?? item?.price ?? 0);

      const quantity = Number(item?.quantity || 0);

      const safePrice = Number.isFinite(price) ? price : 0;

      const safeQuantity = Number.isFinite(quantity) ? quantity : 0;

      return sum + safePrice * safeQuantity;
    }, 0);

    const cartCount = cartItems.reduce((sum, item) => {
      const quantity = Number(item?.quantity || 0);

      return sum + (Number.isFinite(quantity) ? quantity : 0);
    }, 0);

    return res.render('store/cart', {
      layout: 'layouts/store',

      title: 'Cart',

      shopHeaderImage,

      cartItems,

      cartSubtotal: Number(cartSubtotal.toFixed(2)),

      cartCount,

      baseCurrency: BASE_CURRENCY,

      /*
       * This is now provisional-country-aware:
       *
       * South Africa:
       * configured Internal VAT rate
       *
       * Outside South Africa:
       * 0
       */
      vatRate: Number(storefrontTaxContext.vatRate),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: storefrontTaxContext.provisional === true,

      taxAuthoritative: false,
    });
  } catch (err) {
    console.error('❌ store cart error:', err);

    return res.render('store/cart', {
      layout: 'layouts/store',

      title: 'Cart',

      shopHeaderImage: null,

      cartItems: [],

      cartSubtotal: 0,

      cartCount: 0,

      baseCurrency: BASE_CURRENCY,

      /*
       * Preserve the resolved provisional tax treatment
       * even when the cart-page data query fails.
       */
      vatRate: Number(storefrontTaxContext.vatRate),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: true,

      taxAuthoritative: false,
    });
  }
});

router.get('/store/contact', async (req, res) => {
  try {
    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    res.render('store/contact', {
      layout: 'layouts/store',
      title: 'Contact',
      shopHeaderImage,
      baseCurrency: BASE_CURRENCY,
    });
  } catch (err) {
    console.error('❌ store contact error:', err);
    res.render('store/contact', {
      layout: 'layouts/store',
      title: 'Contact',
      shopHeaderImage: null,
      baseCurrency: BASE_CURRENCY,
    });
  }
});

router.get('/store/bestseller', async (req, res) => {
  const storeDepartment = getStoreDepartment(req);

  /*
   * Resolve the provisional storefront tax treatment once for this
   * complete Bestseller request.
   *
   * Internal:
   * - South Africa receives the configured Internal VAT rate.
   * - destinations outside South Africa receive provisional 0% SA VAT.
   *
   * CJ:
   * - always receives zero Kasyora-added VAT;
   * - never calls the Internal tax resolver.
   *
   * Checkout will later use the validated shipping address as the
   * authoritative Internal VAT decision.
   */
  const storefrontTaxContext = resolveStorefrontTaxContext(req, storeDepartment);

  try {
    const keyword = String(req.query.keyword || '').trim();

    const category = String(req.query.category || '').trim();

    const requestedSort = String(req.query.sort || 'popular').trim();

    const allowedSorts = new Set(['popular', 'newest', 'rating', 'price_asc', 'price_desc']);

    const selectedSort = allowedSorts.has(requestedSort) ? requestedSort : 'popular';

    /*
     * ==================================================
     * CJ DROPSHIPPING BESTSELLER DEPARTMENT
     * ==================================================
     *
     * This branch reads only CjProduct.
     * It never reads internal Product, BestsellerCard
     * or BestsellerBottomBanner records.
     */
    if (storeDepartment === 'cj') {
      const [cjProducts, cjCategories, cjBestsellerCardsRaw, cjBottomBannersRaw, shopHeaderImage] =
        await Promise.all([
          loadCjHomepageProducts({
            keyword,
            category,
          }),

          loadCjStoreCategories(),

          /*
           * Load only the separate CJ Bestseller Cards.
           *
           * These records contain CjProduct.cjProductId and
           * never reference Internal Product.customId.
           */
          CjBestsellerCard.find({
            active: true,
          })
            .sort({
              sortOrder: 1,
              createdAt: 1,
            })
            .lean(),

          /*
           * Load only the separate CJ Bestseller Bottom
           * Banner records.
           *
           * This never queries BestsellerBottomBanner.
           */
          CjBestsellerBottomBanner.find({
            active: true,
          })
            .sort({
              sortOrder: 1,
              createdAt: 1,
            })
            .lean(),

          /*
           * Shared decorative Bestseller header image.
           * This does not reference an Internal Product.
           */
          ShopHeaderImage.findOne({
            active: true,
          })
            .sort({
              updatedAt: -1,
            })
            .lean(),
        ]);

      const sortedCjProducts = [...cjProducts];

      if (selectedSort === 'newest') {
        /*
         * loadCjHomepageProducts() already returns the
         * newest imported or updated CJ products first.
         */
      } else if (selectedSort === 'rating') {
        sortedCjProducts.sort((left, right) => {
          const ratingDifference = Number(right.avgRating || 0) - Number(left.avgRating || 0);

          if (ratingDifference !== 0) {
            return ratingDifference;
          }

          const ratingsCountDifference =
            Number(right.ratingsCount || 0) - Number(left.ratingsCount || 0);

          if (ratingsCountDifference !== 0) {
            return ratingsCountDifference;
          }

          return String(left.name || '').localeCompare(String(right.name || ''));
        });
      } else if (selectedSort === 'price_asc') {
        sortedCjProducts.sort((left, right) => Number(left.price || 0) - Number(right.price || 0));
      } else if (selectedSort === 'price_desc') {
        sortedCjProducts.sort((left, right) => Number(right.price || 0) - Number(left.price || 0));
      } else {
        /*
         * Default CJ Bestseller ordering:
         *
         * - marketplace popularity
         * - CJ average rating
         * - CJ rating count
         * - product name
         */
        sortedCjProducts.sort((left, right) => {
          const popularityDifference =
            Number(right.popular === true) - Number(left.popular === true);

          if (popularityDifference !== 0) {
            return popularityDifference;
          }

          const ratingDifference = Number(right.avgRating || 0) - Number(left.avgRating || 0);

          if (ratingDifference !== 0) {
            return ratingDifference;
          }

          const ratingsCountDifference =
            Number(right.ratingsCount || 0) - Number(left.ratingsCount || 0);

          if (ratingsCountDifference !== 0) {
            return ratingsCountDifference;
          }

          return String(left.name || '').localeCompare(String(right.name || ''));
        });
      }

      const bestSellerProducts = sortedCjProducts.slice(0, 6);

      const allProducts = sortedCjProducts.slice(0, 8);

      const newArrivals = [...cjProducts].slice(0, 4);

      const featuredProducts = [...cjProducts]
        .sort(
          (left, right) =>
            Number(right.enabledVariantCount || 0) - Number(left.enabledVariantCount || 0),
        )
        .slice(0, 4);

      const topSellingProducts = sortedCjProducts.slice(0, 4);

      const productListProducts = sortedCjProducts.slice(0, 12);

      /*
       * Resolve the completely separate CJ Bestseller Cards
       * against active imported CjProduct records.
       *
       * This block never queries:
       *
       * - BestsellerCard
       * - Product
       * - Product.customId
       */
      let bestsellerLeft = null;
      let bestsellerRight = null;

      for (const card of cjBestsellerCardsRaw) {
        const cjProductId = String(card?.cjProductId || '').trim();

        if (!cjProductId) {
          continue;
        }

        const rawProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (!rawProduct) {
          continue;
        }

        const mappedCard = mapCjBestsellerCard(card, rawProduct);

        if (!mappedCard) {
          continue;
        }

        if (card.slot === 'left') {
          bestsellerLeft = mappedCard;
        }

        if (card.slot === 'right') {
          bestsellerRight = mappedCard;
        }
      }

      /*
       * Resolve the separate CJ Bestseller Bottom
       * Banners against active imported CjProduct records.
       */
      let bottomBannerLeft = null;
      let bottomBannerRight = null;

      for (const banner of cjBottomBannersRaw) {
        const cjProductId = String(banner?.cjProductId || '').trim();

        if (!cjProductId) {
          continue;
        }

        const rawProduct = await CjProduct.findOne({
          status: 'active',

          cjProductId,

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
        }).lean();

        if (!rawProduct) {
          continue;
        }

        const mappedBanner = mapCjBestsellerBottomBanner(banner, rawProduct);

        if (!mappedBanner) {
          continue;
        }

        if (banner.slot === 'left') {
          bottomBannerLeft = mappedBanner;
        }

        if (banner.slot === 'right') {
          bottomBannerRight = mappedBanner;
        }
      }

      return res.render('store/bestseller', {
        layout: 'layouts/store',

        title: 'CJ Bestsellers | Kasyora',

        seoTitle: 'Popular CJ Dropshipping Products | Kasyora Bestsellers',

        seoDescription:
          'Explore popular and bestselling CJ Dropshipping products on Kasyora. Discover highly rated products, popular categories and global shopping opportunities.',

        seoCanonicalPath: '/store/bestseller',

        storeDepartment: 'cj',

        productSource: 'CJ',

        /*
         * Use only categories obtained from active
         * imported CJ products.
         */
        CATEGORIES: cjCategories,

        selectedSort,

        bestSellerProducts,
        allProducts,
        newArrivals,
        featuredProducts,
        topSellingProducts,
        productListProducts,

        /*
         * Separate CJ Bestseller Cards resolved only from:
         *
         * - CjBestsellerCard
         * - CjProduct
         */
        bestsellerLeft,

        bestsellerRight,

        /*
         * Separate CJ Bestseller Bottom Banners.
         */
        bottomBannerLeft,

        bottomBannerRight,

        shopHeaderImage,

        selectedKeyword: keyword,

        selectedCategory: category,

        baseCurrency: BASE_CURRENCY,

        /*
         * CJ always receives zero Kasyora-added VAT.
         */
        vatRate: storefrontTaxContext.vatRate,

        taxTreatment: storefrontTaxContext,

        taxCountryCode: storefrontTaxContext.destinationCountryCode,

        taxCountrySource: storefrontTaxContext.countrySource,

        taxProvisional: storefrontTaxContext.provisional === true,

        taxAuthoritative: false,
      });
    }

    /*
     * ==================================================
     * INTERNAL KASYORA BESTSELLER DEPARTMENT
     * ==================================================
     *
     * Preserve the existing internal product,
     * banner and sales-history flow.
     */
    const bestsellerQuery = {
      stock: {
        $gt: 0,
      },
    };

    if (category) {
      bestsellerQuery.category = category;
    }

    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keywordRegex = new RegExp(escapedKeyword, 'i');

      bestsellerQuery.$or = [
        { name: keywordRegex },
        { category: keywordRegex },
        { type: keywordRegex },
        { description: keywordRegex },
        { color: keywordRegex },
        { size: keywordRegex },
        { keywords: keywordRegex },
      ];
    }

    let bestsellerSort = {
      soldCount: -1,
      createdAt: -1,
    };

    if (selectedSort === 'newest') {
      bestsellerSort = {
        createdAt: -1,
        _id: -1,
      };
    } else if (selectedSort === 'rating') {
      bestsellerSort = {
        avgRating: -1,
        ratingsCount: -1,
        createdAt: -1,
      };
    } else if (selectedSort === 'price_asc') {
      bestsellerSort = {
        price: 1,
        createdAt: -1,
      };
    } else if (selectedSort === 'price_desc') {
      bestsellerSort = {
        price: -1,
        createdAt: -1,
      };
    }

    const bestSellerProductsRaw = await Product.find(bestsellerQuery)
      .sort(bestsellerSort)
      .limit(6)
      .lean();

    const allProductsRaw = await Product.find(bestsellerQuery).sort(bestsellerSort).limit(8).lean();

    const newArrivalsRaw = await Product.find(bestsellerQuery)
      .sort({ createdAt: -1, _id: -1 })
      .limit(4)
      .lean();

    const featuredProductsRaw = await Product.find(bestsellerQuery)
      .sort({ createdAt: -1 })
      .limit(4)
      .lean();

    const topSellingProductsRaw = await Product.find(bestsellerQuery)
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(4)
      .lean();

    const productListProductsRaw = await Product.find(bestsellerQuery)
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    const bestSellerProducts = bestSellerProductsRaw.map(mapStoreProduct);
    const allProducts = allProductsRaw.map(mapStoreProduct);
    const newArrivals = newArrivalsRaw.map(mapStoreProduct);
    const featuredProducts = featuredProductsRaw.map(mapStoreProduct);
    const topSellingProducts = topSellingProductsRaw.map(mapStoreProduct);
    const productListProducts = productListProductsRaw.map(mapStoreProduct);

    const cardsRaw = await BestsellerCard.find({ active: true }).sort({ sortOrder: 1 }).lean();

    let bestsellerLeft = null;
    let bestsellerRight = null;

    for (const card of cardsRaw) {
      const product = await Product.findOne({
        customId: card.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!product) continue;

      const final = mapBestsellerCard(card, product);

      if (card.slot === 'left') bestsellerLeft = final;
      if (card.slot === 'right') bestsellerRight = final;
    }

    const bottomBannersRaw = await BestsellerBottomBanner.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    let bottomBannerLeft = null;
    let bottomBannerRight = null;

    for (const banner of bottomBannersRaw) {
      if (!banner || !banner.productCustomId) continue;

      const rawProduct = await Product.findOne({
        customId: banner.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!rawProduct) continue;

      const mappedBanner = mapBestsellerBottomBanner(banner, rawProduct);

      if (banner.slot === 'left') {
        bottomBannerLeft = mappedBanner;
      }

      if (banner.slot === 'right') {
        bottomBannerRight = mappedBanner;
      }
    }

    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    return res.render('store/bestseller', {
      layout: 'layouts/store',

      title: 'Bestseller',

      seoTitle: 'Bestselling Products Online | Kasyora',

      seoDescription:
        'Discover bestselling and popular products on Kasyora. Explore products customers buy, rate and recommend across Kasyora marketplace categories.',

      seoCanonicalPath: '/store/bestseller',

      storeDepartment: 'internal',
      productSource: 'INTERNAL',

      selectedSort,

      bestSellerProducts,
      allProducts,
      newArrivals,
      featuredProducts,
      topSellingProducts,
      productListProducts,

      bestsellerLeft,
      bestsellerRight,
      bottomBannerLeft,
      bottomBannerRight,

      shopHeaderImage,

      selectedKeyword: keyword,
      selectedCategory: category,

      baseCurrency: BASE_CURRENCY,

      /*
       * The selected provisional delivery country controls the
       * storefront VAT rate until checkout.
       */
      vatRate: storefrontTaxContext.vatRate,

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: storefrontTaxContext.provisional === true,

      taxAuthoritative: false,
    });
  } catch (err) {
    console.error('❌ store bestseller error:', err);

    return res.render('store/bestseller', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Bestsellers | Kasyora' : 'Bestseller',

      seoTitle:
        storeDepartment === 'cj'
          ? 'Popular CJ Dropshipping Products | Kasyora Bestsellers'
          : 'Bestselling Products Online | Kasyora',

      seoDescription:
        storeDepartment === 'cj'
          ? 'Explore popular and bestselling CJ Dropshipping products on Kasyora. ' +
            'Discover highly rated products, popular categories and global shopping ' +
            'opportunities.'
          : 'Discover bestselling and popular products on Kasyora. Explore products ' +
            'customers buy, rate and recommend across Kasyora marketplace categories.',

      seoCanonicalPath: '/store/bestseller',

      storeDepartment,

      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

      /*
       * Never expose Internal Store categories after
       * a failed CJ Bestseller request.
       */
      CATEGORIES: storeDepartment === 'cj' ? [] : res.locals.CATEGORIES || [],

      selectedSort: String(req.query.sort || 'popular').trim(),

      bestSellerProducts: [],
      allProducts: [],
      newArrivals: [],
      featuredProducts: [],
      topSellingProducts: [],
      productListProducts: [],

      bestsellerLeft: null,
      bestsellerRight: null,
      bottomBannerLeft: null,
      bottomBannerRight: null,

      shopHeaderImage: null,

      selectedKeyword: String(req.query.keyword || '').trim(),

      selectedCategory: String(req.query.category || '').trim(),

      baseCurrency: BASE_CURRENCY,

      /*
       * Preserve the correct department-specific tax context even when
       * the Bestseller product query fails.
       */
      vatRate:
        storeDepartment === 'cj' ? CJ_KASYORA_VAT_RATE : Number(storefrontTaxContext.vatRate),

      taxTreatment: storefrontTaxContext,

      taxCountryCode: storefrontTaxContext.destinationCountryCode,

      taxCountrySource: storefrontTaxContext.countrySource,

      taxProvisional: true,
      taxAuthoritative: false,
    });
  }
});

router.get('/store/404', async (req, res) => {
  try {
    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    res.status(404).render('store/404', {
      layout: 'layouts/store',
      title: 'The product you search for is not found',
      shopHeaderImage,
      baseCurrency: BASE_CURRENCY,
    });
  } catch (err) {
    console.error('❌ store 404 error:', err);
    res.status(404).render('store/404', {
      layout: 'layouts/store',
      title: 'Product Not Found',
      shopHeaderImage: null,
      baseCurrency: BASE_CURRENCY,
    });
  }
});

module.exports = router;
