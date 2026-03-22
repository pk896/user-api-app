// routes/storePages.js
'use strict';

const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const HeroSlide = require('../models/HeroSlide');
const FeaturedBanner = require('../models/FeaturedBanner');
const HomePromoOffer = require('../models/HomePromoOffer');
const HomeMidBanner = require('../models/HomeMidBanner');
const BestsellerCard = require('../models/BestsellerCard');
const BestsellerBottomBanner = require('../models/BestsellerBottomBanner');
const ShopSidebarBanner = require('../models/ShopSidebarBanner');

function mapStoreProduct(p) {
  const price = Number(p.price || 0);
  const oldPrice = p.isOnSale ? Number((price * 1.19).toFixed(2)) : null;

  return {
    id: p.customId,
    customId: p.customId,
    name: p.name || 'Product',
    description: p.description || '',
    image: p.imageUrl,
    category: p.category || p.type || 'Product',
    price,
    oldPrice,
    isNew: !!p.isNewItem,
    sale: !!p.isOnSale,
    popular: !!p.isPopular,
    stock: Number(p.stock || 0),
    rating: 4,
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

router.get('/store', async (req, res) => {
  try {
    const allProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    const newArrivalsRaw = await Product.find({
      stock: { $gt: 0 },
      isNewItem: true,
    })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    const featuredProductsRaw = await Product.find({
      stock: { $gt: 0 },
      isPopular: true,
    })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    const bestSellerProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(8)
      .lean();

    const productListProductsRaw = await Product.find({ stock: { $gt: 0 } })
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
      title: 'Electro Store',
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
    });
  } catch (err) {
    console.error('❌ store index error:', err);
    res.render('store/index', {
      layout: 'layouts/store',
      title: 'Electro Store',
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
    });
  }
});

router.get('/store/shop', async (req, res) => {
  try {
    const shopProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .limit(12)
      .lean();

    const featuredSidebarRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(4)
      .lean();

    const shopProducts = shopProductsRaw.map(mapStoreProduct);
    const featuredSidebarProducts = featuredSidebarRaw.map(mapStoreProduct);

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

    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
      shopProducts,
      featuredSidebarProducts,
      promoOfferLeft,
      promoOfferRight,
      midBannerLeft,
      midBannerRight,
      shopSidebarBanner,
    });
  } catch (err) {
    console.error('❌ store shop error:', err);
    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
      shopProducts: [],
      featuredSidebarProducts: [],
      promoOfferLeft: null,
      promoOfferRight: null,
      midBannerLeft: null,
      midBannerRight: null,
      shopSidebarBanner: null,
    });
  }
});

router.get('/store/product/:id', async (req, res) => {
  try {
    const rawProduct = await Product.findOne({
      customId: req.params.id,
      stock: { $gt: 0 },
    }).lean();

    if (!rawProduct) {
      return res.redirect('/store/404');
    }

    const product = mapStoreProduct(rawProduct);

    const featuredSidebarRaw = await Product.find({
      stock: { $gt: 0 },
      customId: { $ne: rawProduct.customId },
    })
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(6)
      .lean();

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

    return res.render('store/single', {
      layout: 'layouts/store',
      title: product.name || 'Single Product',
      product,
      featuredSidebarProducts,
      relatedProducts,
    });
  } catch (err) {
    console.error('❌ store single product error:', err);
    return res.redirect('/store/404');
  }
});

router.get('/store/cart', (req, res) => {
  res.render('store/cart', {
    layout: 'layouts/store',
    title: 'Cart',
  });
});

router.get('/store/checkout', (req, res) => {
  res.render('store/checkout', {
    layout: 'layouts/store',
    title: 'Checkout',
  });
});

router.get('/store/contact', (req, res) => {
  res.render('store/contact', {
    layout: 'layouts/store',
    title: 'Contact',
  });
});

router.get('/store/bestseller', async (req, res) => {
  try {
    const bestSellerProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(6)
      .lean();

    const allProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .limit(8)
      .lean();

    const newArrivalsRaw = await Product.find({
      stock: { $gt: 0 },
      isNewItem: true,
    })
      .sort({ createdAt: -1 })
      .limit(4)
      .lean();

    const featuredProductsRaw = await Product.find({
      stock: { $gt: 0 },
      isPopular: true,
    })
      .sort({ createdAt: -1 })
      .limit(4)
      .lean();

    const topSellingProductsRaw = await Product.find({ stock: { $gt: 0 } })
      .sort({ soldCount: -1, createdAt: -1 })
      .limit(4)
      .lean();

    const productListProductsRaw = await Product.find({ stock: { $gt: 0 } })
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
    });
  }
});

router.get('/store/404', (req, res) => {
  res.status(404).render('store/404', {
    layout: 'layouts/store',
    title: 'Page Not Found',
  });
});

module.exports = router;