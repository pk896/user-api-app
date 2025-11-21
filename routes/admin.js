// routes/admin.js
const express = require('express');
const router = express.Router();
const requireAdmin = require('../middleware/requireAdmin');

/* -------------------------------------------
   Helpers
------------------------------------------- */
function checkMailerConfig() {
  // Lightweight “is mailer configured?” check — no send, just env presence
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const from = (process.env.SMTP_FROM || '').trim();
  return Boolean(host && user && pass && from);
}

/* -------------------------------------------
   Login page (reuses admin-login.ejs)
------------------------------------------- */
router.get('/login', (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
  if (req.session.admin) {return res.redirect('/admin/dashboard');}
  res.render('admin-login', {
    title: '🔐 Admin Login',
    formAction: '/admin/login',
    themeCss,
    nonce: res.locals.nonce,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

/* -------------------------------------------
   POST login (env-based)
------------------------------------------- */
router.post('/login', (req, res) => {
  const usernameInput = (req.body.username || '').trim().toLowerCase();
  const passwordInput = (req.body.password || '').trim();
  const ADMIN_USER = (process.env.ADMIN_USER || 'admin').trim().toLowerCase();
  const ADMIN_PASS = (process.env.ADMIN_PASS || '12345').trim();

  if (usernameInput === ADMIN_USER && passwordInput === ADMIN_PASS) {
    req.session.admin = { name: process.env.ADMIN_USER || 'Admin' };
    req.flash('success', `Welcome back, ${req.session.admin.name}!`);
    return res.redirect('/admin/dashboard');
  }
  req.flash('error', '❌ Invalid credentials. Please try again.');
  res.redirect('/admin/login');
});

/* -------------------------------------------
   Dashboard (protected)
   - All message logic removed.
   - Exposes mailerOk for your pill.
------------------------------------------- */
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';

    // Minimal, message-free model:
    const mailerOk = checkMailerConfig();

    // Optional: keep a neutral stats object so views don’t break
    const stats = {
      // add other non-message stats later if you want
    };

    res.render('dashboards/admin-dashboard', {
      title: 'Admin Dashboard',
      nonce: res.locals.nonce,
      themeCss,
      admin: req.session.admin,
      stats,
      mailerOk, // <-- for your “Mail: OK/OFF” pill
      recentMessages: [], // <-- explicitly empty; no messages logic anymore
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error('❌ Error loading admin dashboard:', err);
    req.flash('error', '❌ Could not load dashboard data.');
    res.redirect('/admin/login');
  }
});

/* -------------------------------------------
   Orders page (protected)
------------------------------------------- */
router.get('/orders', requireAdmin, (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
  const mode = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  const ppActivityBase =
    mode === 'live'
      ? 'https://www.paypal.com/activity/payment/'
      : 'https://www.sandbox.paypal.com/activity/payment/';

  res.render('orders-admin', {
    title: 'Orders (Admin)',
    nonce: res.locals.nonce,
    themeCss,
    ppActivityBase,
  });
});

/* -------------------------------------------
   Logout
------------------------------------------- */
router.get('/logout', (req, res) => {
  try {
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      req.flash('info', '👋 You have been logged out successfully.');
      res.redirect('/admin/login');
    });
  } catch (err) {
    console.error('❌ Error logging out admin:', err);
    req.flash('error', '⚠️ Logout failed. Please try again.');
    res.redirect('/admin/dashboard');
  }
});

module.exports = router;
