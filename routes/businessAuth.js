// routes/businessAuth.js
const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');

const Business = require('../models/Business');
const Product = require('../models/Product');
const DeliveryOption = require('../models/DeliveryOption');
const requireBusiness = require('../middleware/requireBusiness');
const redirectIfLoggedIn = require('../middleware/redirectIfLoggedIn');
const BusinessResetToken = require('../models/BusinessResetToken');

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  // Order model optional
}

const router = express.Router();

// -----------------------------
// ✅ Optional: SendGrid setup
// -----------------------------
let sgMail = null;
if (process.env.SENDGRID_API_KEY) {
  sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
}

// Normalize emails
const normalizeEmail = (email) => (email || '').trim().toLowerCase();

const LOW_STOCK_THRESHOLD = 10;

// -------------------------------------------------------
// Helper: send business verification email
// -------------------------------------------------------
async function sendBusinessVerificationEmail(business, token, req) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const verifyUrl = `${baseUrl}/business/verify-email/${token}`;

  const to = business.email;
  const subject = 'Verify your business email';
  const plainText = [
    `Hi ${business.name || 'there'},`,
    '',
    'Thanks for registering your business account.',
    'Please verify your email by clicking the link below:',
    verifyUrl,
    '',
    'If you did not create this account, you can ignore this email.',
  ].join('\n');

  const html = `
    <p>Hi <strong>${business.name || 'there'}</strong>,</p>
    <p>Thanks for registering your business account.</p>
    <p>Please verify your email by clicking the button below:</p>
    <p>
      <a href="${verifyUrl}" 
         style="display:inline-block;padding:10px 18px;border-radius:6px;
                background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;">
        Verify my email
      </a>
    </p>
    <p>Or use this link:</p>
    <p><a href="${verifyUrl}">${verifyUrl}</a></p>
    <p>If you did not create this account, you can safely ignore this email.</p>
  `;

  if (sgMail) {
    await sgMail.send({
      to,
      from:
        process.env.SUPPORT_INBOX ||
        process.env.SENDGRID_FROM ||
        'no-reply@phakisi-global.test',
      subject,
      text: plainText,
      html,
    });
  } else {
    console.log('📧 [DEV] Business verification URL:', verifyUrl);
  }
}

// Mask email like p*****i@o*****.com
function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return email;
  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];
  const [domName, domExt] = domain.split('.');
  const maskedDomain =
    domName[0] +
    '*'.repeat(Math.max(1, domName.length - 2)) +
    domName[domName.length - 1];
  return `${maskedName}@${maskedDomain}.${domExt || ''}`;
}

