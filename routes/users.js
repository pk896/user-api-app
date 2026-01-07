// routes/users.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const crypto = require('crypto');

const User = require('../models/User');
const Order = require('../models/Order');
const { sendMail, _FROM } = require('../utils/mailer');
const ResetToken = require('../models/ResetToken');


// Optional wishlist model (if you have it)
let Wishlist = null;
try {
  Wishlist = require('../models/Wishlist');
} catch {
  /* Wishlist is optional */
}

/* -----------------------------------------------------
   Small helpers so renders never crash even if your EJS
   doesn't reference these
----------------------------------------------------- */
function pageStyles() {
  return '';
}
function pageScripts() {
  return '';
}

/* -----------------------------------------------------
   Gate: requires a logged-in user
----------------------------------------------------- */
function ensureUser(req, res, next) {
  if (req.session && req.session.user) {
    return next();
  }
  if (req.session && !req.session.returnTo) {
    req.session.returnTo = req.originalUrl;
  }
  req.flash('error', 'Please log in.');
  return res.redirect('/users/login');
}

/* -----------------------------------------------------
   Gate: requires logged-in AND verified email
----------------------------------------------------- */
function ensureVerifiedUser(req, res, next) {
  if (req.session && req.session.user) {
    if (req.session.user.isEmailVerified) {
      return next();
    }
    // Logged in but not verified
    if (!req.session.returnTo) {
      req.session.returnTo = req.originalUrl;
    }
    req.flash('error', 'Please verify your email before accessing this page.');
    return res.redirect('/users/verify-pending');
  }

  // Not logged in
  if (req.session && !req.session.returnTo) {
    req.session.returnTo = req.originalUrl;
  }
  req.flash('error', 'Please log in.');
  return res.redirect('/users/login');
}

/* -----------------------------------------------------
   Helper: put user into session safely
   - preserves any logged-in business
   - supports longer session for "remember me"
----------------------------------------------------- */
function loginUserIntoSession(req, userDoc, remember, cb) {
  const keepBusiness = req.session.business || null;

  req.session.regenerate((err) => {
    if (err) {
      return cb(err);
    }

    if (keepBusiness) {
      req.session.business = keepBusiness;
    }

    req.session.user = {
      _id: userDoc._id.toString(),
      name: userDoc.name,
      email: userDoc.email,
      createdAt: userDoc.createdAt,
      provider: userDoc.provider || 'local',
      isEmailVerified: !!userDoc.isEmailVerified,
    };

    if (remember) {
      req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
    } else {
      req.session.cookie.expires = false;
    }

    cb(null);
  });
}

function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return email;
  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];
  const [domName, domExt] = domain.split('.');
  const maskedDomain =
    domName[0] + '*'.repeat(Math.max(1, domName.length - 2)) + domName[domName.length - 1];
  return `${maskedName}@${maskedDomain}.${domExt || ''}`;
}

/* =======================================================
   AUTH PAGES
======================================================= */

