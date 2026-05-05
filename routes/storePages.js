// routes/storePages.js
'use strict';

const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
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

const BASE_CURRENCY = String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
const APP_URL = String(process.env.APP_URL || 'http://localhost:3000').trim().replace(/\/+$/, '');
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
  const excludeFilter = excludeCustomId
    ? { customId: { $ne: excludeCustomId } }
    : {};

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
    $or: [
      { isOnSale: true },
      { isNewItem: true },
    ],
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
      maximumFractionDigits: 2
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
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
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
  return lines.map((line, index) => {
    const y = firstY + (index * lineGap);

    return `<text x="${x}" y="${y}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${color}">${xmlSafe(line)}</text>`;
  }).join('');
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
  try {
    const keyword = String(req.query.keyword || '').trim();
    const category = String(req.query.category || '').trim();

    const baseQuery = {
      stock: { $gt: 0 },
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
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    const newArrivalsRaw = await Product.find(baseQuery)
      .sort({ createdAt: -1, _id: -1 })
      .limit(8)
      .lean();

    const featuredProductsRaw = await getFeaturedProducts(8);

    const bestSellerProductsRaw = await Product.find(baseQuery)
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(8)
      .lean();

    const productListProductsRaw = await Product.find(baseQuery)
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    const allProducts = allProductsRaw.map(mapStoreProduct);
    const newArrivals = newArrivalsRaw.map(mapStoreProduct);
    const featuredProducts = featuredProductsRaw.map(mapStoreProduct);
    const bestSellerProducts = bestSellerProductsRaw.map(mapStoreProduct);
    const productListProducts = productListProductsRaw.map(mapStoreProduct);

    const heroSlidesRaw = await HeroSlide.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const heroSlides = heroSlidesRaw.map((slide) => ({
      title: slide.title || '',
      subtitle: slide.subtitle || '',
      description: slide.description || '',
      image: slide.image || '',
      buttonText: slide.buttonText || 'Shop Now',
      buttonUrl: slide.buttonUrl || '/store/shop',
    }));

    const featuredBanner = await FeaturedBanner.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    let sideBannerProduct = null;

    if (featuredBanner?.productCustomId) {
      const rawBannerProduct = await Product.findOne({
        customId: featuredBanner.productCustomId,
        stock: { $gt: 0 },
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

    const homePromoOffersRaw = await HomePromoOffer.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    let promoOfferLeft = null;
    let promoOfferRight = null;

    for (const offer of homePromoOffersRaw) {
      if (!offer?.productCustomId) continue;

      const rawProduct = await Product.findOne({
        customId: offer.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!rawProduct) continue;

      const mappedOffer = mapPromoOffer(offer, rawProduct);

      if (offer.slot === 'left') {
        promoOfferLeft = mappedOffer;
      }

      if (offer.slot === 'right') {
        promoOfferRight = mappedOffer;
      }
    }

    const homeMidBannersRaw = await HomeMidBanner.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    let midBannerLeft = null;
    let midBannerRight = null;

    for (const banner of homeMidBannersRaw) {
      if (!banner?.productCustomId) continue;

      const rawProduct = await Product.findOne({
        customId: banner.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!rawProduct) continue;

      const mappedBanner = mapMidBanner(banner, rawProduct);

      if (banner.slot === 'left') {
        midBannerLeft = mappedBanner;
      }

      if (banner.slot === 'right') {
        midBannerRight = mappedBanner;
      }
    }

    res.render('store/index', {
      layout: 'layouts/store',
      title: 'Unicoporate Store',
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
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ store index error:', err);
    res.render('store/index', {
      layout: 'layouts/store',
      title: 'Unicoporate Store',
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
      selectedKeyword: '',
      selectedCategory: '',
      baseCurrency: BASE_CURRENCY,
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  }
});

router.get('/store/shop', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const category = String(req.query.category || '').trim();
    const selectedSort = String(req.query.sort || 'default').trim();
    const requestedPage = Number(req.query.page || 1);
    const perPage = 12;

    const shopQuery = {
      stock: { $gt: 0 },
    };

    if (category) {
      shopQuery.category = category;
    }

    if (keyword) {
      const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const keywordRegex = new RegExp(escapedKeyword, 'i');

      shopQuery.$or = [
        { name: keywordRegex },
        { category: keywordRegex },
        { type: keywordRegex },
        { description: keywordRegex },
        { color: keywordRegex },
        { size: keywordRegex },
        { keywords: keywordRegex },
      ];
    }

    let shopSort = { createdAt: -1, _id: -1 };

    if (selectedSort === 'popular') {
      shopSort = { soldCount: -1, createdAt: -1 };
    } else if (selectedSort === 'newest') {
      shopSort = { createdAt: -1, _id: -1 };
    } else if (selectedSort === 'rating') {
      shopSort = { avgRating: -1, ratingsCount: -1, createdAt: -1 };
    } else if (selectedSort === 'price_asc') {
      shopSort = { price: 1, createdAt: -1 };
    } else if (selectedSort === 'price_desc') {
      shopSort = { price: -1, createdAt: -1 };
    }

    const totalProducts = await Product.countDocuments(shopQuery);
    const totalPages = Math.max(1, Math.ceil(totalProducts / perPage));
    const currentPage = Math.min(Math.max(requestedPage, 1), totalPages);
    const skip = (currentPage - 1) * perPage;

    const shopProductsRaw = await Product.find(shopQuery)
      .sort(shopSort)
      .skip(skip)
      .limit(perPage)
      .lean();

    const featuredSidebarRaw = await getFeaturedProducts(4);

    const topRatedTagProductsRaw = await Product.find({
      stock: { $gt: 0 },
      ratingsCount: { $gt: 0 },
    })
      .sort({ ratingsCount: -1, avgRating: -1, createdAt: -1 })
      .limit(8)
      .lean();

    const shopProducts = shopProductsRaw.map(mapStoreProduct);
    const featuredSidebarProducts = featuredSidebarRaw.map(mapStoreProduct);
    const topRatedTagProducts = topRatedTagProductsRaw.map(mapStoreProduct);

    const homePromoOffersRaw = await HomePromoOffer.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    let promoOfferLeft = null;
    let promoOfferRight = null;

    for (const offer of homePromoOffersRaw) {
      if (!offer || !offer.productCustomId) continue;

      const rawProduct = await Product.findOne({
        customId: offer.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!rawProduct) continue;

      const mappedOffer = mapPromoOffer(offer, rawProduct);

      if (offer.slot === 'left') {
        promoOfferLeft = mappedOffer;
      }

      if (offer.slot === 'right') {
        promoOfferRight = mappedOffer;
      }
    }

    const homeMidBannersRaw = await HomeMidBanner.find({ active: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    let midBannerLeft = null;
    let midBannerRight = null;

    for (const banner of homeMidBannersRaw) {
      if (!banner || !banner.productCustomId) continue;

      const rawProduct = await Product.findOne({
        customId: banner.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!rawProduct) continue;

      const mappedBanner = mapMidBanner(banner, rawProduct);

      if (banner.slot === 'left') {
        midBannerLeft = mappedBanner;
      }

      if (banner.slot === 'right') {
        midBannerRight = mappedBanner;
      }
    }

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

    const shopMainBannerRaw = await ShopMainBanner.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    let shopMainBanner = null;

    if (shopMainBannerRaw && shopMainBannerRaw.productCustomId) {
      const rawMainProduct = await Product.findOne({
        customId: shopMainBannerRaw.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (rawMainProduct) {
        shopMainBanner = mapShopMainBanner(shopMainBannerRaw, rawMainProduct);
      }
    }

    const shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
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
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ store shop error:', err);
    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
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
      selectedKeyword: '',
      selectedCategory: '',
      selectedSort: 'default',
      currentPage: 1,
      totalPages: 1,
      totalProducts: 0,
      hasPrevPage: false,
      hasNextPage: false,
      baseCurrency: BASE_CURRENCY,
      vatRate: Number(process.env.VAT_RATE || 0.15),
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
            background: '#ffffff'
          })
          .png()
          .toBuffer()
      : await sharp({
          create: {
            width: 520,
            height: 520,
            channels: 4,
            background: '#ffffff'
          }
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
        <text x="680" y="134" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#ffffff">UNICOPORATE STORE</text>
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
          top: 80
        }
      ])
      .jpeg({
        quality: 92,
        progressive: true
      })
      .toBuffer();

    res.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'public, max-age=86400'
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
      $or: [
        { category: rawProduct.category || null },
        { type: rawProduct.type || null },
      ],
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
        shopSidebarBanner = mapShopSidebarBanner(
          shopSidebarBannerRaw,
          rawSidebarProduct
        );
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
        shareImageUrl: `/store/product/${product.customId}/share-image?v=${shareVersion}`
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

    const cartItems = Array.isArray(req.session?.cart?.items)
      ? req.session.cart.items
      : [];

    const cartSubtotal = cartItems.reduce((sum, item) => {
      const price = Number(item.price || 0);
      const quantity = Number(item.quantity || 0);
      return sum + (price * quantity);
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
  try {
    const keyword = String(req.query.keyword || '').trim();
    const category = String(req.query.category || '').trim();

    const bestsellerQuery = {
      stock: { $gt: 0 },
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

    const cardsRaw = await BestsellerCard.find({ active: true })
      .sort({ sortOrder: 1 })
      .lean();

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

    res.render('store/bestseller', {
      layout: 'layouts/store',
      title: 'Bestseller',
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
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ store bestseller error:', err);
    res.render('store/bestseller', {
      layout: 'layouts/store',
      title: 'Bestseller',
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
      selectedKeyword: '',
      selectedCategory: '',
      baseCurrency: BASE_CURRENCY,
      vatRate: Number(process.env.VAT_RATE || 0.15),
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