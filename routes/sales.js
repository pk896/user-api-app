// routes/sales.js
'use strict';
const express = require('express');
const Product = require('../models/Product');
const router = express.Router();

/* ---------------------------------------------
 * 🛍️ GET: Sales Product Page
 * ------------------------------------------- */
router.get('/', async (req, res) => {
  // <-- changed from "/sales" to "/"
  try {
    const products = await Product.find().sort({ createdAt: -1 }).lean();

    const user = req.user || null;
    const business = req.session.business || null;

    res.render('sales-products', {
      title: 'Shop Products',
      products,
      user,
      business,
      themeCss: res.locals.themeCss,
      success: req.flash('success'),
      error: req.flash('error'),
      nonce: res.locals.nonce,
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ Failed to load products:', err);
    req.flash('error', 'Failed to load products.');
    res.redirect('/');
  }
});

module.exports = router;