// GET /users/signup
router.get('/signup', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-signup', {
    title: 'User Sign Up',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

// POST /users/signup (LOCAL: real email + username + password)
router.post('/signup', async (req, res) => {
  try {
    const { name, email, username, password, confirm, age, confirm16 } = req.body || {};

    if (
      !name ||
      !email ||
      !username ||
      !password ||
      !confirm ||
      typeof age === 'undefined'
    ) {
      req.flash('error', 'All fields are required.');
      return res.redirect('/users/signup');
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).toLowerCase().trim();
    const cleanUsername = String(username).trim();
    const pass = String(password);
    const conf = String(confirm);

    if (cleanName.length < 2 || cleanName.length > 80) {
      req.flash('error', 'Please enter your full name (2–80 chars).');
      return res.redirect('/users/signup');
    }

    // Email must be a real email (Gmail, Outlook, etc.)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      req.flash('error', 'Please enter a valid email address.');
      return res.redirect('/users/signup');
    }

    // Username validation (simple rules)
    if (cleanUsername.length < 3 || cleanUsername.length > 30) {
      req.flash('error', 'Username must be between 3 and 30 characters.');
      return res.redirect('/users/signup');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(cleanUsername)) {
      req.flash(
        'error',
        'Username can only contain letters, numbers, dots, underscores, and dashes.',
      );
      return res.redirect('/users/signup');
    }

    if (pass.length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect('/users/signup');
    }
    if (pass !== conf) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/users/signup');
    }

    const nAge = Number(age);
    if (!Number.isInteger(nAge) || nAge < 16 || nAge > 120) {
      req.flash(
        'error',
        'You must be at least 16 years old (valid whole number between 16-120).',
      );
      return res.redirect('/users/signup');
    }
    if (!confirm16) {
      req.flash('error', 'Please confirm that you are at least 16 years old.');
      return res.redirect('/users/signup');
    }

    // Check for existing user by email OR username
    const existing = await User.findOne({
      $or: [{ email: cleanEmail }, { username: cleanUsername }],
    }).lean();

    if (existing) {
      if (existing.email === cleanEmail) {
        // If the existing account is Google-only, nudge them to use Google
        if (existing.provider === 'google' && !existing.passwordHash) {
          req.flash(
            'error',
            'This email is already registered with Google sign-in. Please log in with Google.',
          );
        } else {
          req.flash(
            'error',
            'Email already registered. You can log in or use Google.',
          );
        }
        return res.redirect('/users/signup');
      }
      if (existing.username === cleanUsername) {
        req.flash('error', 'That username is already taken. Please choose another one.');
        return res.redirect('/users/signup');
      }
    }

    const passwordHash = await bcrypt.hash(pass, 12);

    // Prepare email verification token (for Gmail/Outlook verification)
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const user = await User.create({
      name: cleanName,
      email: cleanEmail,
      username: cleanUsername,
      age: nAge,
      passwordHash,
      provider: 'local',
      googleId: null,
      providerId: null,
      isEmailVerified: false, // will be flipped when they verify via email
      emailVerificationToken,
      emailVerificationExpires,
    });

    // 🔐 Build verify link
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const verifyUrl = `${appUrl}/users/verify-email?token=${encodeURIComponent(
      emailVerificationToken,
    )}`;

    // ✉️ Send verification email (using your mailer)
    try {
      const subject = 'Verify your Phakisi Global account';
      const text = [
        `Hi ${cleanName || 'there'},`,
        '',
        'Thank you for creating a Phakisi Global account.',
        'Please confirm that this is your real email address by opening the link below:',
        '',
        verifyUrl,
        '',
        'This link will expire in 24 hours.',
        '',
        'If you did not create this account, you can ignore this email.',
      ].join('\n');

      const html = `
        <p>Hi ${cleanName || 'there'},</p>
        <p>Thank you for creating a <strong>Phakisi Global</strong> account.</p>
        <p>Please confirm that this is your real email address by clicking the button below:</p>
        <p style="margin:16px 0;">
          <a href="${verifyUrl}"
             style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;
                    text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
            Verify my email
          </a>
        </p>
        <p style="font-size:12px;color:#6b7280;">
          Or copy and paste this link into your browser:<br>
          <span style="word-break:break-all;">${verifyUrl}</span>
        </p>
        <p style="font-size:12px;color:#6b7280;">
          This link will expire in 24 hours. If you did not create this account, you can ignore this email.
        </p>
      `;

      await sendMail({
        to: cleanEmail,
        subject,
        text,
        html,
      });
    } catch (mailErr) {
      console.error('[POST /users/signup] Failed to send verification email:', mailErr);
      // We don’t block signup if email fails, but we can warn the user later if you want
    }

    // Put user in session (prevent session fixation)
    loginUserIntoSession(req, user, false, (err) => {
      if (err) {
        console.error('[POST /users/signup] session regenerate failed:', err);
        req.flash('error', 'Registration succeeded, but session failed. Please log in.');
        return res.redirect('/users/login');
      }
      req.flash(
        'success',
        'Welcome! Your account has been created. Please check your email to verify it.',
      );
      return res.redirect('/users/verify-pending');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      req.flash('error', 'Email or username already registered.');
      return res.redirect('/users/signup');
    }
    console.error('Signup error:', err);
    req.flash('error', 'Registration failed.');
    return res.redirect('/users/signup');
  }
});

