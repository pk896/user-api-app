// routes/admin.js
'use strict';
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');

/* -------------------------------------------
   Optional Models (safe requires)
------------------------------------------- */
let Business = null;
let Order = null;
try { Business = require('../models/Business'); } catch { /* optional */ }
try { Order = require('../models/Order'); } catch { /* optional */ }

/* -------------------------------------------
   Helpers
------------------------------------------- */
function checkMailerConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const from = (process.env.SMTP_FROM || '').trim();
  return Boolean(host && user && pass && from);
}

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

/**
 * Constant-time string compare to reduce timing leaks.
 * (Still rely on bcrypt hash in production for best safety.)
 */
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) {
    // Compare against itself to keep timing similar
    return crypto.timingSafeEqual(aa, aa) && false;
  }
  return crypto.timingSafeEqual(aa, bb);
}

/* -------------------------------------------
   Admin-only login attempt limiter (in-memory)
   (Good basic protection. For multi-instance, use Redis.)
------------------------------------------- */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 8;

const attemptsByKey = new Map();
function adminLoginThrottle(req, res, next) {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const user = String(req.body?.username || '').trim().toLowerCase();
    const key = `${ip}:${user}`;

    const now = Date.now();
    const rec = attemptsByKey.get(key) || { count: 0, firstAt: now };

    // reset window
    if (now - rec.firstAt > ATTEMPT_WINDOW_MS) {
      attemptsByKey.set(key, { count: 0, firstAt: now });
      return next();
    }

    if (rec.count >= MAX_ATTEMPTS) {
      req.flash('error', 'Too many login attempts. Please try again later.');
      return res.redirect('/admin/login');
    }

    req._adminAttemptKey = key;
    req._adminAttemptRec = rec;
    return next();
  } catch {
    return next(); // fail open (don’t block login if limiter breaks)
  }
}

function bumpAttempt(req) {
  const key = req._adminAttemptKey;
  const rec = req._adminAttemptRec;
  if (!key || !rec) return;
  rec.count += 1;
  attemptsByKey.set(key, rec);
}

function clearAttempt(req) {
  const key = req._adminAttemptKey;
  if (!key) return;
  attemptsByKey.delete(key);
}

/* -------------------------------------------
   ✅ /admin -> /admin/dashboard (protected)
------------------------------------------- */
router.get('/', requireAdmin, (req, res) => res.redirect('/admin/dashboard'));

/* -------------------------------------------
   ✅ GET /admin/login
------------------------------------------- */
router.get('/login', (req, res) => {
  const themeCss = themeCssFromSession(req);

  if (req.session?.admin) return res.redirect('/admin/dashboard');

  return res.render('admin-login', {
    title: '🔐 Admin Login',
    formAction: '/admin/login',
    themeCss,
    nonce: res.locals.nonce,
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
    warning: req.flash('warning'),
  });
});

/* -------------------------------------------
   ✅ POST /admin/login (production-ready)
   - supports bcrypt hash (ADMIN_PASS_HASH)
   - constant-time compare for fallback (ADMIN_PASS)
   - session regeneration to prevent fixation
   - simple brute-force throttling
------------------------------------------- */
router.post('/login', adminLoginThrottle, async (req, res) => {
  const usernameInput = String(req.body?.username || '').trim().toLowerCase();
  const passwordInput = String(req.body?.password || '').trim();

  const ADMIN_USER = String(process.env.ADMIN_USER || 'admin').trim().toLowerCase();
  const ADMIN_PASS = String(process.env.ADMIN_PASS || '').trim(); // fallback dev only
  const ADMIN_PASS_HASH = String(process.env.ADMIN_PASS_HASH || '').trim(); // recommended

  try {
    const userOk = usernameInput === ADMIN_USER;

    let passOk = false;
    if (ADMIN_PASS_HASH) {
      // bcrypt hash match
      passOk = await bcrypt.compare(passwordInput, ADMIN_PASS_HASH);
    } else {
      // fallback constant-time compare
      passOk = safeEqual(passwordInput, ADMIN_PASS || ''); // if empty, always fails
    }

    if (!userOk || !passOk) {
      bumpAttempt(req);
      req.flash('error', '❌ Invalid credentials. Please try again.');
      return res.redirect('/admin/login');
    }

    clearAttempt(req);

    // Regenerate session to prevent fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        req.flash('error', 'Session error. Please try again.');
        return res.redirect('/admin/login');
      }

      req.session.admin = {
        name: process.env.ADMIN_USER || 'Admin',
        at: Date.now(),
      };

      req.flash('success', `Welcome back, ${req.session.admin.name}!`);

      req.session.save((err2) => {
        if (err2) console.error('Session save error:', err2);
        return res.redirect('/admin/dashboard');
      });
    });
  } catch (e) {
    console.error('Admin login error:', e);
    bumpAttempt(req);
    req.flash('error', 'Login failed. Please try again.');
    return res.redirect('/admin/login');
  }
});

/* -------------------------------------------
   ✅ GET /admin/dashboard (protected)
------------------------------------------- */
router.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const themeCss = themeCssFromSession(req);
    const mailerOk = checkMailerConfig();

    let pendingBusinessVerifications = undefined;
    let pendingOrders = undefined;

    if (Business) {
      pendingBusinessVerifications = await Business.countDocuments({
        'verification.status': 'pending',
      });
    }

    if (Order) {
      pendingOrders = await Order.countDocuments({
        status: { $in: ['Pending', 'Paid', 'Completed'] },
      }).catch(() => undefined);
    }

    return res.render('admin-dashboard', {
      title: 'Admin Dashboard',
      nonce: res.locals.nonce,
      themeCss,
      admin: req.session.admin,
      mailerOk,
      pendingBusinessVerifications,
      pendingOrders,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ Error loading admin dashboard:', err);
    req.flash('error', '❌ Could not load dashboard data.');
    return res.redirect('/admin/login');
  }
});

/* -------------------------------------------
   ✅ GET /admin/orders (protected)
------------------------------------------- */
router.get('/orders', requireAdmin, (req, res) => {
  try {
    const themeCss = themeCssFromSession(req);

    return res.render('admin/orders-management', {
      title: 'Orders Management',
      nonce: res.locals.nonce,
      themeCss,
      admin: req.session.admin,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
      ppActivityBase: process.env.PP_ACTIVITY_BASE || ''
    });
  } catch (err) {
    console.error('❌ Error loading orders management page:', err);
    req.flash('error', '❌ Could not load orders management page.');
    return res.redirect('/admin/dashboard');
  }
});

/* -------------------------------------------
   ✅ Logout (ONLY one GET + one POST)
------------------------------------------- */
router.post('/logout', requireAdmin, (req, res) => {
  req.flash('info', '👋 You have been logged out successfully.');
  delete req.session.admin;
  req.session.save(() => res.redirect('/admin/login'));
});

// Backwards compatible GET
router.get('/logout', requireAdmin, (req, res) => {
  req.flash('info', '👋 You have been logged out successfully.');
  delete req.session.admin;
  req.session.save(() => res.redirect('/admin/login'));
});

module.exports = router;
