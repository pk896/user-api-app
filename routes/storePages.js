// routes/storePages.js
'use strict';
const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const CjProduct = require('../models/CjProduct');
const Rating = require('../models/Rating');
const HeroSlide = require('../models/HeroSlide');
const FeaturedBanner = require('../models/FeaturedBanner');
const HomePromoOffer = require('../models/HomePromoOffer');
const HomeMidBanner = require('../models/HomeMidBanner');
const BestsellerCard = require('../models/BestsellerCard');
const BestsellerBottomBanner = require('../models/BestsellerBottomBanner');
const ShopSidebarBanner = require('../models/ShopSidebarBanner');
const ShopMainBanner = require('../models/ShopMainBanner');
const ShopHeaderImage = require('../models/ShopHeaderImage');
const sharp = require('sharp');
const http = require('http');
const https = require('https');

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '')
    .trim()
    .toUpperCase() || 'USD';
const APP_URL = String(process.env.APP_URL || 'http://localhost:3000')
  .trim()
  .replace(/\/+$/, '');
const VAT_RATE = Number(process.env.VAT_RATE || 0.15);

function mapStoreProduct(p) {
  const vatRate = Number(process.env.VAT_RATE || 0.15);
  const price = Number(p.price || 0);
  const priceWithVat = Number((price * (1 + vatRate)).toFixed(2));
  const oldPrice = p.isOnSale ? Number((priceWithVat * 1.19).toFixed(2)) : null;

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
    price,
    oldPrice,
    isNew: !!p.isNewItem,
    sale: !!p.isOnSale,
    popular: !!p.isPopular,
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
    const activeHeroShopUrl = buildStoreDepartmentUrl(
      '/store/shop',
      storeDepartment,
    );

    const heroSlides = heroSlidesRaw.map((slide) => ({
      title: slide.title || '',
      subtitle: slide.subtitle || '',
      description: slide.description || '',
      image: slide.image || '',
      buttonText: slide.buttonText || 'Shop Now',
      buttonUrl: activeHeroShopUrl,
    }));

    if (storeDepartment === 'cj') {
      const cjProducts = await loadCjHomepageProducts({
        keyword,
        category,
      });

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

        storeDepartment: 'cj',
        productSource: 'CJ',

        allProducts,
        newArrivals,
        featuredProducts,
        bestSellerProducts,
        productListProducts,

        heroSlides,

        /*
         * These records are linked to internal Product custom IDs.
         * They must not appear while the CJ department is active.
         */
        sideBannerProduct: null,
        promoOfferLeft: null,
        promoOfferRight: null,
        midBannerLeft: null,
        midBannerRight: null,

        selectedKeyword: keyword,
        selectedCategory: category,

        baseCurrency: BASE_CURRENCY,
        vatRate: VAT_RATE,
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
      vatRate: VAT_RATE,
    });
  } catch (err) {
    console.error('❌ store index error:', err);

    return res.render('store/index', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Products | Kasyora' : 'Kasyora Store',

      storeDepartment,
      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

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
      vatRate: VAT_RATE,
    });
  }
});

router.get('/store/shop', async (req, res) => {
  const storeDepartment = getStoreDepartment(req);

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
      const cjShopResult = await loadCjShopProducts({
        keyword,
        category,
        selectedSort,
        requestedPage,
        perPage,
      });

      /*
       * Internal marketing records reference internal
       * Product custom IDs. They must not be displayed
       * while the CJ department is active.
       */
      const shopHeaderImage = await ShopHeaderImage.findOne({
        active: true,
      })
        .sort({
          updatedAt: -1,
        })
        .lean();

      return res.render('store/shop', {
        layout: 'layouts/store',

        title: 'CJ Shop | Kasyora',

        storeDepartment: 'cj',
        productSource: 'CJ',

        shopProducts: cjShopResult.products,

        /*
         * The current sidebar and rating sections are
         * connected to internal Product records.
         * Keep them empty in the CJ department until
         * dedicated CJ versions are introduced.
         */
        featuredSidebarProducts: [],
        topRatedTagProducts: [],

        promoOfferLeft: null,
        promoOfferRight: null,
        midBannerLeft: null,
        midBannerRight: null,
        shopSidebarBanner: null,
        shopMainBanner: null,

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
        vatRate: VAT_RATE,
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

      storeDepartment: 'internal',
      productSource: 'INTERNAL',

      shopProducts,
      featuredSidebarProducts,
      topRatedTagProducts,

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
      vatRate: VAT_RATE,
    });
  } catch (err) {
    console.error('❌ store shop error:', err);

    return res.render('store/shop', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Shop | Kasyora' : 'Shop',

      storeDepartment,

      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

      shopProducts: [],
      featuredSidebarProducts: [],
      topRatedTagProducts: [],

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
      vatRate: VAT_RATE,
    });
  }
});

