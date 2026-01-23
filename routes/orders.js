// routes/orders.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAnySession = require('../middleware/requireAnySession');

// ✅ Orders page (works for BOTH user sessions and business sessions)
// GET /orders
router.get('/orders', requireAnySession, (req, res) => {
  // Flash messages (safe)
  const success = req.flash('success') || [];
  const error = req.flash('error') || [];

  // Optional: expose who is logged in (your EJS can ignore this)
  const user = req.session?.user || null;
  const business = req.session?.business || null;

  return res.render('orders', {
    success,
    error,
    user,
    business,
    // nonce is usually already in res.locals from your CSP middleware,
    // but passing it doesn't hurt.
    nonce: res.locals?.nonce || '',
  });
});

// (Optional) If you ALSO want your other design page reachable:
// GET /orders/list  -> renders views/order-list.ejs
router.get('/orders/list', requireAnySession, (req, res) => {
  const success = req.flash('success') || [];
  const error = req.flash('error') || [];

  const user = req.session?.user || null;
  const business = req.session?.business || null;

  return res.render('order-list', {
    success,
    error,
    user,
    business,
    nonce: res.locals?.nonce || '',
  });
});

module.exports = router;