// GET /users/login
router.get('/login', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-login', {
    title: 'User Login',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

// POST /users/login (LOCAL: username (but still supports email under the hood))
router.post('/login', async (req, res) => {
  try {
    const { loginId, password, remember } = req.body || {};
    const rawLogin = String(loginId || '').trim();
    const pass = String(password || '');

    if (!rawLogin || !pass) {
      console.warn('[LOGIN] missing creds', { rawLogin, passLen: pass.length });
      req.flash('error', 'Username and password are required.');
      return res.redirect('/users/login');
    }

    const isEmailFormat = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawLogin);
    const lookup = isEmailFormat
      ? { email: rawLogin.toLowerCase() } // still supports login by email if someone tries
      : {
          $or: [
            { username: rawLogin },
            { email: rawLogin.toLowerCase() }, // extra safety
          ],
        };

    const user = await User.findOne(lookup);
    if (!user) {
      console.warn('[LOGIN] user not found:', rawLogin);
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    // If this is a Google-only account (no password), redirect to Google login
    if (user.provider === 'google' && !user.passwordHash) {
      console.warn('[LOGIN] Google-only account tried local login:', user._id.toString());
      req.flash(
        'error',
        'This account uses Google sign-in. Please sign in with Google.',
      );
      return res.redirect('/users/login');
    }

    if (!user.passwordHash || typeof user.passwordHash !== 'string') {
      console.warn('[LOGIN] missing passwordHash on user:', user._id.toString());
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    const ok = await bcrypt.compare(pass, user.passwordHash);
    if (!ok) {
      console.warn('[LOGIN] bcrypt compare failed for:', user._id.toString());
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    // Track lastLogin for professionalism
    user.lastLogin = new Date();
    await user.save();

        loginUserIntoSession(req, user, !!remember, (err) => {
      if (err) {
        console.error('[LOGIN] regenerate err', err);
        req.flash('error', 'Login failed.');
        return res.redirect('/users/login');
      }

      // If email is not verified, always push them to verify page
      let redirectTo = req.session.returnTo || '/users/dashboard';
      delete req.session.returnTo;

      if (!user.isEmailVerified) {
        redirectTo = '/users/verify-pending';
      }

      console.log('[LOGIN] OK ->', redirectTo);
      req.flash(
        'success',
        user.isEmailVerified
          ? 'Logged in successfully.'
          : 'Logged in. Please verify your email to unlock all features.',
      );
      return res.redirect(redirectTo);
    });

  } catch (err) {
    console.error('[LOGIN] error', err);
    req.flash('error', 'Login failed.');
    return res.redirect('/users/login');
  }
});

/* =======================================================
   EMAIL VERIFICATION
======================================================= */

// GET /users/verify-email?token=abc123
router.get('/verify-email', async (req, res) => {
  try {
    const token = String((req.query && req.query.token) || '').trim();

    if (!token) {
      req.flash('error', 'Verification link is invalid or missing.');
      return res.redirect('/users/profile');
    }

    const now = new Date();

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: now },
    });

    if (!user) {
      req.flash(
        'error',
        'This verification link is invalid or has expired. Please request a new one.',
      );
      return res.redirect('/users/profile');
    }

    // Mark verified using model helper (if present)
    if (typeof user.markEmailVerified === 'function') {
      user.markEmailVerified();
    } else {
      user.isEmailVerified = true;
      user.emailVerificationToken = null;
      user.emailVerificationExpires = null;
    }

    await user.save();

    // If this user is currently in session, update session info too
    if (req.session && req.session.user && req.session.user._id === user._id.toString()) {
      req.session.user.isEmailVerified = true;
    }

    req.flash('success', 'Your email has been verified. Thank you!');
    return res.redirect('/users/dashboard');
  } catch (err) {
    console.error('[GET /users/verify-email] error:', err);
    req.flash('error', 'Could not verify your email. Please try again.');
    return res.redirect('/users/profile');
  }
});

// GET /users/logout
router.get('/logout', (req, res) => {
  const keepBusiness = req.session?.business || null;
  req.session.regenerate((err) => {
    if (err) {
      console.error('[GET /users/logout] regenerate err', err);
      if (req.session) {
        req.session.user = null;
      }
      req.flash('success', 'Logged out.');
      return res.redirect('/users/login');
    }
    if (keepBusiness) {
      req.session.business = keepBusiness;
    }
    req.flash('success', 'Logged out.');
    res.redirect('/users/login');
  });
});

/* =======================================================
   VERIFY PENDING PAGE
======================================================= */

// GET /users/verify-pending
router.get('/verify-pending', ensureUser, (req, res) => {
  const { nonce = '' } = res.locals;
  const docUser = req.session.user || null;

  res.render('users-verify-pending', {
    title: 'Verify your email',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: docUser,
    business: req.session.business || null,
  });
});

/* =======================================================
   RESEND VERIFICATION EMAIL (logged-in user)
======================================================= */