router.get('/store/product/:id/share-image', async (req, res) => {
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
    const productPrice = storeMoney(Number(product.price || 0) * (1 + VAT_RATE));

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
        <text x="650" y="410" font-family="Arial, sans-serif" font-size="44" font-weight="800" fill="#22C55E">${xmlSafe(productPrice)} incl. VAT</text>
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
        shareUrl: `/store/product/${product.customId}?share=${shareVersion}`,
        shareImageUrl: `/store/product/${product.customId}/share-image?v=${shareVersion}`,
      },
      myRating,
      featuredSidebarProducts,
      relatedProducts,
      shopSidebarBanner,
      shopHeaderImage,
      baseCurrency: BASE_CURRENCY,
      vatRate: VAT_RATE,
      siteUrl: APP_URL,
    });
  } catch (err) {
    console.error('❌ store single product error:', err);
    return res.redirect('/store/shop');
  }
});

router.get('/store/cart', async (req, res) => {
  try {
    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    const cartItems = Array.isArray(req.session?.cart?.items) ? req.session.cart.items : [];

    const cartSubtotal = cartItems.reduce((sum, item) => {
      const price = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      return sum + price * quantity;
    }, 0);

    const cartCount = cartItems.reduce((sum, item) => {
      return sum + Number(item.quantity || 0);
    }, 0);

    res.render('store/cart', {
      layout: 'layouts/store',
      title: 'Cart',
      shopHeaderImage,
      cartItems,
      cartSubtotal,
      cartCount,
      baseCurrency: BASE_CURRENCY,
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ store cart error:', err);
    res.render('store/cart', {
      layout: 'layouts/store',
      title: 'Cart',
      shopHeaderImage: null,
      cartItems: [],
      cartSubtotal: 0,
      cartCount: 0,
      baseCurrency: BASE_CURRENCY,
      vatRate: Number(process.env.VAT_RATE || 0.15),
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

  try {
    const keyword = String(req.query.keyword || '').trim();

    const category = String(req.query.category || '').trim();

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
      const cjProducts = await loadCjHomepageProducts({
        keyword,
        category,
      });

      const sortedCjProducts = [...cjProducts].sort((left, right) => {
        const popularityDifference = Number(right.popular === true) - Number(left.popular === true);

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

      const bestSellerProducts = sortedCjProducts.slice(0, 6);

      const allProducts = cjProducts.slice(0, 8);

      const newArrivals = cjProducts.slice(0, 4);

      const featuredProducts = [...cjProducts]
        .sort((left, right) => {
          return Number(right.enabledVariantCount || 0) - Number(left.enabledVariantCount || 0);
        })
        .slice(0, 4);

      const topSellingProducts = sortedCjProducts.slice(0, 4);

      const productListProducts = cjProducts.slice(0, 12);

      const shopHeaderImage = await ShopHeaderImage.findOne({
        active: true,
      })
        .sort({
          updatedAt: -1,
        })
        .lean();

      return res.render('store/bestseller', {
        layout: 'layouts/store',
        title: 'CJ Bestsellers | Kasyora',

        storeDepartment: 'cj',
        productSource: 'CJ',

        bestSellerProducts,
        allProducts,
        newArrivals,
        featuredProducts,
        topSellingProducts,
        productListProducts,

        /*
         * These marketing records reference internal
         * Product custom IDs and must never appear
         * inside the CJ department.
         */
        bestsellerLeft: null,
        bestsellerRight: null,
        bottomBannerLeft: null,
        bottomBannerRight: null,

        shopHeaderImage,

        selectedKeyword: keyword,
        selectedCategory: category,

        baseCurrency: BASE_CURRENCY,
        vatRate: VAT_RATE,
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

    const bestSellerProductsRaw = await Product.find(bestsellerQuery)
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(6)
      .lean();

    const allProductsRaw = await Product.find(bestsellerQuery)
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

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

      storeDepartment: 'internal',
      productSource: 'INTERNAL',

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
      vatRate: VAT_RATE,
    });
  } catch (err) {
    console.error('❌ store bestseller error:', err);

    return res.render('store/bestseller', {
      layout: 'layouts/store',

      title: storeDepartment === 'cj' ? 'CJ Bestsellers | Kasyora' : 'Bestseller',

      storeDepartment,

      productSource: storeDepartment === 'cj' ? 'CJ' : 'INTERNAL',

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
      vatRate: VAT_RATE,
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
