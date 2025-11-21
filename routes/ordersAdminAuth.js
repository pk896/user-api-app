// routes/ordersAdminAuth.js
const express = require('express');
const router = express.Router();

// Prefer dedicated env vars for orders admin; fallback to general admin if not provided
const USER = (process.env.ORDERS_ADMIN_USER || process.env.ADMIN_USER || 'Admin')
  .trim()
  .toLowerCase();
const PASS = (process.env.ORDERS_ADMIN_PASS || process.env.ADMIN_PASS || '1988').trim();

router.get('/orders/login', (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
  res.render('admin-login', {
    title: 'Orders Admin Login',
    nonce: res.locals.nonce,
    themeCss,
  });
});

router.post('/orders/login', (req, res) => {
  const u = String(req.body.username || '')
    .trim()
    .toLowerCase();
  const p = String(req.body.password || '').trim();

  if (u === USER && p === PASS) {
    req.session.ordersAdmin = { name: req.body.username || 'Orders Admin' };
    req.flash('success', 'Welcome, Orders Admin!');
    return res.redirect('/admin/orders');
  }

  req.flash('error', '❌ Invalid credentials for Orders Admin.');
  res.redirect('/admin/orders/login');
});

router.get('/orders/logout', (req, res) => {
  if (req.session) {delete req.session.ordersAdmin;}
  req.flash('info', '👋 You have been logged out (Orders Admin).');
  res.redirect('/admin/orders/login');
});

module.exports = router;