// POST /users/verify-email/resend
router.post('/verify-email/resend', ensureUser, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const user = await User.findById(uid);

    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/users/verify-pending');
    }

    if (user.isEmailVerified) {
      req.flash('success', 'Your email is already verified.');
      return res.redirect('/users/dashboard');
    }

    // Generate new token + expiry
    const emailVerificationToken = crypto.randomBytes(32).toString('hex');
    const emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    user.emailVerificationToken = emailVerificationToken;
    user.emailVerificationExpires = emailVerificationExpires;
    await user.save();

    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    const verifyUrl = `${appUrl}/users/verify-email?token=${encodeURIComponent(
      emailVerificationToken,
    )}`;

    const subject = 'Verify your Phakisi Global account';
    const text = [
      `Hi ${user.name || 'there'},`,
      '',
      'Please confirm that this is your real email address by opening the link below:',
      '',
      verifyUrl,
      '',
      'This link will expire in 24 hours.',
    ].join('\n');

    const html = `
      <p>Hi ${user.name || 'there'},</p>
      <p>Please confirm that this is your real email address by clicking the button below:</p>
      <p style="margin:16px 0;">
        <a href="${verifyUrl}"
           style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;
                  text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
          Verify my email
        </a>
      </p>
      <p style="font-size:12px;color:#6b7280;">
        Or copy and paste this link into your browser:<br>
        <span style="word-break:break-all;">${verifyUrl}</span>
      </p>
      <p style="font-size:12px;color:#6b7280;">
        This link will expire in 24 hours. If you did not request this, you can ignore this email.
      </p>
    `;

    await sendMail({
      to: user.email,
      subject,
      text,
      html,
    });

    req.flash('success', 'A new verification email has been sent.');
    return res.redirect('/users/verify-pending');
  } catch (err) {
    console.error('[POST /users/verify-email/resend] error:', err);
    req.flash('error', 'Failed to resend verification email. Please try again later.');
    return res.redirect('/users/verify-pending');
  }
});

/* =======================================================
   PROFILE
======================================================= */
router.get('/profile', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const doc = await User.findById(req.session.user._id).lean();
  const user = doc ? { ...doc, _id: doc._id.toString() } : req.session.user;

  res.render('users-profile', {
    title: 'My Profile',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user,
    business: req.session.business || null,
  });
});

/* =======================================================
   DASHBOARD
======================================================= */
router.get('/dashboard', ensureVerifiedUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  try {
    const PAID_STATES = ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

    // Get orders with shippingTracking data
    const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).limit(10).lean();
    
    // Extract shipments from orders that have tracking info
    const shipments = orders
      .filter(order => order.shippingTracking && order.shippingTracking.trackingNumber)
      .map(order => ({
        orderId: order._id,
        status: order.shippingTracking.status || 'PENDING',
        carrier: order.shippingTracking.carrierLabel || order.shippingTracking.carrier,
        trackingNumber: order.shippingTracking.trackingNumber,
        trackingUrl: order.shippingTracking.trackingUrl,
        updatedAt: order.shippingTracking.lastTrackingUpdate || order.updatedAt || order.createdAt,
        shippedAt: order.shippingTracking.shippedAt,
        deliveredAt: order.shippingTracking.deliveredAt,
        // For convenience, include the order status too
        orderStatus: order.status
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .slice(0, 5); // Limit to 5 most recent

    // Get wishlist items if available
    let wishlistItems = [];
    if (Wishlist) {
      try {
        wishlistItems = await Wishlist.find({ userId: uid }).lean();
      } catch (wishlistErr) {
        console.error('Wishlist fetch error:', wishlistErr);
      }
    }

    // Calculate metrics from the orders array
    const totalOrders = orders.length;
    const paidOrders = orders.filter(order => 
      PAID_STATES.includes(order.status)
    ).length;

    // Calculate total spent
    const totalSpent = orders.reduce((sum, order) => {
      try {
        let amountValue = 0;
        
        if (order.breakdown?.grandTotal) {
          amountValue = Number(order.breakdown.grandTotal);
        }
        else if (order.amount?.value) {
          amountValue = Number(order.amount.value);
        }
        else if (order.breakdown) {
          const itemTotal = Number(order.breakdown.itemTotal?.value || order.breakdown.subTotal || 0);
          const taxTotal = Number(order.breakdown.taxTotal?.value || order.breakdown.vatTotal || 0);
          const shipping = Number(order.breakdown.shipping?.value || order.breakdown.delivery || 0);
          amountValue = itemTotal + taxTotal + shipping;
        }
        else if (order.purchase_units?.[0]?.amount?.value) {
          amountValue = Number(order.purchase_units[0].amount.value);
        }
        
        return sum + amountValue;
      } catch (error) {
        console.error(`Error calculating amount for order ${order._id}:`, error);
        return sum;
      }
    }, 0);

    // Render with the professional template
    res.render('dashboards/users-dashboard', {
      title: 'Dashboard',
      active: 'dashboard',
      styles: pageStyles(nonce),
      scripts: pageScripts(nonce),
      user: req.session.user,
      business: req.session.business || null,
      orders: orders,
      shipments: shipments,
      wishlistItems: wishlistItems,
      kpis: { 
        totalOrders, 
        paidOrders, 
        totalSpent 
      },
      // Flash messages if any
      success: req.flash('success'),
      error: req.flash('error')
    });

  } catch (error) {
    console.error('Dashboard error:', error);
    req.flash('error', 'Unable to load dashboard. Please try again.');
    res.redirect('/users/profile');
  }
});

/* =======================================================
   ORDERS LIST + SHIPMENT SNAPSHOT
======================================================= */
router.get('/orders', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).lean();
  const _orderIds = orders.map((o) => o._id);

  res.render('users-orders', {
    title: 'My Orders',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    orders,
  });
});