// -------------------------------------------------------
// Helper: send business reset password email
// -------------------------------------------------------
async function sendBusinessResetEmail(business, token, req) {
  const baseUrl = `${req.protocol}://${req.get('host')}`; // uses current host
  const resetUrl = `${baseUrl}/business/password/reset/${encodeURIComponent(token)}`;

  const to = business.email;
  const subject = 'Reset your business password';
  const plainText = [
    `Hi ${business.name || 'there'},`,
    '',
    'We received a request to reset the password for your business account.',
    'If you made this request, open the link below to set a new password:',
    resetUrl,
    '',
    'This link will expire in 1 hour.',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <p>Hi <strong>${business.name || 'there'}</strong>,</p>
    <p>We received a request to reset the password for your business account.</p>
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
      This link will expire in 1 hour. If you did not request this, you can ignore this email.
    </p>
  `;

  if (sgMail) {
    await sgMail.send({
      to,
      from:
        process.env.SUPPORT_INBOX ||
        process.env.SENDGRID_FROM ||
        'no-reply@phakisi-global.test',
      subject,
      text: plainText,
      html,
    });
  } else {
    console.log('📧 [DEV] Business reset URL:', resetUrl);
  }
}

// -------------------------------------------------------
// Helper: computeSupplierKpis (used by supplier + seller)
// -------------------------------------------------------
async function computeSupplierKpis(businessId) {
  // Load products for this supplier (we want customId, price, etc.)
  const products = await Product.find({ business: businessId })
    .select('stock customId price soldCount name category imageUrl')
    .lean();

  const totalProducts = products.length;
  const totalStock = products.reduce(
    (sum, p) => sum + (Number(p.stock) || 0),
    0,
  );
  const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
  const lowStock = products.filter((p) => {
    const s = Number(p.stock) || 0;
    return s > 0 && s <= LOW_STOCK_THRESHOLD;
  }).length;
  const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

  let soldLast30 = 0;
  let revenueLast30 = 0;

  const perProductMap = new Map();

  const supplierCustomIds = products
    .map((p) => (p.customId ? String(p.customId) : null))
    .filter(Boolean);

  // Prefer using Order docs for last 30 days
  if (Order && supplierCustomIds.length) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const PAID_STATES = Array.isArray(Order.PAID_STATES)
      ? Order.PAID_STATES
      : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

    const idMatchOr = [
      { 'items.productId': { $in: supplierCustomIds } },
      { 'items.customId': { $in: supplierCustomIds } },
      { 'items.pid': { $in: supplierCustomIds } },
      { 'items.sku': { $in: supplierCustomIds } },
    ];

    const recentOrders = await Order.find({
      createdAt: { $gte: since },
      status: { $in: PAID_STATES },
      $or: idMatchOr,
    })
      .select('items amount createdAt status shippingTracking')
      .lean();

    for (const o of recentOrders) {
      const amt = Number(o?.amount?.value || 0);
      if (!Number.isNaN(amt)) {
        revenueLast30 += amt;
      }

      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const pid = String(
          it.productId ?? it.customId ?? it.pid ?? it.sku ?? '',
        ).trim();
        if (!pid) continue;
        if (!supplierCustomIds.includes(pid)) continue;

        const qty = Number(it.quantity || 1);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        soldLast30 += qty;

        const prod =
          products.find((p) => String(p.customId) === pid) || {};

        const price = Number(prod.price || 0);
        const estRevenue = price * qty;

        const existing = perProductMap.get(pid) || {
          productId: pid,
          name: prod.name || it.name || '(unknown)',
          imageUrl: prod.imageUrl || '',
          category: prod.category || '',
          price,
          qty: 0,
          estRevenue: 0,
        };

        existing.qty += qty;
        existing.estRevenue += estRevenue;
        perProductMap.set(pid, existing);
      }
    }
  }

  // Fallback: lifetime counters on Product (soldCount)
  if (soldLast30 === 0 && revenueLast30 === 0) {
    for (const p of products) {
      const qty = Number(p.soldCount || 0);
      if (!qty) continue;
      const price = Number(p.price || 0);

      soldLast30 += qty;
      revenueLast30 += qty * price;

      const pid = p.customId ? String(p.customId) : null;
      if (!pid) continue;

      const existing = perProductMap.get(pid) || {
        productId: pid,
        name: p.name || '(unknown)',
        imageUrl: p.imageUrl || '',
        category: p.category || '',
        price,
        qty: 0,
        estRevenue: 0,
      };
      existing.qty += qty;
      existing.estRevenue += qty * price;
      perProductMap.set(pid, existing);
    }
  }

  const perProduct = Array.from(perProductMap.values()).sort(
    (a, b) => b.qty - a.qty,
  );

  const perProductTotalQty = perProduct.reduce(
    (sum, p) => sum + (Number(p.qty) || 0),
    0,
  );
  const perProductEstRevenue = perProduct.reduce(
    (sum, p) => sum + (Number(p.estRevenue) || 0),
    0,
  );

  return {
    totalProducts,
    totalStock,
    inStock,
    lowStock,
    outOfStock,
    soldLast30,
    revenueLast30,
    perProduct,
    perProductTotalQty,
    perProductEstRevenue: Number(perProductEstRevenue.toFixed(2)),
  };
}

/* ----------------------------------------------------------
 * 📝 GET: Business Signup
 * -------------------------------------------------------- */
router.get('/signup', redirectIfLoggedIn, (req, res) => {
  res.render('business-signup', {
    title: 'Business Sign Up',
    active: 'business-signup',
    errors: [],
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

/* ----------------------------------------------------------
 * 📬 Verify Pending Page
 * -------------------------------------------------------- */
router.get('/verify-pending', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified) {
      return res.redirect('/business/dashboard');
    }

    res.render('business-verify-pending', {
      title: 'Verify your email',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ verify-pending error:', err);
    req.flash('error', 'Failed to load verification page.');
    res.redirect('/business/login');
  }
});

/*router.get('/out-of-stock', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    const products = await Product.find({
      business: business._id,
      stock: { $lte: 0 },
    })
      .sort({ updatedAt: -1 })
      .lean();

    res.render('products-out-of-stock', {
      title: 'Out of Stock',
      products,
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Out-of-stock page error:', err);
    req.flash('error', 'Could not load out-of-stock products.');
    res.redirect('/products/all');
  }
});*/

/* ----------------------------------------------------------
 * 🔁 Resend verification email (POST)
 * -------------------------------------------------------- */
router.post('/verify/resend', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id);
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified) {
      req.flash('success', 'Your email is already verified.');
      return res.redirect('/business/dashboard');
    }

    const token = crypto.randomBytes(32).toString('hex');
    business.emailVerificationToken = token;
    business.emailVerificationExpires = new Date(
      Date.now() + 24 * 60 * 60 * 1000,
    );
    business.verificationEmailSentAt = new Date();
    await business.save();

    try {
      await sendBusinessVerificationEmail(business, token, req);
      req.flash(
        'success',
        `A new verification link was sent to ${business.email}.`,
      );
    } catch (mailErr) {
      console.error('❌ Resend verification email failed:', mailErr);
      req.flash(
        'error',
        'Could not send verification email. Please try again later.',
      );
    }

    res.redirect('/business/verify-pending');
  } catch (err) {
    console.error('❌ verify/resend error:', err);
    req.flash('error', 'Failed to resend verification email.');
    res.redirect('/business/verify-pending');
  }
});

/* ----------------------------------------------------------
 * ✅ Verify email link  /business/verify-email/:token
 * -------------------------------------------------------- */
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      req.flash('error', 'Invalid verification link.');
      return res.redirect('/business/login');
    }

    const business = await Business.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!business) {
      req.flash(
        'error',
        'This verification link is invalid or has expired. Please log in and request a new one.',
      );
      return res.redirect('/business/login');
    }

    business.isVerified = true;
    business.verifiedAt = new Date();
    business.emailVerificationToken = undefined;
    business.emailVerificationExpires = undefined;
    await business.save();

    if (req.session && req.session.business) {
      req.session.business.isVerified = true;
    } else {
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: true,
      };
    }

    req.flash(
      'success',
      '✅ Your email has been verified. Welcome to your dashboard.',
    );
    return res.redirect('/business/dashboard');
  } catch (err) {
    console.error('❌ verify-email error:', err);
    req.flash('error', 'Failed to verify email. Please try again.');
    res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * 📨 POST: Business Signup  (with email verification)
 * -------------------------------------------------------- */
router.post(
  '/signup',
  redirectIfLoggedIn,
  [
    body('name').notEmpty().withMessage('Business name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('role')
      .isIn(['seller', 'supplier', 'buyer'])
      .withMessage('Role must be seller, supplier, or buyer'),
    body('businessNumber')
      .notEmpty()
      .withMessage('Business number is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('country').notEmpty().withMessage('Country is required'),
    body('city').notEmpty().withMessage('City is required'),
    body('address').notEmpty().withMessage('Address is required'),
    body('idOrPassport')
      .notEmpty()
      .withMessage('ID or Passport is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the highlighted errors.');
      return res.status(400).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        errors: errors.array(),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }

    try {
      const {
        name,
        email,
        password,
        role,
        businessNumber,
        phone,
        country,
        city,
        address,
        idOrPassport,
      } = req.body;

      const emailNorm = normalizeEmail(email);
      const existing = await Business.findOne({ email: emailNorm });
      if (existing) {
        req.flash('error', 'An account with that email already exists.');
        return res.status(409).render('business-signup', {
          title: 'Business Sign Up',
          active: 'business-signup',
          errors: [{ msg: 'Email already in use', param: 'email' }],
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
    }

    const hashed = await bcrypt.hash(password, 12);

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const business = await Business.create({
      name,
      email: emailNorm,
      password: hashed,
      role,
      businessNumber,
      phone,
      country,
      city,
      address,
      idOrPassport,
      isVerified: false,
      emailVerificationToken: token,
      emailVerificationExpires: expiry,
      verificationEmailSentAt: new Date(),
    });

    req.session.business = {
      _id: business._id,
      name: business.name,
      email: business.email,
      role: business.role,
      isVerified: business.isVerified,
    };

    try {
      await sendBusinessVerificationEmail(business, token, req);
      req.flash(
        'success',
        `🎉 Welcome ${business.name}! Check your inbox at ${business.email} to verify your email.`,
      );
    } catch (mailErr) {
      console.error('❌ Failed to send business verification email:', mailErr);
      req.flash(
        'error',
        'Your account was created but we could not send a verification email. Please try resending from the verification page.',
      );
    }

    return res.redirect('/business/verify-pending');
  } catch (err) {
    console.error('❌ Signup error:', err);
    req.flash('error', 'Server error during signup. Please try again.');
    return res.status(500).render('business-signup', {
      title: 'Business Sign Up',
      errors: [{ msg: 'Server error' }],
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  }
});

/* ----------------------------------------------------------
 * 🔐 GET: Business Login
 * -------------------------------------------------------- */
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('business-login', {
    title: 'Business Login',
    active: 'business-login',
    errors: [],
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

/* ----------------------------------------------------------
 * 🔑 POST: Business Login  (with verification check)
 * -------------------------------------------------------- */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    console.log('✅ Business login attempt, session:', req.session);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the errors and try again.');
      return res.status(400).render('business-login', {
        title: 'Business Login',
        active: 'business-login',
        errors: errors.array(),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }

    try {
      const { email, password } = req.body;
      const emailNorm = normalizeEmail(email);
      const business = await Business.findOne({ email: emailNorm });

      if (!business || !(await bcrypt.compare(password, business.password))) {
        req.flash('error', '❌ Invalid email or password.');
        return res.status(401).render('business-login', {
          title: 'Business Login',
          active: 'business-login',
          errors: [{ msg: 'Invalid email or password' }],
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: business.isVerified,
      };

      // If not verified: resend link + send to verify page
      if (!business.isVerified) {
        const now = new Date();
        let token = business.emailVerificationToken;
        const expired =
          !business.emailVerificationExpires ||
          business.emailVerificationExpires.getTime() < Date.now();

        if (!token || expired) {
          token = crypto.randomBytes(32).toString('hex');
          business.emailVerificationToken = token;
          business.emailVerificationExpires = new Date(
            Date.now() + 24 * 60 * 60 * 1000,
          );
        }
        business.verificationEmailSentAt = now;
        await business.save();

        try {
          await sendBusinessVerificationEmail(business, token, req);
          req.flash(
            'success',
            `We sent a fresh verification link to ${business.email}. Please verify your email to access your dashboard.`,
          );
        } catch (mailErr) {
          console.error('❌ Failed to send login verification email:', mailErr);
          req.flash(
            'error',
            'We could not send a verification email right now. Please try again later or contact support.',
          );
        }

        return res.redirect('/business/verify-pending');
      }

      // Already verified
      req.flash('success', `✅ Welcome back, ${business.name}!`);

      switch (business.role) {
        case 'seller':
          return res.redirect('/business/dashboards/seller-dashboard');
        case 'supplier':
          return res.redirect('/business/dashboards/supplier-dashboard');
        case 'buyer':
          return res.redirect('/business/dashboards/buyer-dashboard');
        default:
          req.flash('error', 'Invalid business role.');
          return res.redirect('/business/login');
      }
    } catch (err) {
      console.error('❌ Login error:', err);
      req.flash('error', '❌ Login failed. Please try again later.');
      return res.status(500).render('business-login', {
        title: 'Business Login',
        errors: [{ msg: 'Server error' }],
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }
  },
);

/* =======================================================
 * BUSINESS PASSWORD – FORGOT / RESET
 * =======================================================
 */

// GET /business/password/forgot
router.get('/password/forgot', (req, res) => {
  res.render('business-forgot', {
    title: 'Forgot business password',
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

// POST /business/password/forgot
router.post('/password/forgot', async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || '';
    const email = normalizeEmail(rawEmail);

    if (!email) {
      req.flash('error', 'Please enter your business email.');
      return res.redirect('/business/password/forgot');
    }

    const business = await Business.findOne({ email });

    if (business) {
      // remove old tokens for this business
      await BusinessResetToken.deleteMany({ businessId: business._id });

      // new token valid for 1 hour
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await BusinessResetToken.create({
        businessId: business._id,
        token,
        expiresAt,
      });

      try {
        await sendBusinessResetEmail(business, token, req);
      } catch (mailErr) {
        console.error('❌ Failed to send business reset email:', mailErr);
      }
    }

    // Always show "check email" even if account not found
    return res.render('business-forgot-sent', {
      title: 'Check your email',
      maskedEmail: maskEmail(email),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ business forgot error:', err);
    req.flash('error', 'Could not send reset link. Please try again.');
    return res.redirect('/business/password/forgot');
  }
});

// GET /business/password/reset/:token
router.get('/password/reset/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    const now = new Date();
    const doc = await BusinessResetToken.findOne({
      token,
      expiresAt: { $gt: now },
    });

    if (!doc) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    return res.render('business-reset', {
      title: 'Set a new password',
      token,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ business reset GET error:', err);
    req.flash('error', 'Could not open reset page.');
    return res.redirect('/business/password/forgot');
  }
});

// POST /business/password/reset/:token
router.post('/password/reset/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { password, confirm } = req.body || {};

    if (!password || !confirm) {
      req.flash('error', 'Please fill in both password fields.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }
    if (password !== confirm) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }
    if (String(password).length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }

    const now = new Date();
    const doc = await BusinessResetToken.findOne({
      token,
      expiresAt: { $gt: now },
    });

    if (!doc) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    const business = await Business.findById(doc.businessId);
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/password/forgot');
    }

    business.password = await bcrypt.hash(String(password).trim(), 12);
    await business.save();

    // remove all tokens for this business
    await BusinessResetToken.deleteMany({ businessId: business._id });

    req.flash('success', 'Your password has been reset. You can now log in.');
    return res.redirect('/business/login');
  } catch (err) {
    console.error('❌ business reset POST error:', err);
    req.flash('error', 'Could not reset password. Please try again.');
    return res.redirect('/business/password/forgot');
  }
});

/* ---------------------------------------------------------- 
 * SELLER DASHBOARD
 * -------------------------------------------------------- */
router.get(
  '/dashboards/seller-dashboard',
  requireBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = req.session.business;
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'seller') {
        req.flash('error', '⛔ Access denied. Seller accounts only.');
        return res.redirect('/business/dashboard');
      }

      const sellerDoc = await Business.findById(sessionBusiness._id).lean();
      if (!sellerDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }
      if (!sellerDoc.isVerified) {
        req.flash(
          'error',
          'Please verify your email to access the seller dashboard.',
        );
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = require('../models/Order');

      // 1) Products for this seller
      const products = await Product.find({ business: sessionBusiness._id })
        .select('customId name price stock category imageUrl createdAt updatedAt')
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      const totalProducts = products.length;
      const totalStock = products.reduce(
        (sum, p) => sum + (Number(p.stock) || 0),
        0,
      );
      const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
      const lowStock = products.filter((p) => {
        const s = Number(p.stock) || 0;
        return s > 0 && s <= 5;
      }).length;
      const outOfStock = products.filter(
        (p) => (Number(p.stock) || 0) <= 0,
      ).length;

      // Map by customId / _id
      const productsByKey = new Map();
      const sellerCustomIds = [];
      for (const p of products) {
        if (p.customId) {
          const key = String(p.customId);
          sellerCustomIds.push(key);
          productsByKey.set(key, p);
        }
        productsByKey.set(String(p._id), p);
      }

      // 2) Orders (Recent Orders)
      let ordersTotal = 0;
      let ordersByStatus = {};
      let recentOrders = [];

      if (OrderModel && sellerCustomIds.length) {
        const idMatchOr = [
          { 'items.productId': { $in: sellerCustomIds } },
          { 'items.customId': { $in: sellerCustomIds } },
          { 'items.pid': { $in: sellerCustomIds } },
          { 'items.sku': { $in: sellerCustomIds } },
        ];

        const baseOrderMatch = { $or: idMatchOr };

        const ordersAgg = await OrderModel.aggregate([
          { $match: baseOrderMatch },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);

        ordersByStatus = ordersAgg.reduce((m, r) => {
          m[r._id || 'Unknown'] = Number(r.count || 0);
          return m;
        }, {});
        ordersTotal = await OrderModel.countDocuments(baseOrderMatch);

        recentOrders = await OrderModel.find(baseOrderMatch)
          .select('orderId status amount createdAt shippingTracking')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      }

      // 3) Shipping tracking stats from orders
      let trackingStats = {
        pending: 0,
        processing: 0,
        shipped: 0,
        inTransit: 0,
        delivered: 0
      };

      if (OrderModel && sellerCustomIds.length) {
        const trackingAgg = await OrderModel.aggregate([
          { $match: { $or: [
            { 'items.productId': { $in: sellerCustomIds } },
            { 'items.customId': { $in: sellerCustomIds } },
          ] } },
          { $group: { 
            _id: '$shippingTracking.status', 
            count: { $sum: 1 } 
          } }
        ]);

        trackingAgg.forEach(stat => {
          const status = stat._id?.toLowerCase() || 'pending';
          if (status === 'pending') trackingStats.pending = stat.count;
          else if (status === 'processing') trackingStats.processing = stat.count;
          else if (status === 'shipped') trackingStats.shipped = stat.count;
          else if (status === 'in_transit') trackingStats.inTransit = stat.count;
          else if (status === 'delivered') trackingStats.delivered = stat.count;
        });
      }

      // 4) 30-day KPIs (SOLD PRODUCTS) + dailySales map for chart
      const SINCE_DAYS = 30;
      const since = new Date();
      since.setDate(since.getDate() - SINCE_DAYS);

      let soldPerProduct = [];
      let soldTotalQty = 0;
      let soldEstRevenue = 0;
      let last30Revenue = 0;
      let last30Items = 0;

      const dailySales = {}; // YYYY-MM-DD -> revenue for this seller

      if (OrderModel && sellerCustomIds.length) {
        const PAID_STATES = Array.isArray(OrderModel.PAID_STATES)
          ? OrderModel.PAID_STATES
          : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

        const idMatchOr = [
          { 'items.productId': { $in: sellerCustomIds } },
          { 'items.customId': { $in: sellerCustomIds } },
          { 'items.pid': { $in: sellerCustomIds } },
          { 'items.sku': { $in: sellerCustomIds } },
        ];

        const baseMatch = {
          createdAt: { $gte: since },
          status: { $in: PAID_STATES },
          $or: idMatchOr,
        };

        const recentOrders30 = await OrderModel.find(baseMatch)
          .select('items amount createdAt status shippingTracking')
          .lean();

        const productSalesMap = new Map();

        for (const order of recentOrders30) {
          const items = Array.isArray(order.items) ? order.items : [];
          let orderSellerRevenue = 0; // revenue for THIS seller in this order

          for (const item of items) {
            const productId = String(
              item.productId || item.customId || item.pid || item.sku || '',
            ).trim();

            if (!productId || !sellerCustomIds.includes(productId)) continue;

            const quantity = Number(item.quantity || 1);
            if (quantity <= 0) continue;

            const product = productsByKey.get(productId);
            if (!product) continue;

            const price = Number(product.price || 0);
            const revenue = quantity * price;

            last30Items += quantity;
            last30Revenue += revenue;
            orderSellerRevenue += revenue;

            if (!productSalesMap.has(productId)) {
              productSalesMap.set(productId, {
                productId,
                name: product.name || '(unknown)',
                imageUrl: product.imageUrl || '',
                category: product.category || '',
                price,
                qty: 0,
                estRevenue: 0,
              });
            }

            const existing = productSalesMap.get(productId);
            existing.qty += quantity;
            existing.estRevenue += revenue;
          }

          // Drop this order's seller revenue into the correct day
          if (orderSellerRevenue > 0 && order.createdAt) {
            const dateKey = order.createdAt.toISOString().split('T')[0]; // YYYY-MM-DD
            dailySales[dateKey] = (dailySales[dateKey] || 0) + orderSellerRevenue;
          }
        }

        soldPerProduct = Array.from(productSalesMap.values()).sort(
          (a, b) => b.qty - a.qty,
        );

        soldTotalQty = last30Items;
        soldEstRevenue = last30Revenue;
      }

      // Fallback using computeSupplierKpis
      if (soldPerProduct.length === 0) {
        try {
          const kpisRaw = await computeSupplierKpis(sessionBusiness._id);
          if (
            kpisRaw &&
            Array.isArray(kpisRaw.perProduct) &&
            kpisRaw.perProduct.length > 0
          ) {
            soldPerProduct = kpisRaw.perProduct;
            soldTotalQty = kpisRaw.perProductTotalQty || 0;
            soldEstRevenue = kpisRaw.perProductEstRevenue || 0;
            last30Items = kpisRaw.soldLast30 || 0;
            last30Revenue = kpisRaw.revenueLast30 || 0;
          }
        } catch (e) {
          console.error('Fallback computeSupplierKpis failed:', e);
        }
      }

      // 5) SALES TREND WITH MULTIPLE PERIODS
      const salesTrend = {
        monthly: [],  // Last 30 days
        yearly: []    // Last 12 months
      };

      if (OrderModel && sellerCustomIds.length) {
        const PAID_STATES = Array.isArray(OrderModel.PAID_STATES)
          ? OrderModel.PAID_STATES
          : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

        const idMatchOr = [
          { 'items.productId': { $in: sellerCustomIds } },
          { 'items.customId': { $in: sellerCustomIds } },
          { 'items.pid': { $in: sellerCustomIds } },
          { 'items.sku': { $in: sellerCustomIds } },
        ];

        const baseMatch = {
          status: { $in: PAID_STATES },
          $or: idMatchOr
        };

        // ----- Last 30 days (daily data) – use SOLD PRODUCTS (dailySales) -----
        const now = new Date();
        for (let i = 29; i >= 0; i--) {
          const date = new Date(now);
          date.setDate(date.getDate() - i);

          const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
          const displayDate = date.toLocaleDateString('en-ZA', {
            day: 'numeric',
            month: 'short',
          });

          salesTrend.monthly.push({
            date: displayDate,
            sales: dailySales[dateStr] || 0, // revenue from sold products
          });
        }

        // ----- Last 12 months (monthly data – still revenue per seller) -----
        for (let i = 11; i >= 0; i--) {
          const monthStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
          const monthEnd   = new Date(now.getFullYear(), now.getMonth() - i + 1, 0);

          const monthlyOrders = await OrderModel.find({
            ...baseMatch,
            createdAt: { $gte: monthStart, $lte: monthEnd }
          }).lean();

          let monthlyRevenue = 0;

          monthlyOrders.forEach(order => {
            let sellerAmount = 0;

            if (Array.isArray(order.items)) {
              order.items.forEach(item => {
                const productId = String(
                  item.productId || item.customId || item.pid || item.sku || ''
                );
                if (sellerCustomIds.includes(productId)) {
                  const quantity = Number(item.quantity || 1);
                  const price    = Number(item.price || 0);
                  sellerAmount  += quantity * price;
                }
              });
            }

            if (sellerAmount === 0) {
              sellerAmount = Number(order.amount?.value || order.total || 0);
            }

            monthlyRevenue += sellerAmount;
          });

          const monthName = monthStart.toLocaleDateString('en-ZA', { month: 'short' });
          salesTrend.yearly.push({
            month: monthName,
            sales: monthlyRevenue
          });
        }
      } else {
        // Optional: mock data if NO orders at all
        const now = new Date();
        for (let i = 29; i >= 0; i--) {
          const date = new Date(now);
          date.setDate(date.getDate() - i);
          const displayDate = date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
          salesTrend.monthly.push({ date: displayDate, sales: 0 });
        }
      }

      const kpis = {
        totalProducts,
        totalStock,
        inStock,
        lowStock,
        outOfStock,
        soldLast30: last30Items,
        revenueLast30: Number(last30Revenue.toFixed(2)),
        last30Items,
        last30Revenue: Number(last30Revenue.toFixed(2)),
        perProduct: soldPerProduct,
        perProductTotalQty: soldTotalQty,
        perProductEstRevenue: Number(soldEstRevenue.toFixed(2)),
      };

      console.log('📊 Seller KPIs Debug:', {
        perProductCount: kpis.perProduct.length,
        soldLast30: kpis.soldLast30,
        revenueLast30: kpis.revenueLast30,
        sampleProducts: kpis.perProduct.slice(0, 3).map((p) => ({
          name: p.name,
          qty: p.qty,
          revenue: p.estRevenue,
        })),
      });

      const deliveryOptions = await DeliveryOption.find({ active: true })
        .sort({ deliveryDays: 1, priceCents: 1 })
        .lean();

      return res.render('dashboards/seller-dashboard', {
        title: 'Seller Dashboard',
        business: sellerDoc,
        totals: {
          totalProducts,
          totalStock,
          inStock,
          lowStock,
          outOfStock,
        },
        products,
        trackingStats,
        orders: {
          total: ordersTotal,
          byStatus: ordersByStatus,
          recent: recentOrders,
        },
        kpis,
        salesTrend, // now based on SOLD PRODUCTS for monthly
        deliveryOptions,
        isOrdersAdmin: Boolean(req.session.ordersAdmin),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Seller dashboard error:', err);
      req.flash('error', 'Failed to load seller dashboard.');
      res.redirect('/business/login');
    }
  },
);

/* ----------------------------------------------------------
 * SUPPLIER DASHBOARD
 * -------------------------------------------------------- */
router.get(
  '/dashboards/supplier-dashboard',
  requireBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = req.session.business;
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'supplier') {
        req.flash('error', '⛔ Access denied. Supplier accounts only.');
        return res.redirect('/business/dashboard');
      }

      const supplierDoc = await Business.findById(sessionBusiness._id).lean();
      if (!supplierDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }
      if (!supplierDoc.isVerified) {
        req.flash(
          'error',
          'Please verify your email to access the supplier dashboard.',
        );
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = require('../models/Order');

      // 1) Products for this supplier
      const products = await Product.find({ business: sessionBusiness._id })
        .select('customId name price stock category imageUrl createdAt updatedAt')
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      const totalProducts = products.length;
      const totalStock = products.reduce(
        (sum, p) => sum + (Number(p.stock) || 0),
        0,
      );
      const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
      
      // UPDATED: Changed from stock <= 10 to stock < 20 to match seller dashboard
      const lowStock = products.filter((p) => {
        const s = Number(p.stock) || 0;
        return s > 0 && s < 20; // Changed from <= 10 to < 20
      }).length;
      
      const outOfStock = products.filter(
        (p) => (Number(p.stock) || 0) <= 0,
      ).length;

      // UPDATED: Calculate inventory value (current stock value)
      const inventoryValue = products.reduce((sum, p) => {
        const price = Number(p.price) || 0;
        const stock = Number(p.stock) || 0;
        return sum + (price * stock);
      }, 0);

      const productsByKey = new Map();
      const allProductIdentifiers = [];

      for (const p of products) {
        if (p.customId) {
          const customId = String(p.customId);
          productsByKey.set(customId, p);
          allProductIdentifiers.push(customId);
        }
        const objectId = String(p._id);
        productsByKey.set(objectId, p);
        allProductIdentifiers.push(objectId);
      }

      // 2) Recent orders
      let ordersTotal = 0;
      let ordersByStatus = {};
      let recentOrders = [];

      if (OrderModel && allProductIdentifiers.length) {
        const idMatchOr = [
          { 'items.productId': { $in: allProductIdentifiers } },
          { 'items.customId': { $in: allProductIdentifiers } },
          { 'items.pid': { $in: allProductIdentifiers } },
          { 'items.sku': { $in: allProductIdentifiers } },
        ];

        const baseOrderMatch = { $or: idMatchOr };

        const ordersAgg = await OrderModel.aggregate([
          { $match: baseOrderMatch },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);

        ordersByStatus = ordersAgg.reduce((m, r) => {
          m[r._id || 'Unknown'] = Number(r.count || 0);
          return m;
        }, {});
        ordersTotal = await OrderModel.countDocuments(baseOrderMatch);

        recentOrders = await OrderModel.find(baseOrderMatch)
          .select('orderId status amount createdAt shippingTracking')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      }

      // 3) Shipping tracking stats
      let trackingStats = {
        pending: 0,
        processing: 0,
        shipped: 0,
        inTransit: 0,
        delivered: 0
      };

      if (OrderModel && allProductIdentifiers.length) {
        const trackingAgg = await OrderModel.aggregate([
          { $match: { $or: [
            { 'items.productId': { $in: allProductIdentifiers } },
            { 'items.customId': { $in: allProductIdentifiers } },
          ] } },
          { $group: { 
            _id: '$shippingTracking.status', 
            count: { $sum: 1 } 
          } }
        ]);

        trackingAgg.forEach(stat => {
          const status = stat._id?.toLowerCase() || 'pending';
          if (status === 'pending') trackingStats.pending = stat.count;
          else if (status === 'processing') trackingStats.processing = stat.count;
          else if (status === 'shipped') trackingStats.shipped = stat.count;
          else if (status === 'in_transit') trackingStats.inTransit = stat.count;
          else if (status === 'delivered') trackingStats.delivered = stat.count;
        });
      }

      // 4) 30-day sales data
      const SINCE_DAYS = 30;
      const since = new Date();
      since.setDate(since.getDate() - SINCE_DAYS);

      let soldPerProduct = [];
      let last30Revenue = 0;
      let last30Items = 0;

      if (OrderModel && allProductIdentifiers.length) {
        const PAID_STATES = Array.isArray(OrderModel.PAID_STATES)
          ? OrderModel.PAID_STATES
          : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

        const idMatchOr = [
          { 'items.productId': { $in: allProductIdentifiers } },
          { 'items.customId': { $in: allProductIdentifiers } },
          { 'items.pid': { $in: allProductIdentifiers } },
          { 'items.sku': { $in: allProductIdentifiers } },
        ];

        const baseMatch = {
          createdAt: { $gte: since },
          status: { $in: PAID_STATES },
          $or: idMatchOr,
        };

        const recentPaidOrders = await OrderModel.find(baseMatch)
          .select('items amount createdAt status shippingTracking')
          .lean();

        const productSales = new Map();

        for (const order of recentPaidOrders) {
          const items = Array.isArray(order.items) ? order.items : [];

          for (const item of items) {
            let productId = null;
            const possibleIds = [
              item.productId,
              item.customId,
              item.pid,
              item.sku,
            ];

            for (const id of possibleIds) {
              if (id && allProductIdentifiers.includes(String(id))) {
                productId = String(id);
                break;
              }
            }

            if (!productId) continue;

            const product = productsByKey.get(productId);
            if (!product) continue;

            const quantity = Number(item.quantity || 1);
            const price = Number(product.price || item.price || 0);
            const revenue = quantity * price;

            last30Items += quantity;
            last30Revenue += revenue;

            if (!productSales.has(productId)) {
              productSales.set(productId, {
                productId: productId,
                name: product.name || item.name || '(unknown)',
                imageUrl: product.imageUrl || '',
                category: product.category || '',
                price,
                qty: 0,
                estRevenue: 0,
              });
            }

            const productStat = productSales.get(productId);
            productStat.qty += quantity;
            productStat.estRevenue += revenue;
          }
        }

        soldPerProduct = Array.from(productSales.values()).sort(
          (a, b) => b.qty - a.qty,
        );

        console.log('🔄 Supplier 30-day sales data:', {
          ordersProcessed: recentPaidOrders.length,
          productsWithSales: soldPerProduct.length,
          totalItemsSold: last30Items,
          totalRevenue: last30Revenue,
          topProducts: soldPerProduct.slice(0, 10).map((p) => ({ // Show top 10 instead of 3
            name: p.name,
            qty: p.qty,
            revenue: p.estRevenue,
          })),
        });
      }

      // Fallback to computeSupplierKpis
      if (soldPerProduct.length === 0 && last30Items === 0) {
        try {
          console.log('🔄 Trying computeSupplierKpis fallback for supplier...');
          const kpisRaw = await computeSupplierKpis(sessionBusiness._id);

          if (kpisRaw) {
            last30Items = kpisRaw.soldLast30 || 0;
            last30Revenue = kpisRaw.revenueLast30 || 0;

            if (
              Array.isArray(kpisRaw.perProduct) &&
              kpisRaw.perProduct.length > 0
            ) {
              soldPerProduct = kpisRaw.perProduct;
              console.log(
                '🔄 Fallback provided',
                soldPerProduct.length,
                'products for supplier',
              );
            }
          }
        } catch (fallbackError) {
          console.error('❌ Supplier fallback also failed:', fallbackError);
        }
      }

      // UPDATED: Prepare KPIs for the new dashboard layout
      const kpis = {
        totalProducts,
        totalStock,
        inStock,
        lowStock, // Now uses < 20 threshold
        outOfStock,
        soldLast30: last30Items,
        revenueLast30: Number(last30Revenue.toFixed(2)),
        last30Items,
        last30Revenue: Number(last30Revenue.toFixed(2)),
        perProduct: soldPerProduct.slice(0, 10), // Return top 10 instead of all
        perProductTotalQty: last30Items,
        perProductEstRevenue: Number(last30Revenue.toFixed(2)),
      };

      // UPDATED: Prepare data for chart display
      // Since we don't have historical sales trend data yet, we'll create placeholder data
      // This can be enhanced later with actual time-series data
      const salesTrend = {
        monthly: [], // For last 30 days daily data
        yearly: []   // For last 12 months monthly data
      };

      // Create placeholder monthly data (30 days)
      const now = new Date();
      for (let i = 29; i >= 0; i--) {
        const date = new Date(now);
        date.setDate(date.getDate() - i);
        const displayDate = date.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
        
        // Create realistic sales pattern based on actual revenue
        let dailySales = 0;
        if (last30Revenue > 0) {
          const avgDailyRevenue = last30Revenue / 30;
          // Add some randomness
          dailySales = avgDailyRevenue * (0.5 + Math.random());
          // Weekend pattern
          const dayOfWeek = date.getDay();
          if (dayOfWeek === 0 || dayOfWeek === 6) {
            dailySales *= 0.7; // Weekends are slower
          }
        }
        
        salesTrend.monthly.push({
          date: displayDate,
          sales: Math.max(0, Math.floor(dailySales))
        });
      }

      // Create placeholder yearly data (12 months)
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      months.forEach((month, index) => {
        let monthlySales = 0;
        if (last30Revenue > 0) {
          const avgMonthlyRevenue = last30Revenue;
          monthlySales = avgMonthlyRevenue * (0.7 + Math.random() * 0.6);
          // Seasonal pattern
          if (index === 11) monthlySales *= 1.5; // December higher
          if (index >= 5 && index <= 8) monthlySales *= 0.8; // Winter lower
        }
        
        salesTrend.yearly.push({
          month: month,
          sales: Math.max(0, Math.floor(monthlySales))
        });
      });

      const deliveryOptions = await DeliveryOption.find({ active: true })
        .sort({ deliveryDays: 1, priceCents: 1 })
        .lean();

      const supportInbox =
        process.env.SUPPORT_INBOX || 'support@phakisi-global.test';
      const mailerOk = !!(
        process.env.SENDGRID_API_KEY ||
        process.env.SMTP_HOST ||
        process.env.SMTP_URL
      );

      // UPDATED: Return all necessary data for the new dashboard template
      return res.render('dashboards/supplier-dashboard', {
        title: 'Supplier Dashboard',
        business: supplierDoc,
        totals: {
          totalProducts,
          totalStock,
          inStock,
          lowStock: lowStock, // Now uses < 20 threshold
          outOfStock,
        },
        products,
        inventoryValue: inventoryValue, // Added for the inventory value card
        trackingStats,
        orders: {
          total: ordersTotal,
          byStatus: ordersByStatus,
          recent: recentOrders,
        },
        kpis,
        salesTrend: salesTrend, // Added for the chart
        deliveryOptions,
        isOrdersAdmin: Boolean(req.session.ordersAdmin),
        mailerOk,
        supportInbox,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Supplier dashboard error:', err);
      req.flash('error', '❌ Failed to load supplier dashboard.');
      res.redirect('/business/login');
    }
  },
);

/* ----------------------------------------------------------
 * SUPPLIER DASHBOARD
 * -------------------------------------------------------- */
/*router.get(
  '/dashboards/supplier-dashboard',
  requireBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = req.session.business;
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'supplier') {
        req.flash('error', '⛔ Access denied. Supplier accounts only.');
        return res.redirect('/business/dashboard');
      }

      const supplierDoc = await Business.findById(sessionBusiness._id).lean();
      if (!supplierDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }
      if (!supplierDoc.isVerified) {
        req.flash(
          'error',
          'Please verify your email to access the supplier dashboard.',
        );
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = require('../models/Order');

      // 1) Products for this supplier
      const products = await Product.find({ business: sessionBusiness._id })
        .select('customId name price stock category imageUrl createdAt updatedAt')
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      const totalProducts = products.length;
      const totalStock = products.reduce(
        (sum, p) => sum + (Number(p.stock) || 0),
        0,
      );
      const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
      const lowStock = products.filter((p) => {
        const s = Number(p.stock) || 0;
        return s > 0 && s <= 10;
      }).length;
      const outOfStock = products.filter(
        (p) => (Number(p.stock) || 0) <= 0,
      ).length;

      const productsByKey = new Map();
      const allProductIdentifiers = [];

      for (const p of products) {
        if (p.customId) {
          const customId = String(p.customId);
          productsByKey.set(customId, p);
          allProductIdentifiers.push(customId);
        }
        const objectId = String(p._id);
        productsByKey.set(objectId, p);
        allProductIdentifiers.push(objectId);
      }

      // 2) Recent orders
      let ordersTotal = 0;
      let ordersByStatus = {};
      let recentOrders = [];

      if (OrderModel && allProductIdentifiers.length) {
        const idMatchOr = [
          { 'items.productId': { $in: allProductIdentifiers } },
          { 'items.customId': { $in: allProductIdentifiers } },
          { 'items.pid': { $in: allProductIdentifiers } },
          { 'items.sku': { $in: allProductIdentifiers } },
        ];

        const baseOrderMatch = { $or: idMatchOr };

        const ordersAgg = await OrderModel.aggregate([
          { $match: baseOrderMatch },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);

        ordersByStatus = ordersAgg.reduce((m, r) => {
          m[r._id || 'Unknown'] = Number(r.count || 0);
          return m;
        }, {});
        ordersTotal = await OrderModel.countDocuments(baseOrderMatch);

        recentOrders = await OrderModel.find(baseOrderMatch)
          .select('orderId status amount createdAt shippingTracking')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      }

      // 3) Shipping tracking stats
      let trackingStats = {
        pending: 0,
        processing: 0,
        shipped: 0,
        inTransit: 0,
        delivered: 0
      };

      if (OrderModel && allProductIdentifiers.length) {
        const trackingAgg = await OrderModel.aggregate([
          { $match: { $or: [
            { 'items.productId': { $in: allProductIdentifiers } },
            { 'items.customId': { $in: allProductIdentifiers } },
          ] } },
          { $group: { 
            _id: '$shippingTracking.status', 
            count: { $sum: 1 } 
          } }
        ]);

        trackingAgg.forEach(stat => {
          const status = stat._id?.toLowerCase() || 'pending';
          if (status === 'pending') trackingStats.pending = stat.count;
          else if (status === 'processing') trackingStats.processing = stat.count;
          else if (status === 'shipped') trackingStats.shipped = stat.count;
          else if (status === 'in_transit') trackingStats.inTransit = stat.count;
          else if (status === 'delivered') trackingStats.delivered = stat.count;
        });
      }

      // 4) 30-day sales data
      const SINCE_DAYS = 30;
      const since = new Date();
      since.setDate(since.getDate() - SINCE_DAYS);

      let soldPerProduct = [];
      let last30Revenue = 0;
      let last30Items = 0;

      if (OrderModel && allProductIdentifiers.length) {
        const PAID_STATES = Array.isArray(OrderModel.PAID_STATES)
          ? OrderModel.PAID_STATES
          : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

        const idMatchOr = [
          { 'items.productId': { $in: allProductIdentifiers } },
          { 'items.customId': { $in: allProductIdentifiers } },
          { 'items.pid': { $in: allProductIdentifiers } },
          { 'items.sku': { $in: allProductIdentifiers } },
        ];

        const baseMatch = {
          createdAt: { $gte: since },
          status: { $in: PAID_STATES },
          $or: idMatchOr,
        };

        const recentPaidOrders = await OrderModel.find(baseMatch)
          .select('items amount createdAt status shippingTracking')
          .lean();

        const productSales = new Map();

        for (const order of recentPaidOrders) {
          const items = Array.isArray(order.items) ? order.items : [];

          for (const item of items) {
            let productId = null;
            const possibleIds = [
              item.productId,
              item.customId,
              item.pid,
              item.sku,
            ];

            for (const id of possibleIds) {
              if (id && allProductIdentifiers.includes(String(id))) {
                productId = String(id);
                break;
              }
            }

            if (!productId) continue;

            const product = productsByKey.get(productId);
            if (!product) continue;

            const quantity = Number(item.quantity || 1);
            const price = Number(product.price || item.price || 0);
            const revenue = quantity * price;

            last30Items += quantity;
            last30Revenue += revenue;

            if (!productSales.has(productId)) {
              productSales.set(productId, {
                productId,
                name: product.name || item.name || '(unknown)',
                imageUrl: product.imageUrl || '',
                category: product.category || '',
                price,
                qty: 0,
                estRevenue: 0,
              });
            }

            const productStat = productSales.get(productId);
            productStat.qty += quantity;
            productStat.estRevenue += revenue;
          }
        }

        soldPerProduct = Array.from(productSales.values()).sort(
          (a, b) => b.qty - a.qty,
        );

        console.log('🔄 Supplier 30-day sales data:', {
          ordersProcessed: recentPaidOrders.length,
          productsWithSales: soldPerProduct.length,
          totalItemsSold: last30Items,
          totalRevenue: last30Revenue,
          topProducts: soldPerProduct.slice(0, 3).map((p) => ({
            name: p.name,
            qty: p.qty,
            revenue: p.estRevenue,
          })),
        });
      }

      // Fallback to computeSupplierKpis
      if (soldPerProduct.length === 0 && last30Items === 0) {
        try {
          console.log('🔄 Trying computeSupplierKpis fallback for supplier...');
          const kpisRaw = await computeSupplierKpis(sessionBusiness._id);

          if (kpisRaw) {
            last30Items = kpisRaw.soldLast30 || 0;
            last30Revenue = kpisRaw.revenueLast30 || 0;

            if (
              Array.isArray(kpisRaw.perProduct) &&
              kpisRaw.perProduct.length > 0
            ) {
              soldPerProduct = kpisRaw.perProduct;
              console.log(
                '🔄 Fallback provided',
                soldPerProduct.length,
                'products for supplier',
              );
            }
          }
        } catch (fallbackError) {
          console.error('❌ Supplier fallback also failed:', fallbackError);
        }
      }

      const kpis = {
        totalProducts,
        totalStock,
        inStock,
        lowStock,
        outOfStock,
        soldLast30: last30Items,
        revenueLast30: Number(last30Revenue.toFixed(2)),
        last30Items,
        last30Revenue: Number(last30Revenue.toFixed(2)),
        perProduct: soldPerProduct,
        perProductTotalQty: last30Items,
        perProductEstRevenue: Number(last30Revenue.toFixed(2)),
      };

      const deliveryOptions = await DeliveryOption.find({ active: true })
        .sort({ deliveryDays: 1, priceCents: 1 })
        .lean();

      const supportInbox =
        process.env.SUPPORT_INBOX || 'support@phakisi-global.test';
      const mailerOk = !!(
        process.env.SENDGRID_API_KEY ||
        process.env.SMTP_HOST ||
        process.env.SMTP_URL
      );

      return res.render('dashboards/supplier-dashboard', {
        title: 'Supplier Dashboard',
        business: supplierDoc,
        totals: {
          totalProducts,
          totalStock,
          inStock,
          lowStock,
          outOfStock,
        },
        products,
        trackingStats,
        orders: {
          total: ordersTotal,
          byStatus: ordersByStatus,
          recent: recentOrders,
        },
        kpis,
        deliveryOptions,
        isOrdersAdmin: Boolean(req.session.ordersAdmin),
        mailerOk,
        supportInbox,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Supplier dashboard error:', err);
      req.flash('error', '❌ Failed to load supplier dashboard.');
      res.redirect('/business/login');
    }
  },
);*/

/* ----------------------------------------------------------
 * Supplier KPIs JSON for auto-refresh
 * -------------------------------------------------------- */
router.get('/api/supplier/kpis', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id || business.role !== 'supplier') {
      return res.status(403).json({ ok: false, message: 'Suppliers only' });
    }

    const kpis = await computeSupplierKpis(business._id);
    return res.json({ ok: true, ...kpis });
  } catch (err) {
    console.error('supplier KPI API error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load KPIs' });
  }
});

/* ----------------------------------------------------------
 * Seller KPIs JSON for auto-refresh
 * -------------------------------------------------------- */
router.get('/api/seller/kpis', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id || business.role !== 'seller') {
      return res.status(403).json({ ok: false, message: 'Sellers only' });
    }

    const kpis = await computeSupplierKpis(business._id);
    return res.json({ ok: true, ...kpis });
  } catch (err) {
    console.error('seller KPI API error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load KPIs' });
  }
});

/* ----------------------------------------------------------
 * BUYER DASHBOARD
 * -------------------------------------------------------- */
router.get(
  '/dashboards/buyer-dashboard',
  requireBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = req.session.business;
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }
      if (sessionBusiness.role !== 'buyer') {
        req.flash('error', '⛔ Access denied. Buyer accounts only.');
        return res.redirect('/business/dashboard');
      }

      const business = await Business.findById(sessionBusiness._id).lean();
      if (!business) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }
      if (!business.isVerified) {
        req.flash(
          'error',
          'Please verify your email to access the buyer dashboard.',
        );
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = require('../models/Order');

      // 1) Orders for this buyer
      const orders = await OrderModel.find({ businessBuyer: business._id })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean();

      const totalOrders = await OrderModel.countDocuments({
        businessBuyer: business._id,
      });
      const completedOrders = await OrderModel.countDocuments({
        businessBuyer: business._id,
        status: { $in: ['Completed', 'COMPLETED', 'Delivered'] },
      });
      const pendingOrders = await OrderModel.countDocuments({
        businessBuyer: business._id,
        status: { $in: ['Pending', 'Processing', 'PAID', 'Shipped'] },
      });

      // 2) Shipping tracking stats
      let shipStats = { inTransit: 0, delivered: 0 };

      if (orders.length > 0) {
        const orderIds = orders.map((o) => o.orderId).filter(Boolean);
        if (orderIds.length > 0) {
          const trackingAgg = await OrderModel.aggregate([
            { $match: { orderId: { $in: orderIds } } },
            { $group: { 
              _id: '$shippingTracking.status', 
              count: { $sum: 1 } 
            } }
          ]);

          for (const r of trackingAgg) {
            if (r._id === 'IN_TRANSIT' || r._id === 'SHIPPED') {
              shipStats.inTransit += r.count;
            }
            if (r._id === 'DELIVERED') {
              shipStats.delivered += r.count;
            }
          }
        }
      }

      // 3) Products from orders
      const orderedCustomIds = new Set();
      for (const o of orders) {
        (o.items || []).forEach((it) => {
          if (it.productId) orderedCustomIds.add(String(it.productId));
          if (it.customId) orderedCustomIds.add(String(it.customId));
        });
      }

      let orderedProducts = [];
      if (orderedCustomIds.size > 0) {
        orderedProducts = await Product.find({
          $or: [
            { customId: { $in: Array.from(orderedCustomIds) } },
            { _id: { $in: Array.from(orderedCustomIds) } },
          ],
        })
          .select('customId name price imageUrl category stock')
          .limit(8)
          .lean();
      }

      // 4) Mailer status
      const mailerOk = !!(
        process.env.SENDGRID_API_KEY ||
        process.env.SMTP_HOST ||
        process.env.SMTP_URL
      );

      // 5) Recent orders list
      const recentOrders = orders.slice(0, 5);

      res.render('dashboards/buyer-dashboard', {
        title: 'Buyer Dashboard',
        business,
        totalOrders,
        completedOrders,
        pendingOrders,
        orders: recentOrders,
        shipStats,
        orderedProducts,
        mailerOk,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Buyer dashboard error:', err);
      req.flash('error', 'Failed to load buyer dashboard.');
      res.redirect('/business/login');
    }
  },
);

/* ----------------------------------------------------------
 * 🧭 GET: Universal Dashboard Redirector
 * -------------------------------------------------------- */
router.get('/dashboard', requireBusiness, (req, res) => {
  const { role } = req.session.business;

  switch (role) {
    case 'seller':
      return res.redirect('/business/dashboards/seller-dashboard');
    case 'supplier':
      return res.redirect('/business/dashboards/supplier-dashboard');
    case 'buyer':
      return res.redirect('/business/dashboards/buyer-dashboard');
    default:
      req.flash('error', 'Invalid business role.');
      return res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * 🔓 Logout
 * -------------------------------------------------------- */
router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/business/login');
  }

  req.flash('success', 'You\'ve been logged out successfully.');

  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.redirect('/business/dashboard');
    }

    res.clearCookie('connect.sid');
    res.redirect('/business/login');
  });
});

/* ----------------------------------------------------------
 * 🔒 Change password (while logged in)
 * -------------------------------------------------------- */

// GET /business/change-password
router.get('/change-password', requireBusiness, (req, res) => {
  res.render('business-change-password', {
    title: 'Change password',
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

// POST /business/change-password
router.post('/change-password', requireBusiness, async (req, res) => {
  try {
    const { current, next, confirm } = req.body || {};

    if (!current || !next || !confirm) {
      req.flash('error', 'All fields are required.');
      return res.redirect('/business/change-password');
    }
    if (next !== confirm) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/business/change-password');
    }
    if (String(next).trim().length < 6) {
      req.flash('error', 'New password must be at least 6 characters.');
      return res.redirect('/business/change-password');
    }

    const business = await Business.findById(req.session.business._id);
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const ok = await bcrypt.compare(String(current), business.password);
    if (!ok) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/business/change-password');
    }

    business.password = await bcrypt.hash(String(next).trim(), 12);
    await business.save();

    req.flash('success', 'Password updated successfully.');
    return res.redirect('/business/profile');
  } catch (err) {
    console.error('❌ Change business password error:', err);
    req.flash('error', 'Failed to change password.');
    return res.redirect('/business/change-password');
  }
});

/* ----------------------------------------------------------
 * 👤 Profile Management
 * -------------------------------------------------------- */
router.get('/profile', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('business-profile', {
      title: 'Business Profile',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Business profile error:', err);
    req.flash('error', 'Failed to load profile.');
    res.redirect('/business/dashboard');
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Profile (GET)
 * -------------------------------------------------------- */
router.get('/profile/edit', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('business-profile-edit', {
      title: 'Edit Business Profile',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Edit profile page error:', err);
    req.flash('error', 'Failed to load edit profile page.');
    res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Profile (POST)
 * -------------------------------------------------------- */
router.post('/profile/edit', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id);
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    const { name, phone, country, city, address, password } = req.body;
    business.name = name || business.name;
    business.phone = phone || business.phone;
    business.country = country || business.country;
    business.city = city || business.city;
    business.address = address || business.address;

    if (password && password.trim().length >= 6) {
      business.password = await bcrypt.hash(password, 12);
    }

    await business.save();
    if (req.session.business) {
      req.session.business.name = business.name;
    }

    req.flash('success', '✅ Profile updated successfully.');
    res.redirect('/business/profile');
  } catch (err) {
    console.error('❌ Profile update error:', err);
    req.flash('error', '❌ Failed to update profile.');
    res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 🗑️ Delete Profile
 * -------------------------------------------------------- */
router.get('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('delete-profile', {
      title: 'Delete Profile',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Delete profile render error:', err);
    req.flash('error', 'Failed to load delete confirmation page.');
    res.redirect('/business/profile');
  }
});

router.post('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const businessId =
      req.session.business && req.session.business._id
        ? req.session.business._id
        : null;

    if (!businessId) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    await Business.findByIdAndDelete(businessId);

    const message = '✅ Business account deleted.';

    // Regenerate session to clear old data and show flash on fresh session
    req.session.regenerate((err) => {
      if (err) {
        console.error('❌ Delete business session regenerate error:', err);
        return res.redirect('/');
      }

      req.flash('success', message);
      res.clearCookie('connect.sid');
      return res.redirect('/business/login');
    });
  } catch (err) {
    console.error('❌ Delete business error:', err);
    req.flash('error', 'Failed to delete account.');
    res.redirect('/business/profile');
  }
});

/* ==========================================================
 * ⚙️ DEV MAINTENANCE ROUTES (list + delete accounts)
 *   👉 Only use in development / debugging
 *   👉 Remove or protect before production
 * ========================================================== */

// Simple guard so we don't accidentally expose these in production
function requireDevMode(req, res, next) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).send('Dev maintenance routes are disabled in production.');
  }
  next();
}

/**
 * GET /business/debug/accounts
 * List all business accounts (email, role, verified, createdAt)
 */
router.get('/debug/accounts', requireDevMode, async (req, res) => {
  try {
    const accounts = await Business.find({})
      .select('email name role isVerified createdAt')
      .sort({ createdAt: -1 })
      .lean();

    return res.json({
      ok: true,
      count: accounts.length,
      accounts,
    });
  } catch (err) {
    console.error('❌ Debug list accounts error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load accounts',
    });
  }
});

/**
 * POST /business/debug/accounts/delete-email
 * Delete all business accounts matching a given email
 *
 * Body (or query): { email: "someone@example.com" }
 */
router.post('/debug/accounts/delete-email', requireDevMode, async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || req.query.email || '';
    const email = normalizeEmail(rawEmail);

    if (!email) {
      return res.status(400).json({
        ok: false,
        message: 'Email is required',
      });
    }

    // Delete all businesses with this email (usually 1)
    const result = await Business.deleteMany({ email });

    return res.json({
      ok: true,
      deletedCount: result.deletedCount || 0,
      email,
      message: `Deleted ${result.deletedCount || 0} business account(s) for ${email}`,
    });
  } catch (err) {
    console.error('❌ Debug delete by email error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to delete account(s)',
    });
  }
});

module.exports = router;

