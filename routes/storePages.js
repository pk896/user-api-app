// routes/storePages.js
'use strict';

const express = require('express');
const router = express.Router();
const Product = require('../models/Product');
const HeroSlide = require('../models/HeroSlide');
const FeaturedBanner = require('../models/FeaturedBanner');

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

    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
      shopProducts,
      featuredSidebarProducts,
    });
  } catch (err) {
    console.error('❌ store shop error:', err);
    res.render('store/shop', {
      layout: 'layouts/store',
      title: 'Shop',
      shopProducts: [],
      featuredSidebarProducts: [],
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

    res.render('store/bestseller', {
      layout: 'layouts/store',
      title: 'Bestseller',
      bestSellerProducts,
      allProducts,
      newArrivals,
      featuredProducts,
      topSellingProducts,
      productListProducts,
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