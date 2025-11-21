// routes/ordersAdmin.js
const express = require('express');
const router = express.Router();
const requireOrdersAdmin = require('../middleware/requireOrdersAdmin');

const {
  PAYPAL_MODE = 'sandbox',
  ORDERS_ADMIN_PASS = 'admin1234', // ⚠️ set a real secret in .env for prod
} = process.env;

const PP_ACTIVITY_BASE =
  PAYPAL_MODE === 'live'
    ? 'https://www.paypal.com/activity/payment/'
    : 'https://www.sandbox.paypal.com/activity/payment/';

/**
 * Mounted in server.js as: app.use("/admin", adminOrdersRoutes)
 * URLs:
 *   GET  /admin/orders/login
 *   POST /admin/orders/login
 *   GET  /admin/orders/logout
 *   GET  /admin/orders            (protected)
 */

// Login page (no gate)
router.get('/orders/login', (req, res) => {
  res.render('orders-admin-login', {
    title: 'Orders Admin Login',
    nonce: res.locals.nonce,
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

// Handle login (no gate)
router.post('/orders/login', express.urlencoded({ extended: true }), (req, res) => {
  const pass = String(req.body?.pass || '');
  if (!pass || pass !== ORDERS_ADMIN_PASS) {
    req.flash('error', 'Invalid admin password.');
    return res.redirect('/admin/orders/login');
  }
  if (req.session) {req.session.ordersAdmin = true;}
  req.flash('success', 'Welcome, Orders Admin.');
  const next = req.query.next || '/admin/delivery-options';
  return res.redirect(next);
});

// Logout (no gate)
router.get('/orders/logout', (req, res) => {
  if (req.session) {req.session.ordersAdmin = false;}
  req.flash('success', 'Logged out.');
  return res.redirect('/admin/orders/login');
});

// Orders page (protected)
router.get('/orders', requireOrdersAdmin, async (req, res) => {
  try {
    res.render('orders-admin', {
      title: 'Orders (Admin)',
      nonce: res.locals.nonce,
      themeCss: res.locals.themeCss,
      paypalMode: PAYPAL_MODE,
      ppActivityBase: PP_ACTIVITY_BASE,
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error('❌ Render /admin/orders error:', err);
    req.flash('error', 'Failed to load Orders page.');
    res.redirect('/admin/orders/login');
  }
});

module.exports = router;