/* =======================================================
   ORDER DETAIL + SHIPMENT DETAIL
======================================================= */
router.get('/orders/:id', ensureVerifiedUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const order = await Order.findOne({ _id: req.params.id, userId: uid }).lean();
  if (!order) {
    req.flash('error', 'Order not found.');
    return res.redirect('/users/orders');
  }

  // Check if there's shipping tracking data
  const hasShipment = !!(order.shippingTracking && order.shippingTracking.trackingNumber);

  res.render('users-order-detail', {
    title: `Order #${order._id.toString().slice(-6)}`,
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    order,
    hasShipment, // Pass this flag to the template
    // You could also pass shippingTracking separately if you want, but the template can access it from order
  });
});

/* =======================================================
   ORDER DETAIL BY orderId (used by Shipments list)
======================================================= */
router.get('/orders/by-order-id/:orderId', ensureVerifiedUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;
  const { orderId } = req.params;

  let order = null;

  order = await Order.findOne({ orderId, userId: uid }).lean();
  if (!order && mongoose.Types.ObjectId.isValid(orderId)) {
    order = await Order.findOne({ _id: orderId, userId: uid }).lean();
  }

  if (!order) {
    req.flash('error', 'Order not found.');
    return res.redirect('/users/orders');
  }

  res.render('users-order-detail', {
    title: `Order #${order._id.toString().slice(-6)}`,
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    order,
    hasShipment: !!(order.shippingTracking && order.shippingTracking.trackingNumber),
  });
});

/* =======================================================
   PAYMENTS (derived from Orders)
======================================================= */
router.get('/payments', ensureVerifiedUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).lean();

  const payments = [];
  for (const o of orders) {
    if (!o) continue;

    const addCapture = (c) => {
      if (!c) return;
      const rawValue =
        (c.amount && (c.amount.value || c.amount.total)) ||
        c.amount ||
        (o.amount && (o.amount.total || o.amount.value)) ||
        o.total ||
        0;
      const currency =
        (c.amount && (c.amount.currency_code || c.amount.currency)) ||
        (o.amount && (o.amount.currency_code || o.amount.currency)) ||
        o.currency ||
        'USD';
      const valueNum = Number(rawValue) || 0;

      payments.push({
        orderId: o._id,
        captureId: c.id || c.capture_id || null,
        provider: 'PayPal',
        amount: { value: valueNum.toFixed(2), currency },
        status: c.status || o.status || 'PAID',
        createdAt: c.create_time ? new Date(c.create_time) : o.createdAt,
        updateTime: c.update_time ? new Date(c.update_time) : o.updatedAt || o.createdAt,
      });
    };

    if (Array.isArray(o?.captures)) {
      o.captures.forEach(addCapture);
    } else if (o?.payment && Array.isArray(o.payment.captures)) {
      o.payment.captures.forEach(addCapture);
    } else if (o?.paypalCaptureId) {
      const rawValue =
        (o.amount && (o.amount.total || o.amount.value)) ||
        o.total ||
        0;
      const currency =
        (o.amount && (o.amount.currency_code || o.amount.currency)) ||
        o.currency ||
        'USD';
      const valueNum = Number(rawValue) || 0;

      payments.push({
        orderId: o._id,
        captureId: o.paypalCaptureId,
        provider: 'PayPal',
        amount: { value: valueNum.toFixed(2), currency },
        status: o.status || 'PAID',
        createdAt: o.createdAt,
        updateTime: o.updatedAt || o.createdAt,
      });
    }
  }

  payments.sort((a, b) => {
    const ad = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bd = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bd - ad;
  });

  res.render('users-payments', {
    title: 'My Payments',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    payments,
  });
});

