// routes/storePages.js
const express = require('express');
const router = express.Router();

router.get('/store', (req, res) => {
  res.render('store/index', {
    layout: 'layouts/store',
    title: 'Electro Store',
  });
});

router.get('/store/shop', (req, res) => {
  res.render('store/shop', {
    layout: 'layouts/store',
    title: 'Shop',
  });
});

router.get('/store/product', (req, res) => {
  res.render('store/single', {
    layout: 'layouts/store',
    title: 'Single Product',
  });
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

router.get('/store/bestseller', (req, res) => {
  res.render('store/bestseller', {
    layout: 'layouts/store',
    title: 'Bestseller',
  });
});

router.get('/store/404', (req, res) => {
  res.status(404).render('store/404', {
    layout: 'layouts/store',
    title: 'Page Not Found',
  });
});

module.exports = router;