/* =======================================================
   FORGOT PASSWORD (REQUEST RESET LINK)
======================================================= */

// GET /users/password/forgot
router.get('/password/forgot', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-forgot', {
    title: 'Forgot Password',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
    messages: req.flash(), // Add this line
  });
});

// POST /users/password/forgot
router.post('/password/forgot', async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || '';
    const email = String(rawEmail).trim().toLowerCase();

    if (!email) {
      req.flash('error', 'Please enter your email address.');
      return res.redirect('/users/password/forgot');
    }

    const user = await User.findOne({ email });
    const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

    if (user) {
      // Remove old tokens for this user
      await ResetToken.deleteMany({ userId: user._id });

      // Create new token valid for 1 hour
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await ResetToken.create({
        userId: user._id,
        token,        // store the SAME token we send in the email
        expiresAt,
      });

      const resetUrl = `${appUrl}/users/password/reset/${encodeURIComponent(token)}`;

      const subject = 'Reset your Unicoporate.com password';
      const text = [
        `Hi ${user.name || 'there'},`,
        '',
        'We received a request to reset the password for your account.',
        'If you made this request, open the link below to set a new password:',
        '',
        resetUrl,
        '',
        'This link will expire in 1 hour.',
        'If you did not request a password reset, you can safely ignore this email.',
      ].join('\n');

      const html = `
        <p>Hi ${user.name || 'there'},</p>
        <p>We received a request to reset the password for your <strong>Unicoporate.com</strong> account.</p>
        <p>If you made this request, click the button below to set a new password:</p>
        <p style="margin:16px 0;">
          <a href="${resetUrl}"
             style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;
                    text-decoration:none;border-radius:6px;font-weight:600;font-size:14px;">
            Reset my password
          </a>
        </p>
        <p style="font-size:12px;color:#6b7280;">
          Or copy and paste this link into your browser:<br>
          <span style="word-break:break-all;">${resetUrl}</span>
        </p>
        <p style="font-size:12px;color:#6b7280;">
          This link will expire in 1 hour. If you did not request a password reset, you can ignore this email.
        </p>
      `;

      await sendMail({
        to: user.email,
        subject,
        text,
        html,
      });
    }

    // Always show the "check your email" screen, even if user not found
    const { nonce = '' } = res.locals;
    return res.render('users-forgot-sent', {
      title: 'Check your email',
      active: 'users',
      styles: pageStyles(nonce),
      scripts: pageScripts(nonce),
      maskedEmail: maskEmail(email),
      user: req.session.user || null,
      business: req.session.business || null,
    });
  } catch (err) {
    console.error('[POST /users/password/forgot] error:', err);
    req.flash('error', 'Could not send reset link. Please try again.');
    return res.redirect('/users/password/forgot');
  }
});

/* =======================================================
   RESET PASSWORD USING TOKEN
======================================================= */

// GET /users/password/reset/:token  -> show "set new password" form
router.get('/password/reset/:token', async (req, res) => {
  const { nonce = '' } = res.locals;
  const token = String(req.params.token || '').trim();

  if (!token) {
    req.flash('error', 'Reset link is invalid or expired.');
    return res.redirect('/users/password/forgot');
  }

  const now = new Date();

  const resetDoc = await ResetToken.findOne({
    token,
    expiresAt: { $gt: now },
  });

  if (!resetDoc) {
    req.flash('error', 'Reset link is invalid or expired.');
    return res.redirect('/users/password/forgot');
  }

  res.render('users-reset', {
    title: 'Set a new password',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    token, // used in form action /users/password/reset/<%= token %>
    user: null,
    business: req.session.business || null,
  });
});

// POST /users/password/reset/:token  -> actually change password
router.post('/password/reset/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { password, confirm } = req.body || {};

    if (!password || !confirm) {
      req.flash('error', 'Please fill in both password fields.');
      return res.redirect(`/users/password/reset/${encodeURIComponent(token)}`);
    }
    if (password !== confirm) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect(`/users/password/reset/${encodeURIComponent(token)}`);
    }
    if (String(password).length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect(`/users/password/reset/${encodeURIComponent(token)}`);
    }

    const now = new Date();
    const resetDoc = await ResetToken.findOne({
      token,
      expiresAt: { $gt: now },
    });

    if (!resetDoc) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/users/password/forgot');
    }

    const user = await User.findById(resetDoc.userId);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/users/password/forgot');
    }

    // Update password
    user.passwordHash = await bcrypt.hash(String(password).trim(), 12);
    if (!user.provider || user.provider === 'google') {
      user.provider = 'both'; // or 'local'
    }
    await user.save();

    // Clean up tokens for this user
    await ResetToken.deleteMany({ userId: user._id });

    req.flash('success', 'Your password has been reset. You can now log in.');
    return res.redirect('/users/login');
  } catch (err) {
    console.error('[POST /users/password/reset/:token] error:', err);
    req.flash('error', 'Could not reset password. Please try again.');
    return res.redirect('/users/password/forgot');
  }
});

/* =======================================================
   CHANGE PASSWORD (while logged in)
======================================================= */
router.get('/change-password', ensureUser, (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-change-password', {
    title: 'Change Password',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
  });
});

router.post('/change-password', ensureUser, async (req, res) => {
  try {
    const { current, next, confirm } = req.body || {};
    if (!current || !next || !confirm) {
      req.flash('error', 'All fields are required.');
      return res.redirect('/users/change-password');
    }
    if (next !== confirm) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/users/change-password');
    }

    const user = await User.findById(req.session.user._id);
    if (!user) {
      req.flash('error', 'User not found.');
      return res.redirect('/users/change-password');
    }

    // If user is Google-only with no password, block this
    if (user.provider === 'google' && !user.passwordHash) {
      req.flash(
        'error',
        'This account uses Google sign in. You cannot change a password here.',
      );
      return res.redirect('/users/change-password');
    }

    if (!user.passwordHash || typeof user.passwordHash !== 'string') {
      req.flash('error', 'User has no password configured.');
      return res.redirect('/users/change-password');
    }

    const ok = await bcrypt.compare(String(current), user.passwordHash);
    if (!ok) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/users/change-password');
    }

    user.passwordHash = await bcrypt.hash(String(next).trim(), 12);
    // If they previously were Google-only, flipping provider to local or both is valid
    if (user.provider === 'google') {
      user.provider = 'both';
    }
    await user.save();

    req.flash('success', 'Password updated.');
    res.redirect('/users/profile');
  } catch (err) {
    console.error('Change password error:', err);
    req.flash('error', 'Failed to change password.');
    res.redirect('/users/change-password');
  }
});

/* =======================================================
   EDIT PROFILE
======================================================= */

// GET /users/profile/edit
router.get('/profile/edit', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const doc = await User.findById(req.session.user._id).lean();
  const user = doc ? { ...doc, _id: doc._id.toString() } : req.session.user;

  return res.render('users-profile-edit', {
    title: 'Edit Profile',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user,
    business: req.session.business || null,
  });
});

// POST /users/profile/edit
router.post('/profile/edit', ensureUser, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const { name, username, age, password } = req.body || {};

    const cleanName = String(name || '').trim();
    const cleanUsername = String(username || '').trim();

    if (!cleanName || cleanName.length < 2) {
      req.flash('error', 'Please enter your full name (min 2 characters).');
      return res.redirect('/users/profile/edit');
    }

    const updates = { name: cleanName };

    // Username: allow editing, but must be unique and valid if provided
    if (!cleanUsername || cleanUsername.length < 3 || cleanUsername.length > 30) {
      req.flash('error', 'Username must be between 3 and 30 characters.');
      return res.redirect('/users/profile/edit');
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(cleanUsername)) {
      req.flash(
        'error',
        'Username can only contain letters, numbers, dots, underscores, and dashes.',
      );
      return res.redirect('/users/profile/edit');
    }

    // Check if another user already has this username
    const existingUserWithUsername = await User.findOne({
      _id: { $ne: uid },
      username: cleanUsername,
    }).lean();

    if (existingUserWithUsername) {
      req.flash('error', 'That username is already taken. Please choose another one.');
      return res.redirect('/users/profile/edit');
    }

    updates.username = cleanUsername;

    // Age – optional
    if (typeof age !== 'undefined' && age !== null && String(age).trim() !== '') {
      const nAge = Number(age);
      if (Number.isNaN(nAge) || nAge < 0 || nAge > 120) {
        req.flash('error', 'Please enter a valid age.');
        return res.redirect('/users/profile/edit');
      }
      updates.age = nAge;
    } else {
      updates.$unset = { ...(updates.$unset || {}), age: '' };
    }

    // Optional: allow user to set or change password (local login)
    if (password && String(password).trim().length > 0) {
      const newPass = String(password).trim();
      if (newPass.length < 6) {
        req.flash('error', 'New password must be at least 6 characters.');
        return res.redirect('/users/profile/edit');
      }
      const newHash = await bcrypt.hash(newPass, 12);
      updates.passwordHash = newHash;
      // If they add a password, ensure provider is at least local
      if (!updates.provider) {
        updates.provider = 'local';
      }
    }

    const updated = await User.findByIdAndUpdate(uid, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (updated) {
      req.session.user.name = updated.name;
      if (updated.email) { req.session.user.email = updated.email; }
      if (updated.username) { req.session.user.username = updated.username; }
    }

    req.flash('success', 'Profile updated.');
    return res.redirect('/users/profile');
  } catch (err) {
    console.error('Profile update error:', err);
    req.flash('error', 'Failed to update profile.');
    return res.redirect('/users/profile/edit');
  }
});

/* =======================================================
   DELETE ACCOUNT
======================================================= */
router.post('/profile/delete', ensureUser, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const keepBusiness = req.session.business || null;

    await User.findByIdAndDelete(uid);

    req.session.regenerate((err) => {
      if (err) {
        console.error('[POST /users/profile/delete] session regenerate err', err);
        if (req.session) {
          req.session.user = null;
        }
        req.flash('success', 'Account deleted.');
        return res.redirect('/');
      }

      if (keepBusiness) {
        req.session.business = keepBusiness;
      }
      req.flash('success', 'Your account has been permanently deleted.');
      return res.redirect('/');
    });
  } catch (err) {
    console.error('Delete profile error:', err);
    req.flash('error', 'Failed to delete account.');
    return res.redirect('/users/profile');
  }
});

/* =======================================================
   ABOUT (public)
======================================================= */
router.get('/about', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('about', {
    title: 'About Phakisi Global',
    active: 'about',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

// ADD THIS TEST ROUTE - TEMPORARY
/*router.get('/dashboard-test', ensureVerifiedUser, async (req, res) => {
  const { _nonce = '' } = res.locals;
  const uid = req.session.user._id;

  try {
    const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).limit(20).lean();
    
    // SIMPLE TEST - render a basic page without layout
    const html = `
    <!DOCTYPE html>
    <html>
    <head><title>TEST Dashboard</title></head>
    <body>
      <h1>TEST DASHBOARD - NO CACHING</h1>
      <div style="border: 5px solid green; padding: 20px; background: lightgreen;">
        <h2>✅ TEST ROUTE LOADED</h2>
        <p>Orders count: ${orders.length}</p>
      </div>
      
      ${orders.map(o => `
        <div style="border: 2px solid blue; margin: 10px; padding: 10px;">
          <h3>Order: ${o._id}</h3>
          <p>Amount object: ${JSON.stringify(o.amount)}</p>
          <p style="color: red; font-size: 20px; font-weight: bold;">
            DIRECT DISPLAY: ${o.amount?.currency || 'USD'} ${o.amount?.value || 'NO VALUE'}
          </p>
        </div>
      `).join('')}
    </body>
    </html>
    `;
    
    res.send(html);
  } catch (error) {
    res.send(`Error: ${error.message}`);
  }
});*/

/* =======================================================
   DEV MAINTENANCE ROUTES – LIST + DELETE USERS BY EMAIL
   ⚠️ Disabled automatically in production
======================================================= */

/*function requireDevMode(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).send('Dev maintenance routes are disabled in production.');
  }
  next();
}*/

/**
 * GET /users/debug/accounts
 * List all user accounts (email, username, provider, verified, createdAt)
 */
/*router.get('/debug/accounts', requireDevMode, async (req, res) => {
  try {
    const users = await User.find({})
      .select('email username name provider isEmailVerified createdAt lastLogin')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      count: users.length,
      users,
    });
  } catch (err) {
    console.error('❌ Debug list users error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load users',
    });
  }
});*/


/**
 * POST /users/debug/accounts/delete-email
 * Delete all user accounts matching the given email
 *
 * Body or query: { email: "someone@example.com" }
 */
/*router.post('/debug/accounts/delete-email', requireDevMode, async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || req.query.email || '';
    const email = String(rawEmail).trim().toLowerCase();

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: 'Email is required',
      });
    }

    const result = await User.deleteMany({ email });

    return res.json({
      ok: true,
      deletedCount: result.deletedCount || 0,
      email,
      message: `Deleted ${result.deletedCount || 0} user account(s) for ${email}`,
    });
  } catch (err) {
    console.error('❌ Debug delete user by email error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to delete user account(s)',
    });
  }
});*/

module.exports = router;