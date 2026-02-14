// routes/businessAuth.js
'use strict';

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
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');
const { sendMail } = require('../utils/mailer');
const mongoose = require('mongoose');
const Order = require('../models/Order');

const router = express.Router();

// Normalize emails (main business email)
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// Normalize PayPal email (same rules as normal email)
function normalizePaypalEmail(v) {
  return String(v || '').trim().replace(/\s+/g, '').toLowerCase();
}

// Loose but safe email check (good enough for PayPal email field)
function isValidEmailLoose(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * ✅ Apply PayPal payouts fields consistently (checkbox + email).
 * Rules:
 * - If payoutsEnabled = false => payouts.enabled=false (email may be kept if valid OR cleared if empty)
 * - If payoutsEnabled = true  => paypalEmail MUST exist + be valid, and payouts.enabled=true
 * - Touch updatedAt only if something actually changed
 *
 * @param {Object} businessDoc Mongoose doc
 * @param {string} paypalEmailRaw raw email input
 * @param {boolean} payoutsEnabled whether checkbox is ON
 */
function applyPaypalPayouts(businessDoc, paypalEmailRaw, payoutsEnabled) {
  const norm = normalizePaypalEmail(paypalEmailRaw);

  businessDoc.payouts = businessDoc.payouts || {};

  const prevEmail = String(businessDoc.payouts.paypalEmail || '').trim().toLowerCase();
  const prevEnabled = Boolean(businessDoc.payouts.enabled);

  const wantEnabled = Boolean(payoutsEnabled);

  // ✅ If checkbox ON -> email required + must be valid
  if (wantEnabled) {
    if (!norm) {
      return { ok: false, error: 'Please enter your PayPal email to enable payouts.' };
    }
    if (!isValidEmailLoose(norm)) {
      return { ok: false, error: 'PayPal email must be a valid email address.' };
    }

    const changed = (prevEmail !== norm) || (prevEnabled !== true);

    businessDoc.payouts.paypalEmail = norm;
    businessDoc.payouts.enabled = true;
    if (changed) businessDoc.payouts.updatedAt = new Date();

    return { ok: true, paypalEmail: norm, enabled: true };
  }

  // ✅ Checkbox OFF -> payouts disabled
  // If they typed an email, validate format (optional), and store it (useful for later enabling)
  if (norm && !isValidEmailLoose(norm)) {
    return { ok: false, error: 'PayPal email must be a valid email address.' };
  }

  // If empty: remove field for cleanliness
  if (!norm) {
    const changed = (prevEnabled !== false) || (prevEmail !== '');
    businessDoc.payouts.paypalEmail = undefined;
    businessDoc.payouts.enabled = false;
    if (changed) businessDoc.payouts.updatedAt = new Date();
    return { ok: true, paypalEmail: null, enabled: false };
  }

  // Checkbox OFF but email provided (store email, keep enabled false)
  const changed = (prevEmail !== norm) || (prevEnabled !== false);

  businessDoc.payouts.paypalEmail = norm;
  businessDoc.payouts.enabled = false;
  if (changed) businessDoc.payouts.updatedAt = new Date();

  return { ok: true, paypalEmail: norm, enabled: false };
}

function pickField(body, dottedPath, fallback = '') {
  // dottedPath example: "representative.fullName"
  const direct = body?.[dottedPath];
  if (direct !== undefined) return String(direct).trim();

  const parts = dottedPath.split('.');
  let cur = body;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return String(fallback).trim();
    cur = cur[p];
  }
  return String(cur ?? fallback).trim();
}

const LOW_STOCK_THRESHOLD = 10;

// -------------------------------------------------------
// ✅ Helper: exclude refunded / canceled orders everywhere
// -------------------------------------------------------
function buildNonRefundedPaidMatch(OrderModel, extra = {}) {
    const RAW_PAID = Array.isArray(OrderModel?.PAID_STATES)
      ? OrderModel.PAID_STATES
      : ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];

    // ✅ include common case variants (Mongo is case-sensitive)
    const PAID_STATES = Array.from(
      new Set(
        RAW_PAID.flatMap((s) => {
          const v = String(s || '').trim();
          if (!v) return [];
          const lower = v.toLowerCase();
          const title = lower.charAt(0).toUpperCase() + lower.slice(1);
          return [v, v.toUpperCase(), v.toLowerCase(), title];
        })
      )
    );

  const CANCEL_STATES = ['Cancelled', 'Canceled', 'CANCELLED', 'CANCELED', 'VOIDED', 'Voided'];

  // Treat these as refunded (so they never count in seller/supplier charts + KPIs)
  const REFUND_STATES = ['Refunded', 'REFUNDED', 'PARTIALLY_REFUNDED', 'Partially Refunded', 'REFUND_SUBMITTED'];

  const REFUND_PAYMENT_STATUSES = [
    'refunded',
    'partially_refunded',
    'refund_submitted',
    'refund_pending',
  ];

  const base = {
    status: { $in: PAID_STATES },

    // ✅ hard excludes
    $and: [
      { status: { $nin: [...CANCEL_STATES, ...REFUND_STATES] } },
      { paymentStatus: { $nin: REFUND_PAYMENT_STATUSES } },

      { isRefunded: { $ne: true } },
      { refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED', 'COMPLETED'] } },

      { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] },
    ],
  };

  // ✅ Merge extra safely (append $and instead of overwriting)
  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const { ...rest } = extra || {};

  const merged = {
    ...base,
    ...rest,
    $and: [...base.$and, ...extraAnd],
  };

  return merged;

}

// -------------------------------------------------------
// Helper: resolve base URL (Render-safe)
// -------------------------------------------------------
function resolveBaseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (env) return env;

  // fallback to current request host
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function getBiz(req) {
  // prefer DB-trusted object set by requireBusiness
  return req.business || req.session?.business || null;
}

function getBizId(req) {
  const b = getBiz(req);
  return b?._id ? String(b._id) : '';
}

// -------------------------------------------------------
// Helper: send business verification email (USES sendMail)
// -------------------------------------------------------
async function sendBusinessVerificationEmail(business, token, req) {
  const baseUrl = resolveBaseUrl(req);
  const verifyUrl = `${baseUrl}/business/verify-email/${encodeURIComponent(token)}`;

  const to = business.email;
  const subject = '✅ Verify your business email - Unicoporate';

  const text = [
    `Hi ${escapeHtml(business.name || 'there')},`,
    '',
    'Please verify your business email to activate your dashboard:',
    verifyUrl,
    '',
    'This link expires in 24 hours.',
    'If you did not create this account, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0F172A;line-height:1.55">
      <h2 style="margin:0 0 8px;color:#7C3AED">Verify your email</h2>
      <p>Hi <strong>${escapeHtml(business.name || 'there')}</strong>,</p>
      <p>Please verify your business email to activate your dashboard.</p>
      <p style="margin:16px 0;">
        <a href="${verifyUrl}"
           style="display:inline-block;padding:12px 16px;background:#2563EB;color:#ffffff;
                  text-decoration:none;border-radius:10px;font-weight:800;font-size:14px;">
          Verify my email →
        </a>
      </p>
      <p style="font-size:12px;color:#64748B">
        Or copy and paste this link:<br/>
        <span style="word-break:break-all">${verifyUrl}</span>
      </p>
      <p style="font-size:12px;color:#64748B">This link expires in 24 hours.</p>
    </div>
  `;

  return sendMail({
    to,
    subject,
    text,
    html,
    replyTo: process.env.SUPPORT_INBOX || undefined,
  });
}

// -------------------------------------------------------
// Helper: send business reset password email (WORKING)
// -------------------------------------------------------
async function sendBusinessResetEmail(business, token, req) {
  const baseUrl = resolveBaseUrl(req);
  const resetUrl = `${baseUrl}/business/password/reset/${encodeURIComponent(token)}`;

  const to = business.email;
  const subject = 'Reset your business password';

  const text = [
    `Hi ${escapeHtml(business.name || 'there')},`,
    '',
    'We received a request to reset the password for your business account.',
    'If you made this request, open the link below to set a new password:',
    resetUrl,
    '',
    'This link will expire in 1 hour.',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0F172A;line-height:1.55">
      <h2 style="margin:0 0 8px;color:#7C3AED">Reset your business password</h2>
      <p>Hi <strong>${escapeHtml(business.name || 'there')}</strong>,</p>
      <p>We received a request to reset the password for your business account.</p>
      <p style="margin:16px 0;">
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 16px;background:#2563EB;color:#ffffff;
                  text-decoration:none;border-radius:10px;font-weight:800;font-size:14px;">
          Reset my password →
        </a>
      </p>
      <p style="font-size:12px;color:#64748B">
        Or copy and paste this link into your browser:<br/>
        <span style="word-break:break-all">${resetUrl}</span>
      </p>
      <p style="font-size:12px;color:#64748B">
        This link will expire in 1 hour. If you did not request this, you can ignore this email.
      </p>
    </div>
  `;

  // ✅ ALWAYS send via your central mailer
  return sendMail({
    to,
    subject,
    text,
    html,
    replyTo: process.env.SUPPORT_INBOX || undefined,
  });
}

// Mask email like p*****i@o*****.com
function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return email;

  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];

  const parts = domain.split('.');
  const domName = parts[0] || '';
  const domRest = parts.slice(1).join('.') || '';

  const maskedDomain =
    domName.length <= 2
      ? (domName[0] || '*') + '*'
      : domName[0] + '*'.repeat(Math.max(1, domName.length - 2)) + domName[domName.length - 1];

  return `${maskedName}@${maskedDomain}${domRest ? '.' + domRest : ''}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------
// Helper: computeSupplierKpis (used by supplier + seller)
// ✅ EXCLUDES refunded/cancelled orders AND refunded items
// ✅ Uses buildNonRefundedPaidMatch(OrderModel, extra) (must exist ONCE above)
// -------------------------------------------------------
async function computeSupplierKpis(businessId) {
  // 1) Load products for this business (supplier/seller)
  const products = await Product.find({ business: businessId })
    .select('stock customId price soldCount name category imageUrl _id')
    .lean();

  const totalProducts = products.length;
  const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
  const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
  const lowStock = products.filter((p) => {
    const s = Number(p.stock) || 0;
    return s > 0 && s <= LOW_STOCK_THRESHOLD;
  }).length;
  const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

  let soldLast30 = 0;
  let revenueLast30 = 0;

  const perProductMap = new Map();

  // Build a quick lookup for product details (avoid products.find in a loop)
  const productIdSet = new Set();
  const productsByKey = new Map();

  for (const p of products) {
    if (p.customId) {
      const k = String(p.customId).trim();
      if (k) {
        productIdSet.add(k);
        productsByKey.set(k, p);
      }
    }
    // also allow matching by _id if your order items store ObjectId strings
    const oid = String(p._id || '').trim();
    if (oid) {
      productIdSet.add(oid);
      productsByKey.set(oid, p);
    }
  }

  const supplierIds = Array.from(productIdSet);

  // Prefer using Order docs for last 30 days
  if (Order && supplierIds.length) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const idMatchOr = [
      { 'items.productId': { $in: supplierIds } },
      { 'items.customId': { $in: supplierIds } },
      { 'items.pid': { $in: supplierIds } },
      { 'items.sku': { $in: supplierIds } },
    ];

    // ✅ Exclude refunded/cancelled orders using the shared helper
    const match = buildNonRefundedPaidMatch(Order, {
      createdAt: { $gte: since },
      $or: idMatchOr,
    });

    const recentOrders = await Order.find(match)
      .select('items amount total createdAt status refundStatus isRefunded refundedAt')
      .lean();

    // Money helpers (handles MoneySchema or number/string)
    const moneyToNumber = (m) => {
      if (!m) return 0;
      if (typeof m === 'number') return m;
      if (typeof m === 'string') return Number(m) || 0;
      if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
      return 0;
    };

    for (const o of recentOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      if (!items.length) continue;

      // ✅ Add revenue ONLY for this business's items that are NOT refunded
      for (const it of items) {
        // ✅ item-level refund skip (safe even if your schema doesn't have these fields)
        if (it && it.isRefunded === true) continue;
        if (String(it?.refundStatus || '').toUpperCase() === 'REFUNDED') continue;

        const pid = String(it.productId ?? it.customId ?? it.pid ?? it.sku ?? '').trim();
        if (!pid) continue;
        if (!productIdSet.has(pid)) continue;

        const qty = Number(it.quantity || 1);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const prod = productsByKey.get(pid) || {};
        const unitPrice = Number(prod.price || moneyToNumber(it.price) || 0);
        const lineRevenue = unitPrice * qty;

        soldLast30 += qty;
        revenueLast30 += lineRevenue;

        if (!perProductMap.has(pid)) {
          perProductMap.set(pid, {
            productId: pid,
            name: prod.name || it.name || '(unknown)',
            imageUrl: prod.imageUrl || '',
            category: prod.category || '',
            price: unitPrice,
            qty: 0,
            estRevenue: 0,
          });
        }

        const stat = perProductMap.get(pid);
        stat.qty += qty;
        stat.estRevenue += lineRevenue;
      }
    }
  }

  // Fallback: lifetime counters on Product (soldCount)
  // NOTE: This cannot perfectly exclude refunds because Product.soldCount is lifetime.
  // Use it only when there are NO recent paid orders at all.
  if (soldLast30 === 0 && revenueLast30 === 0) {
    for (const p of products) {
      const qty = Number(p.soldCount || 0);
      if (!qty) continue;

      const price = Number(p.price || 0);
      soldLast30 += qty;
      revenueLast30 += qty * price;

      const pid = p.customId ? String(p.customId).trim() : String(p._id || '').trim();
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

  const perProduct = Array.from(perProductMap.values()).sort((a, b) => b.qty - a.qty);

  const perProductTotalQty = perProduct.reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
  const perProductEstRevenue = perProduct.reduce((sum, p) => sum + (Number(p.estRevenue) || 0), 0);

  return {
    totalProducts,
    totalStock,
    inStock,
    lowStock,
    outOfStock,
    soldLast30,
    revenueLast30: Number(Number(revenueLast30 || 0).toFixed(2)),
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
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
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

/* ----------------------------------------------------------
 * 🔁 Resend verification email (POST)
 * -------------------------------------------------------- */
router.post('/verify/resend', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId);
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified) {
      req.flash('success', 'Your email is already verified.');
      return res.redirect('/business/dashboard');
    }

    // ✅ 60s cooldown (prevents spam + “refuse” confusion)
    const lastSent = business.verificationEmailSentAt ? new Date(business.verificationEmailSentAt).getTime() : 0;
    const now = Date.now();
    const cooldownMs = 60 * 1000;

    if (lastSent && now - lastSent < cooldownMs) {
      const secs = Math.ceil((cooldownMs - (now - lastSent)) / 1000);
      req.flash('warning', `Please wait ${secs}s before resending another verification email.`);
      return res.redirect('/business/verify-pending');
    }

    const token = crypto.randomBytes(32).toString('hex');
    business.emailVerificationToken = token;
    business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    business.verificationEmailSentAt = new Date();
    await business.save();

    try {
      await sendBusinessVerificationEmail(business, token, req);
      req.flash('success', `A new verification link was sent to ${business.email}.`);
    } catch (mailErr) {
      console.error('❌ Resend verification email failed:', mailErr?.response?.body || mailErr?.message || mailErr);
      req.flash('error', 'Could not send verification email. Please try again later.');
    }

    return res.redirect('/business/verify-pending');
  } catch (err) {
    console.error('❌ verify/resend error:', err);
    req.flash('error', 'Failed to resend verification email.');
    return res.redirect('/business/verify-pending');
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
    business.emailVerifiedAt = new Date();
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
 * ✉️ GET: Change email page
 * -------------------------------------------------------- */
router.get('/change-email', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // If already verified, you can decide what you want.
    // For now: still allow change email (useful if they want to switch).
    return res.render('business-change-email', {
      title: 'Change Email',
      active: 'business-change-email',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ change-email GET error:', err);
    req.flash('error', 'Could not open change email page.');
    return res.redirect('/business/verify-pending');
  }
});

/* ----------------------------------------------------------
 * ✉️ POST: Change email + resend verification
 * -------------------------------------------------------- */
router.post(
  '/change-email',
  requireBusiness,
  [
    body('newEmail').isEmail().withMessage('Please enter a valid email address.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/business/change-email');
    }

    try {
      const bizId = req.session.business?._id;
      const newEmail = String(req.body.newEmail || '').trim().toLowerCase();
      const password = String(req.body.password || '');

      const business = await Business.findById(bizId);
      if (!business) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      // ✅ Check password
      const ok = await bcrypt.compare(password, business.password);
      if (!ok) {
        req.flash('error', 'Incorrect password.');
        return res.redirect('/business/change-email');
      }

      // ✅ No change?
      const currentEmail = String(business.email || '').trim().toLowerCase();
      if (newEmail === currentEmail) {
        req.flash('info', 'That is already your current email.');
        return res.redirect('/business/change-email');
      }

      // ✅ Make sure email isn't taken by another business
      const exists = await Business.findOne({ email: newEmail, _id: { $ne: business._id } }).lean();
      if (exists) {
        req.flash('error', 'That email is already used by another business account.');
        return res.redirect('/business/change-email');
      }

      // ✅ Update email + force re-verify
      const token = crypto.randomBytes(32).toString('hex');
      business.email = newEmail;
      business.isVerified = false;
      business.emailVerificationToken = token;
      business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      business.verificationEmailSentAt = new Date();
      await business.save();

      // ✅ keep session in sync
      if (!req.session.business) req.session.business = {};
      req.session.business.email = business.email;
      req.session.business.isVerified = false;

      // ✅ send verification to the NEW email
      try {
        await sendBusinessVerificationEmail(business, token, req);
        req.flash('success', `Verification email sent to ${business.email}. Please check your inbox.`);
      } catch (mailErr) {
        console.error('❌ Change-email send failed:', mailErr);
        req.flash('error', 'Email updated, but we could not send the verification email. Try Resend.');
      }

      return res.redirect('/business/verify-pending');
    } catch (err) {
      console.error('❌ change-email POST error:', err);
      req.flash('error', 'Failed to change email. Please try again.');
      return res.redirect('/business/change-email');
    }
  },
);

/* ----------------------------------------------------------
 * 📨 POST: Business Signup (with email verification)
 * ✅ Matches your Business schema (payouts sub-schema default)
 * ✅ Uses applyPaypalPayouts(business, paypalEmail, payoutsOn)
 * ✅ Handles Mongo unique email (11000) correctly
 * ✅ FIX: Supports BOTH nested inputs and dotted inputs (representative.fullName)
 * ✅ FIX: Uses the TOP pickField() (so no eslint "unused" / no duplicate function)
 * -------------------------------------------------------- */
router.post(
  '/signup',
  redirectIfLoggedIn,
  [
    body('name').trim().notEmpty().withMessage('Business name is required'),

    body('email')
      .trim()
      .isEmail()
      .withMessage('Valid email is required')
      .bail()
      .normalizeEmail(),

    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),

    body('role')
      .isIn(['seller', 'supplier', 'buyer'])
      .withMessage('Role must be seller, supplier, or buyer'),

    // ✅ Business registration details
    body('officialNumber')
      .trim()
      .notEmpty()
      .withMessage('Business number is required'),

    body('officialNumberType')
      .optional({ checkFalsy: true })
      .isIn(['CIPC_REG', 'VAT', 'TIN', 'OTHER'])
      .withMessage('Business number type is invalid'),

    // Business contact/location
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('country').trim().notEmpty().withMessage('Country name is required'),

    // Shippo-ready business address fields
    body('countryCode')
      .trim()
      .notEmpty()
      .withMessage('Country code is required')
      .bail()
      .isLength({ min: 2, max: 2 })
      .withMessage('Country code must be 2 letters (ISO 2), e.g., ZA, US')
      .bail()
      .customSanitizer((v) => String(v || '').trim().toUpperCase()),

    body('city').trim().notEmpty().withMessage('City is required'),

    body('state')
      .optional({ checkFalsy: true })
      .trim()
      .custom((v, { req }) => {
        const cc = String(req.body.countryCode || '').trim().toUpperCase();
        if (cc === 'US' && !String(v || '').trim()) {
          throw new Error('State is required for US addresses');
        }
        return true;
      }),

    body('postalCode').trim().notEmpty().withMessage('Postal code is required'),

    body('addressLine1').trim().notEmpty().withMessage('Street address (line 1) is required'),

    body('addressLine2').optional({ checkFalsy: true }).trim(),

    // ✅ PayPal email optional but if provided must be valid
    body('paypalEmail')
      .optional({ checkFalsy: true })
      .customSanitizer((v) => String(v || '').trim().replace(/\s+/g, '').toLowerCase())
      .isEmail()
      .withMessage('PayPal email must be a valid email address'),

    // ✅ payoutsEnabled can be "1"/"0" or "on" (checkbox)
    body('payoutsEnabled')
      .optional({ checkFalsy: true })
      .customSanitizer((v) => {
        const s = String(v ?? '').trim().toLowerCase();
        if (s === 'on' || s === 'true') return '1';
        if (s === 'off' || s === 'false') return '0';
        if (s === '1' || s === '0') return s;
        return s;
      })
      .isIn(['0', '1'])
      .withMessage('Invalid payoutsEnabled value'),

    // ✅ Authorized Representative (validator checks dotted name; pickField supports both dotted + nested)
    body('representative.fullName')
      .custom((_, { req }) => {
        const v = pickField(req.body, 'representative.fullName', '');
        if (!v) throw new Error('Authorized representative full name is required');
        return true;
      }),

    body('representative.phone')
      .custom((_, { req }) => {
        const v = pickField(req.body, 'representative.phone', '');
        if (!v) throw new Error('Authorized representative cellphone number is required');
        return true;
      }),

    body('representative.idNumber')
      .custom((_, { req }) => {
        const v = pickField(req.body, 'representative.idNumber', '');
        if (!v) throw new Error('Authorized representative ID number is required');
        return true;
      }),

    // Terms agreement
    body('terms')
      .equals('on')
      .withMessage('You must accept the terms and conditions'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    const renderSignup = (statusCode, extra = {}) => {
      // ✅ rebuild representative object for the EJS even if inputs were dotted
      const repForView = {
        fullName: pickField(req.body, 'representative.fullName', ''),
        phone: pickField(req.body, 'representative.phone', ''),
        idNumber: pickField(req.body, 'representative.idNumber', ''),
      };

      return res.status(statusCode).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,

        errors: extra.errors || (errors.isEmpty() ? [] : errors.array()),

        // preserve submitted values
        ...req.body,
        representative: repForView,

        ...extra,
      });
    };

    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the highlighted errors.');
      return renderSignup(400);
    }

    try {
      const {
        name,
        email,
        password,
        role,
        officialNumber,
        officialNumberType,
        phone,
        countryCode,
        city,
        state,
        postalCode,
        addressLine1,
        addressLine2,
        payoutsEnabled,  // "1"/"0"/"on"
      } = req.body;

      // ✅ pull representative from either dotted or nested style
      const repFullName = pickField(req.body, 'representative.fullName', '');
      const repPhone = pickField(req.body, 'representative.phone', '');
      const repIdNumber = pickField(req.body, 'representative.idNumber', '');

      const emailNorm = normalizeEmail(email);

      // ✅ payouts toggle
      const peRaw = payoutsEnabled;
      const payoutsOn = Array.isArray(peRaw)
        ? peRaw.includes('1') || peRaw.includes('on') || peRaw.includes('true')
        : ['1', 'on', 'true', 'yes'].includes(String(peRaw || '').trim().toLowerCase());

      // ✅ paypalEmail may be missing if the input was disabled on the client
      const paypalFromBodyExists = Object.prototype.hasOwnProperty.call(req.body || {}, 'paypalEmail');
      const paypalEmailRaw = paypalFromBodyExists
        ? String(req.body.paypalEmail || '').trim()
        : '';

      // ✅ quick duplicate check (DB unique index is still the final authority)
      const existing = await Business.findOne({ email: emailNorm }).select('_id').lean();
      if (existing) {
        req.flash('error', 'An account with that email already exists.');
        return renderSignup(409, {
          errors: [{ msg: 'Email already in use', param: 'email' }],
        });
      }

      const hashed = await bcrypt.hash(String(password), 12);

      // ✅ Email verification token + expiry
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // ✅ internal business id
      const internalBusinessId = `BIZ-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

      const business = new Business({
        name: String(name || '').trim(),
        email: emailNorm,
        password: hashed,
        role,

        internalBusinessId,

        officialNumber: String(officialNumber || '').trim(),
        officialNumberType: officialNumberType || 'OTHER',

        phone: String(phone || '').trim(),

        /**
         * ✅ Shippo-ready structured fields
         */
        countryCode: String(countryCode || '').trim().toUpperCase(),
        city: String(city || '').trim(),
        state: String(state || '').trim(),
        postalCode: String(postalCode || '').trim(),
        addressLine1: String(addressLine1 || '').trim(),
        addressLine2: String(addressLine2 || '').trim(),

        /**
         * ✅ Backwards-compatible legacy fields (do NOT break other parts of your app)
         * - country: store ISO2 code
         * - address: combine line1 + line2 for older screens that display business.address
         */
        country: String(req.body.country || '').trim(), // ✅ human readable (legacy)
        address: `${String(addressLine1 || '').trim()}${addressLine2 ? `, ${String(addressLine2).trim()}` : ''}`, // ✅ legacy

        representative: {
          fullName: repFullName,
          phone: repPhone,
          idNumber: repIdNumber,
        },

        // email verification fields
        isVerified: false,
        emailVerificationToken: token,
        emailVerificationExpires: expiry,
        verificationEmailSentAt: new Date(),

        // business verification block
        verification: {
          status: 'pending',
          method: 'manual',
          provider: 'manual',
          updatedAt: new Date(),
        },

        welcomeEmailSentAt: null,
        officialNumberVerifiedEmailSentAt: null,
        officialNumberRejectedEmailSentAt: null,
      });

      // ✅ The ONLY place we set payouts during signup:
      const applied = applyPaypalPayouts(business, paypalEmailRaw, payoutsOn);
      if (!applied || applied.ok !== true) {
        const msg = applied?.error || 'Invalid PayPal email.';
        req.flash('error', msg);
        return renderSignup(400, {
          errors: [{ msg, param: 'paypalEmail' }],
        });
      }

      // ✅ Save with duplicate-key handling for schema unique email
      try {
        await business.save();
      } catch (e) {
        if (e && e.code === 11000 && (e?.keyPattern?.email || e?.keyValue?.email)) {
          req.flash('error', 'An account with that email already exists.');
          return renderSignup(409, {
            errors: [{ msg: 'Email already in use', param: 'email' }],
          });
        }
        throw e;
      }

      // ✅ Session setup (keep payouts in session for immediate UI use)
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: business.isVerified,
        payouts: {
          enabled: business.payouts?.enabled === true,
          paypalEmail: business.payouts?.paypalEmail || '',
        },
      };

      // ✅ Send verification email
      try {
        await sendBusinessVerificationEmail(business, token, req);
        req.flash(
          'success',
          `🎉 Welcome ${business.name}! Check your inbox at ${business.email} to verify your email.`
        );
      } catch (mailErr) {
        console.error(
          '❌ Failed to send business verification email:',
          mailErr?.response?.body || mailErr?.message || mailErr
        );
        req.flash(
          'error',
          'Your account was created but we could not send a verification email. Please use “Resend verification” from the verification page.'
        );
      }

      return res.redirect('/business/verify-pending');
    } catch (err) {
      console.error('❌ Signup error:', err);
      req.flash('error', 'Server error during signup. Please try again.');
      return res.status(500).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        errors: [{ msg: 'Server error' }],
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        ...req.body,
        representative: {
          fullName: pickField(req.body, 'representative.fullName', ''),
          phone: pickField(req.body, 'representative.phone', ''),
          idNumber: pickField(req.body, 'representative.idNumber', ''),
        },
      });
    }
  }
);

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
    console.log('✅ Business login attempt:', { hasSession: !!req.session, hasBiz: !!req.session?.business });
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

      req.session.businessId = business._id.toString();

      // If not verified: resend link + send to verify page
      if (!business.isVerified) {

        const lastSent = business.verificationEmailSentAt
          ? new Date(business.verificationEmailSentAt).getTime()
          : 0;

        const cooldownMs = 60 * 1000;
        if (lastSent && Date.now() - lastSent < cooldownMs) {
          const secs = Math.ceil((cooldownMs - (Date.now() - lastSent)) / 1000);
          req.flash('warning', `Please wait ${secs}s before requesting another verification email.`);
          return req.session.save(() => res.redirect('/business/verify-pending'));
        }

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

        return req.session.save(() => res.redirect('/business/verify-pending'));
      }

      // Already verified
      req.flash('success', `✅ Welcome back, ${business.name}!`);

      // ✅ decide redirect target FIRST
      let redirectTo = '/business/login';
      switch (business.role) {
        case 'seller':
          redirectTo = '/business/dashboards/seller-dashboard';
          break;
        case 'supplier':
          redirectTo = '/business/dashboards/supplier-dashboard';
          break;
        case 'buyer':
          redirectTo = '/business/dashboards/buyer-dashboard';
          break;
        default:
          req.flash('error', 'Invalid business role.');
          redirectTo = '/business/login';
          break;
      }

      // ✅ CRITICAL: SAVE session before redirect so MongoStore persists it
      return req.session.save((err2) => {
        if (err2) {
          console.error('❌ session save error:', err2);
          req.flash('error', 'Login failed. Try again.');
          return res.redirect('/business/login');
        }

        console.log('✅ Business session saved OK:', req.session.business);
        return res.redirect(redirectTo);
      });
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

/* ----------------------------------------------------------
 * 🏦 Bank Details (GET)
 * -------------------------------------------------------- */
router.get('/profile/edit-bank', requireBusiness, async (req, res) => {
  try {
    const businessId = req.business?._id;

    if (!businessId || !mongoose.isValidObjectId(businessId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(businessId)
      .select('name email role bankDetails') // only what this page needs
      .lean();

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    return res.render('business-profile-edit-bank', {
      title: 'Update Bank Details',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ GET /profile/edit-bank error:', err);
    req.flash('error', 'Failed to load bank details page.');
    return res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 🏦 Bank Details (POST)  action="/business/profile/update-bank"
 * -------------------------------------------------------- */
// POST /business/profile/update-bank
router.post('/profile/update-bank', requireBusiness, async (req, res, next) => {
  try {
    const bizId = req.business?._id;
    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // Accept ALL styles:
    // 1) nested: bankDetails[bankName]
    // 2) dotted: bankDetails.bankName
    // 3) flat:   bankName
    const bd = req.body?.bankDetails || {};

    const pick = (key) => {
      const v =
        bd?.[key] ??
        req.body?.[`bankDetails.${key}`] ??
        req.body?.[key] ??
        '';
      return String(v ?? '').trim();
    };

    // Build $set only for non-empty values (prevents wiping saved data)
    const set = {};
    const setIf = (path, val) => {
      if (val !== undefined && val !== null) {
        const s = String(val).trim();
        if (s !== '') set[path] = s;
      }
    };

    // Pull submitted values
    const payoutMethod = pick('payoutMethod') || 'bank';

    const accountHolderName = pick('accountHolderName');
    const bankName = pick('bankName');
    const accountNumber = pick('accountNumber').replace(/\s+/g, '');
    const branchCode = pick('branchCode');
    const accountType = pick('accountType');
    const currency = pick('currency');
    const swiftCode = pick('swiftCode');
    const iban = pick('iban');

    // If payoutMethod=bank, require the basics IF they are trying to use bank payouts
    // (This also prevents saving an invalid bank payout config.)
    if (payoutMethod === 'bank') {
      // If they submitted ANY bank field, enforce required basics
      const submittedAnyBankField = Boolean(
        accountHolderName ||
          bankName ||
          accountNumber ||
          branchCode ||
          accountType ||
          currency ||
          swiftCode ||
          iban
      );

      if (submittedAnyBankField) {
        if (!accountHolderName || !accountNumber) {
          req.flash('error', 'Please enter Account Holder Name and Account Number.');
          return res.redirect('/business/profile/edit-bank');
        }
      }
    }

    // Only set fields that are actually non-empty
    setIf('bankDetails.payoutMethod', payoutMethod);
    setIf('bankDetails.accountHolderName', accountHolderName);
    setIf('bankDetails.bankName', bankName);
    setIf('bankDetails.accountNumber', accountNumber);
    setIf('bankDetails.branchCode', branchCode);
    setIf('bankDetails.accountType', accountType);
    setIf('bankDetails.currency', currency);
    setIf('bankDetails.swiftCode', swiftCode);
    setIf('bankDetails.iban', iban);

    // If NOTHING to update, don’t touch DB
    if (Object.keys(set).length === 0) {
      req.flash('info', 'No changes detected.');
      return res.redirect('/business/profile');
    }

    set['bankDetails.updatedAt'] = new Date();

    await Business.findByIdAndUpdate(bizId, { $set: set }, { new: true });

    req.flash('success', '✅ Bank details updated.');
    return res.redirect('/business/profile');
  } catch (err) {
    return next(err);
  }
});

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
 * SELLER DASHBOARD (NO CHART LOGIC)  ✅ NOW EXCLUDES REFUNDED/CANCELLED
 * -------------------------------------------------------- */
router.get(
  '/dashboards/seller-dashboard',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'seller') {
        req.flash('error', '⛔ Access denied. Seller accounts only.');
        return res.redirect('/business/dashboard');
      }

      const sellerDoc = await Business.findById(getBizId(req)).lean();
      if (!sellerDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      // Extra safety
      if (!sellerDoc.isVerified) {
        req.flash('error', 'Please verify your email to access the seller dashboard.');
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = Order;

      // 1) Products for this seller
      const products = await Product.find({ business: sessionBusiness._id })
        .select('_id customId name price stock category imageUrl createdAt updatedAt')
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      const totalProducts = products.length;
      const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
      const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;

      // keep your seller threshold (<= 5)
      const lowStock = products.filter((p) => {
        const s = Number(p.stock) || 0;
        return s > 0 && s <= 5;
      }).length;

      const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

      // ----------------------------------------------------
      // Build product key maps for order matching (customId + _id)
      // ----------------------------------------------------
      const productsByKey = new Map();
      const sellerCustomIds = [];

      for (const p of products) {
        // customId match
        if (p.customId) {
          const k = String(p.customId).trim();
          if (k) {
            sellerCustomIds.push(k);
            productsByKey.set(k, p);
          }
        }

        // _id match
        const oid = String(p._id || '').trim();
        if (oid) {
          sellerCustomIds.push(oid);
          productsByKey.set(oid, p);
        }
      }

      const sellerKeySet = new Set(sellerCustomIds);

      const hasSellerProducts = sellerKeySet.size > 0;

      const idMatchOr = hasSellerProducts
        ? [
            { 'items.productId': { $in: sellerCustomIds } },
            { 'items.customId': { $in: sellerCustomIds } },
            { 'items.pid': { $in: sellerCustomIds } },
            { 'items.sku': { $in: sellerCustomIds } },
          ]
        : [];

      // 2) Orders (Recent Orders) — ✅ EXCLUDES refunded/cancelled via helper
      let ordersTotal = 0;
      let ordersByStatus = {};
      let recentOrders = [];

      if (OrderModel && hasSellerProducts) {
        const baseOrderMatch = buildNonRefundedPaidMatch(OrderModel, { $or: idMatchOr });

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
          .select('orderId status amount total createdAt shippingTracking')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean();
      }

      // 3) Shipping tracking stats — ✅ EXCLUDES refunded/cancelled via helper
      let trackingStats = {
        pending: 0,
        processing: 0,
        shipped: 0,
        inTransit: 0,
        delivered: 0,
      };

      if (OrderModel && hasSellerProducts) {
        const trackingAgg = await OrderModel.aggregate([
          {
            $match: {
              ...buildNonRefundedPaidMatch(OrderModel),
              $or: [
                { 'items.productId': { $in: sellerCustomIds } },
                { 'items.customId': { $in: sellerCustomIds } },
                { 'items.pid': { $in: sellerCustomIds } },
                { 'items.sku': { $in: sellerCustomIds } },
              ],
            },
          },
          {
            $group: {
              _id: '$shippingTracking.status',
              count: { $sum: 1 },
            },
          },
        ]);

        trackingAgg.forEach((stat) => {
          const status = (stat._id || 'PENDING').toString().toUpperCase();
          if (status === 'PENDING') trackingStats.pending = stat.count;
          else if (status === 'PROCESSING') trackingStats.processing = stat.count;
          else if (status === 'SHIPPED') trackingStats.shipped = stat.count;
          else if (status === 'IN_TRANSIT') trackingStats.inTransit = stat.count;
          else if (status === 'DELIVERED') trackingStats.delivered = stat.count;
        });
      }

      // 4) 30-day KPIs (sold products + revenue) — ✅ EXCLUDES refunded/cancelled via helper
      const SINCE_DAYS = 30;
      const since = new Date();
      since.setDate(since.getDate() - SINCE_DAYS);

      let soldPerProduct = [];
      let soldTotalQty = 0;
      let soldEstRevenue = 0;
      let last30Revenue = 0;
      let last30Items = 0;

      if (OrderModel && hasSellerProducts) {
        const baseMatch = buildNonRefundedPaidMatch(OrderModel, {
          createdAt: { $gte: since },
          $or: idMatchOr,
        });

        const recentOrders30 = await OrderModel.find(baseMatch)
          .select('items createdAt status')
          .lean();

        const productSalesMap = new Map();

        for (const order of recentOrders30) {
          const items = Array.isArray(order.items) ? order.items : [];

          for (const item of items) {
            // ✅ Optional item-level refund skip (safe if fields don't exist)
            if (item && item.isRefunded === true) continue;
            if (String(item?.refundStatus || '').toUpperCase() === 'REFUNDED') continue;

            const productId = String(
              item.productId || item.customId || item.pid || item.sku || '',
            ).trim();

            if (!productId || !sellerKeySet.has(productId)) continue;

            const quantity = Number(item.quantity || 1);
            if (!Number.isFinite(quantity) || quantity <= 0) continue;

            const product = productsByKey.get(productId);
            if (!product) continue;

            const price = Number(product.price || 0);
            const revenue = quantity * price;

            last30Items += quantity;
            last30Revenue += revenue;

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
        }

        soldPerProduct = Array.from(productSalesMap.values()).sort((a, b) => b.qty - a.qty);
        soldTotalQty = last30Items;
        soldEstRevenue = last30Revenue;
      }

      // Optional fallback using computeSupplierKpis (kept as-is)
      if (
        typeof computeSupplierKpis === 'function' &&
        soldPerProduct.length === 0 &&
        hasSellerProducts
      ) {
        try {
          const kpisRaw = await computeSupplierKpis(sessionBusiness._id);
          if (kpisRaw && Array.isArray(kpisRaw.perProduct) && kpisRaw.perProduct.length > 0) {
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

      const deliveryOptions = await DeliveryOption.find({ active: true })
        .sort({ deliveryDays: 1, priceCents: 1 })
        .lean();

      return res.render('dashboards/seller-dashboard', {
        title: 'Seller Dashboard',
        business: sellerDoc,
        totals: { totalProducts, totalStock, inStock, lowStock, outOfStock },
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
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Seller dashboard error:', err);
      req.flash('error', 'Failed to load seller dashboard.');
      return res.redirect('/business/login');
    }
  }
);

/* ----------------------------------------------------------
 * SUPPLIER DASHBOARD (NO CHART LOGIC)
 * ✅ NOW IGNORES refunded/cancelled orders AND refunded items
 * -------------------------------------------------------- */
router.get(
  '/dashboards/supplier-dashboard',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);
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
        req.flash('error', 'Please verify your email to access the supplier dashboard.');
        return res.redirect('/business/verify-pending');
      }

      const OrderModel = Order;

      // ✅ Helper: refunded/cancelled order detector (works even if fields don't exist)
      function isRefundedOrCancelledOrder(o) {
        if (!o) return true;

        // explicit flags
        if (o.isRefunded === true) return true;

        const refundStatus = String(o.refundStatus || '').trim().toUpperCase();
        if (refundStatus === 'REFUNDED' || refundStatus === 'FULL' || refundStatus === 'FULLY_REFUNDED') {
          return true;
        }

        // Some schemas set refundedAt
        if (o.refundedAt) return true;

        // cancellation by status (covers most projects)
        const st = String(o.status || '').trim().toUpperCase();
        if (st === 'CANCELLED' || st === 'CANCELED' || st === 'VOIDED') return true;

        return false;
      }

      // ✅ Helper: refunded item detector (safe if fields don't exist)
      function isRefundedItem(item) {
        if (!item) return false;
        if (item.isRefunded === true) return true;

        const rs = String(item.refundStatus || '').trim().toUpperCase();
        if (rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED') return true;

        if (item.refundedAt) return true;

        return false;
      }

      // ✅ Helper: Convert MoneySchema to number
      function moneyToNumber(m) {
        if (!m) return 0;
        if (typeof m === 'number') return m;
        if (typeof m === 'string') return Number(m) || 0;
        if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
        return 0;
      }

      // 1) Products for this supplier
      const products = await Product.find({ business: sessionBusiness._id })
        .select('customId name price stock category imageUrl createdAt updatedAt')
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      const totalProducts = products.length;
      const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
      const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;

      // keep your threshold (< 20)
      const lowStock = products.filter((p) => {
        const s = Number(p.stock) || 0;
        return s > 0 && s < 20;
      }).length;

      const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

      // inventory value (NOT chart logic)
      const inventoryValue = products.reduce((sum, p) => {
        const price = Number(p.price) || 0;
        const stock = Number(p.stock) || 0;
        return sum + price * stock;
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

      // 2) Recent orders — NOT chart logic
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

        const baseOrderMatch = buildNonRefundedPaidMatch(OrderModel, { $or: idMatchOr });

        // ✅ Pull only minimal fields we need, then filter out refunded/cancelled orders in JS
        const rawForCounts = await OrderModel.find(baseOrderMatch)
          .select('status refundStatus isRefunded refundedAt')
          .lean();

        const nonRefundedOrders = rawForCounts.filter((o) => !isRefundedOrCancelledOrder(o));

        ordersTotal = nonRefundedOrders.length;

        ordersByStatus = nonRefundedOrders.reduce((m, o) => {
          const k = o.status || 'Unknown';
          m[k] = (m[k] || 0) + 1;
          return m;
        }, {});

        // ✅ Recent orders list (also ignore refunded/cancelled)
        const rawRecent = await OrderModel.find(baseOrderMatch)
          .select('orderId status amount createdAt shippingTracking refundStatus isRefunded refundedAt')
          .sort({ createdAt: -1 })
          .limit(20) // fetch extra so we can filter and still show 5
          .lean();

        recentOrders = rawRecent
          .filter((o) => !isRefundedOrCancelledOrder(o))
          .slice(0, 5);
      }

      // 3) Shipping tracking stats — NOT chart logic
      let trackingStats = {
        pending: 0,
        processing: 0,
        shipped: 0,
        inTransit: 0,
        delivered: 0,
      };

      if (OrderModel && allProductIdentifiers.length) {
        const rawForTracking = await OrderModel.find(
          {
            $or: [
              { 'items.productId': { $in: allProductIdentifiers } },
              { 'items.customId': { $in: allProductIdentifiers } },
            ],
          },
          'shippingTracking status refundStatus isRefunded refundedAt'
        ).lean();

        const nonRefundedForTracking = rawForTracking.filter((o) => !isRefundedOrCancelledOrder(o));

        for (const o of nonRefundedForTracking) {
          const status = String(o?.shippingTracking?.status || 'PENDING').toUpperCase();
          if (status === 'PENDING') trackingStats.pending += 1;
          else if (status === 'PROCESSING') trackingStats.processing += 1;
          else if (status === 'SHIPPED') trackingStats.shipped += 1;
          else if (status === 'IN_TRANSIT') trackingStats.inTransit += 1;
          else if (status === 'DELIVERED') trackingStats.delivered += 1;
        }
      }

      // 4) 30-day KPIs (sold products + revenue) — keep (NOT charts)
      const SINCE_DAYS = 30;
      const since = new Date();
      since.setDate(since.getDate() - SINCE_DAYS);

      let soldPerProduct = [];
      let last30Revenue = 0;
      let last30Items = 0;

      if (OrderModel && allProductIdentifiers.length) {
        const PAID_STATES = Array.isArray(OrderModel?.PAID_STATES)
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

        // ✅ We fetch refund fields + item refund fields, then ignore them in JS
        const recentPaidOrdersRaw = await OrderModel.find(baseMatch)
          .select(
            'items amount createdAt status shippingTracking refundStatus isRefunded refundedAt'
          )
          .lean();

        const recentPaidOrders = recentPaidOrdersRaw.filter(
          (o) => !isRefundedOrCancelledOrder(o)
        );

        const productSales = new Map();

        for (const order of recentPaidOrders) {
          const items = Array.isArray(order.items) ? order.items : [];

          for (const item of items) {
            // ✅ ignore refunded items
            if (isRefundedItem(item)) continue;

            let productId = null;
            const possibleIds = [item.productId, item.customId, item.pid, item.sku];

            for (const id of possibleIds) {
              const sid = id ? String(id) : '';
              if (sid && allProductIdentifiers.includes(sid)) {
                productId = sid;
                break;
              }
            }

            if (!productId) continue;

            const product = productsByKey.get(productId);
            if (!product) continue;

            const quantity = Number(item.quantity || 1);
            if (!Number.isFinite(quantity) || quantity <= 0) continue;

            // ✅ price from product OR from item money schema
            const price =
              Number(product.price || 0) ||
              moneyToNumber(item.price) ||
              0;

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

        soldPerProduct = Array.from(productSales.values()).sort((a, b) => b.qty - a.qty);
      }

      // ✅ Fallback to computeSupplierKpis (your UPDATED version should also ignore refunds)
      if (soldPerProduct.length === 0 && last30Items === 0) {
        try {
          const kpisRaw = await computeSupplierKpis(sessionBusiness._id);
          if (kpisRaw) {
            last30Items = kpisRaw.soldLast30 || 0;
            last30Revenue = kpisRaw.revenueLast30 || 0;

            if (Array.isArray(kpisRaw.perProduct) && kpisRaw.perProduct.length > 0) {
              soldPerProduct = kpisRaw.perProduct;
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
        perProduct: soldPerProduct.slice(0, 10),
        perProductTotalQty: last30Items,
        perProductEstRevenue: Number(last30Revenue.toFixed(2)),
      };

      const deliveryOptions = await DeliveryOption.find({ active: true })
        .sort({ deliveryDays: 1, priceCents: 1 })
        .lean();

      const supportInbox = process.env.SUPPORT_INBOX || 'support@unicoporate.test';
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
        inventoryValue,
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
  }
);

/* ----------------------------------------------------------
 * Supplier KPIs JSON for auto-refresh
 * -------------------------------------------------------- */
router.get('/api/supplier/kpis', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);
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
    const business = getBiz(req);
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
 * ✅ Shows refunded/cancelled clearly in table (uiStatus)
 * ✅ KPIs ignore refunded/cancelled (DB-backed)
 * ✅ Shipping stats ignore refunded/cancelled
 * ✅ orderedProducts ignores refunded/cancelled orders + refunded items
 * ✅ demands/matches added (safe defaults)
 * ✅ /business/api/buyer/stats added for auto-refresh
 * -------------------------------------------------------- */

// NOTE: ensure these are imported at top of your file:
// const Business = require('../models/Business');
// const Product = require('../models/Product');
// const requireBusiness = require('../middleware/requireBusiness');

router.get('/dashboards/buyer-dashboard', requireBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
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
      req.flash('error', 'Please verify your email to access the buyer dashboard.');
      return res.redirect('/business/verify-pending');
    }

    const OrderModel = Order;

    // ----------------------------
    // Helpers (order + item)
    // ----------------------------
    function isRefundedOrder(o) {
      if (!o) return false;
      if (o.isRefunded === true) return true;
      if (o.refundedAt) return true;
      const rs = String(o.refundStatus || '').trim().toUpperCase();
      return rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED';
    }

    function isCancelledOrder(o) {
      const st = String(o?.status || '').trim().toUpperCase();
      return st === 'CANCELLED' || st === 'CANCELED' || st === 'VOIDED';
    }

    function isRefundedItem(it) {
      if (!it) return false;
      if (it.isRefunded === true) return true;
      if (it.refundedAt) return true;
      const rs = String(it.refundStatus || '').trim().toUpperCase();
      return rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED';
    }

    // ----------------------------
    // 1) Orders list (KEEP ALL so buyer sees refunded/cancelled)
    // ----------------------------
    const ordersRaw = await OrderModel.find({ businessBuyer: business._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const ordersWithUi = ordersRaw.map((o) => {
      const refunded = isRefundedOrder(o);
      const cancelled = !refunded && isCancelledOrder(o);

      const uiStatus = refunded
        ? 'Refunded'
        : cancelled
        ? 'Cancelled'
        : (o.status || 'Unknown');

      const uiStatusKey = String(uiStatus).toLowerCase().replace(/\s+/g, '-');

      return {
        ...o,
        uiStatus,
        uiStatusKey,
        _isRefunded: refunded,
        _isCancelled: cancelled,
      };
    });

    const activeOrders = ordersWithUi.filter((o) => !o._isRefunded && !o._isCancelled);

    // ----------------------------
    // 2) KPI counts (DB-backed, ignore refunded/cancelled)
    // ----------------------------
    const nonRefundedCancelMatch = {
      businessBuyer: business._id,
      status: { $nin: ['Cancelled', 'CANCELLED', 'Canceled', 'CANCELED', 'Voided', 'VOIDED'] },
      isRefunded: { $ne: true },
      refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] },
      $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }],
    };

    const totalOrders = await OrderModel.countDocuments(nonRefundedCancelMatch);

    const completedOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Completed', 'COMPLETED', 'Delivered', 'DELIVERED'] },
    });

    const pendingOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Pending', 'PENDING', 'Processing', 'PROCESSING', 'PAID', 'Shipped', 'SHIPPED'] },
    });

    const refundedOrders = await OrderModel.countDocuments({
      businessBuyer: business._id,
      $or: [
        { isRefunded: true },
        { refundStatus: { $in: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] } },
        { refundedAt: { $exists: true, $ne: null } },
      ],
    });

    // ----------------------------
    // 3) Shipping stats (ignore refunded/cancelled)
    // ----------------------------
    let shipStats = { inTransit: 0, delivered: 0, processing: 0 };

    // Prefer orderId when present, else fallback to _id
    const activeOrderKeys = activeOrders
      .map((o) => (o.orderId ? { orderId: o.orderId } : { _id: o._id }))
      .filter(Boolean);

    if (activeOrderKeys.length > 0) {
      const matchStage = {
        $match: {
          $or: activeOrderKeys,
        },
      };

      const trackingAgg = await OrderModel.aggregate([
        matchStage,
        { $group: { _id: '$shippingTracking.status', count: { $sum: 1 } } },
      ]);

      for (const r of trackingAgg) {
        const s = String(r._id || '').toUpperCase();
        if (s === 'IN_TRANSIT' || s === 'SHIPPED') shipStats.inTransit += Number(r.count || 0);
        if (s === 'DELIVERED') shipStats.delivered += Number(r.count || 0);
        if (s === 'PROCESSING') shipStats.processing += Number(r.count || 0);
      }
    }

    // ----------------------------
    // 4) Products from orders (ignore refunded/cancelled orders + refunded items)
    // ----------------------------
    const orderedCustomIds = new Set();

    for (const o of activeOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        if (isRefundedItem(it)) continue;

        const pid = it.productId || it.customId || it.pid || it.sku;
        if (pid) orderedCustomIds.add(String(pid));
      }
    }

    let orderedProducts = [];
    if (orderedCustomIds.size > 0) {
      const ids = Array.from(orderedCustomIds);

      orderedProducts = await Product.find({
        $or: [{ customId: { $in: ids } }, { _id: { $in: ids } }],
      })
        .select('customId name price imageUrl category stock')
        .limit(8)
        .lean();
    }

    // ----------------------------
    // 5) Demands + Matches (safe defaults for now)
    // ----------------------------
    // If you already have models later, replace this section with real queries.
    const demands = { active: 0, pendingMatches: 0 };
    const matches = [];

    // ----------------------------
    // 6) Mailer status
    // ----------------------------
    const mailerOk = !!(process.env.SENDGRID_API_KEY || process.env.SMTP_HOST || process.env.SMTP_URL);

    // Table wants 6 items
    const recentOrders = ordersWithUi.slice(0, 6);

    return res.render('dashboards/buyer-dashboard', {
      title: 'Buyer Dashboard',
      business,

      success: req.flash('success'),
      error: req.flash('error'),

      totalOrders,
      completedOrders,
      pendingOrders,
      refundedOrders, // optional KPI

      orders: recentOrders, // includes uiStatus/uiStatusKey/_isRefunded/_isCancelled
      shipStats,
      orderedProducts,

      demands,
      matches,

      mailerOk,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Buyer dashboard error:', err);
    req.flash('error', 'Failed to load buyer dashboard.');
    return res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * BUYER DASHBOARD API (auto-refresh)
 * This matches the EJS refresh script fields exactly.
 * -------------------------------------------------------- */
router.get('/api/buyer/stats', requireBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
    if (!sessionBusiness?._id) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (sessionBusiness.role !== 'buyer') return res.status(403).json({ ok: false, error: 'Forbidden' });

    const business = await Business.findById(sessionBusiness._id).select('_id isVerified').lean();
    if (!business) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!business.isVerified) return res.status(403).json({ ok: false, error: 'Unverified' });

    const OrderModel = Order;

    const nonRefundedCancelMatch = {
      businessBuyer: business._id,
      status: { $nin: ['Cancelled', 'CANCELLED', 'Canceled', 'CANCELED', 'Voided', 'VOIDED'] },
      isRefunded: { $ne: true },
      refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] },
      $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }],
    };

    const totalOrders = await OrderModel.countDocuments(nonRefundedCancelMatch);

    const completedOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Completed', 'COMPLETED', 'Delivered', 'DELIVERED'] },
    });

    const pendingOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Pending', 'PENDING', 'Processing', 'PROCESSING', 'PAID', 'Shipped', 'SHIPPED'] },
    });

    // Shipping stats from active orders (recent window = last 30 days optional)
    // Keep simple: aggregate for the buyer ignoring refunded/cancelled
    const trackingAgg = await OrderModel.aggregate([
      { $match: nonRefundedCancelMatch },
      { $group: { _id: '$shippingTracking.status', count: { $sum: 1 } } },
    ]);

    let delivered = 0;
    let inTransit = 0;
    let processing = 0;

    for (const r of trackingAgg) {
      const s = String(r._id || '').toUpperCase();
      if (s === 'DELIVERED') delivered += Number(r.count || 0);
      if (s === 'IN_TRANSIT' || s === 'SHIPPED') inTransit += Number(r.count || 0);
      if (s === 'PROCESSING') processing += Number(r.count || 0);
    }

    return res.json({
      ok: true,
      totalOrders,
      completedOrders,
      pendingOrders,
      delivered,
      inTransit,
      processing,
    });
  } catch (err) {
    console.error('❌ Buyer stats api error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ----------------------------------------------------------
 * 🧭 GET: Universal Dashboard Redirector
 * -------------------------------------------------------- */
router.get('/dashboard', requireBusiness, (req, res) => {
  const { role } = getBiz(req) || {};
  if (!role) {
    req.flash('error', 'Please log in again.');
    return res.redirect('/business/login');
  }

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

    const business = await Business.findById(getBizId(req));
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
 * 👤 Profile Management  (UPDATED: includes PayPal payouts email)
 * -------------------------------------------------------- */
router.get('/profile', requireBusiness, async (req, res) => {
  try {
    const bizId = req.business?._id;

    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ OWNER VIEW: fetch full doc fields needed for the profile page
    // ❌ do NOT use toSafeJSON() here (it hides bank details by design)
    const business = await Business.findById(bizId)
      .select([
        'name email role phone country city address createdAt',
        'officialNumber officialNumberType',
        'verification isVerified',
        'bankDetails',
        // ✅ PayPal payouts
        'payouts',
      ].join(' '))
      .lean();

    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    // ✅ Mask account number for display (profile page should not show full number)
    const bd = business.bankDetails || {};

    // Try multiple possible saved shapes (old/new)
    const rawAcc = String(
      bd.accountNumber || '' // preferred (unmasked)
    ).replace(/\s+/g, '');

    const maskedFromDb = String(bd.accountNumberMasked || '').trim();
    const last4FromDb = String(bd.accountNumberLast4 || '').trim();

    const last4 =
      rawAcc.length >= 4
        ? rawAcc.slice(-4)
        : (last4FromDb ? last4FromDb.slice(-4) : '');

    // If DB already has a masked value, keep it; otherwise generate it from last4
    const finalMasked =
      maskedFromDb
        ? maskedFromDb
        : (last4 ? `****${last4}` : '—');

    business.bankDetails = {
      ...bd,
      accountNumberLast4: last4 || (last4FromDb ? last4FromDb.slice(-4) : ''),
      accountNumberMasked: finalMasked,
    };

    return res.render('business-profile', {
      title: 'Business Profile',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Business profile error:', err);
    req.flash('error', 'Failed to load profile.');
    return res.redirect('/business/dashboard');
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Business Details ONLY (GET)
 * Renders: views/business-profile-edit-details.ejs
 * URL: /business/profile/edit-details
 * -------------------------------------------------------- */
router.get('/profile/edit-details', requireBusiness, async (req, res) => {
  try {
    const bizId = req.business?._id;
    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // IMPORTANT: do NOT use toSafeJSON() here, because edit form needs real values
    // Also: lean() is fine here (we only need to display data)
    const business = await Business.findById(bizId)
      .select(
        [
          'name email role phone country countryCode city state postalCode addressLine1 addressLine2 address',
          'officialNumber officialNumberType',
          'verification isVerified',
          'payouts',
        ].join(' ')
      )
      .lean();

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // Ensure payouts object exists (matches your schema defaults)
    business.payouts = business.payouts || { enabled: false, paypalEmail: '', updatedAt: null };

    return res.render('business-profile-edit-details', {
      title: 'Edit Business Details',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ GET /business/profile/edit-details error:', err);
    req.flash('error', 'Failed to load business details page.');
    return res.redirect('/business/profile');
  }
});


/* ----------------------------------------------------------
 * 📝 Update Business Details ONLY (POST)
 * action="/business/profile/update-details"
 * Updates ONLY:
 * - name, email, phone, country, city, address
 * - officialNumber, officialNumberType
 * - payouts.enabled + payouts.paypalEmail (via applyPaypalPayouts)
 * -------------------------------------------------------- */
router.post('/profile/update-details', requireBusiness, async (req, res) => {
  try {
    const bizId = String(req.business?._id || '').trim();
    if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
      console.log('✅ HIT POST /business/profile/update-details');
      console.log('BODY:', req.body);
    }

    // Load business doc (this is the single source of truth)
    const business = await Business.findById(bizId).select(
      [
        'name email phone',
        'country countryCode city state postalCode addressLine1 addressLine2 address',
        'officialNumber officialNumberType',
        'payouts verification isVerified',
        'emailVerifiedAt emailVerificationToken emailVerificationExpires verificationEmailSentAt',
      ].join(' ')
    );

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // Use existing values from the loaded doc
    const existingEmail = normalizeEmail(business.email);
    const existingPaypalEmail = String(business?.payouts?.paypalEmail || '').trim();

    // ---- Pick + sanitize (BODY first, fallback to DB so form can still save) ----
    const name = String(req.body?.name ?? business.name ?? '').trim();

    const emailRaw = String(req.body?.email ?? business.email ?? '').trim();
    const email = normalizeEmail(emailRaw);

    const phone = String(req.body?.phone ?? business.phone ?? '').trim();

    // ✅ Human readable (legacy)
    const country = String(req.body?.country ?? business.country ?? '').trim();

    // ✅ Shippo-ready structured fields (fallback to DB values)
    const countryCode = String(req.body?.countryCode ?? business.countryCode ?? '')
      .trim()
      .toUpperCase();

    const city = String(req.body?.city ?? business.city ?? '').trim();
    const state = String(req.body?.state ?? business.state ?? '').trim();
    const postalCode = String(req.body?.postalCode ?? business.postalCode ?? '').trim();

    // Accept BOTH naming styles:
    // - new: addressLine1/addressLine2
    // - EJS: street1/street2
    const addressLine1 = String(
      req.body?.addressLine1 ?? req.body?.street1 ?? business.addressLine1 ?? ''
    ).trim();

    const addressLine2 = String(
      req.body?.addressLine2 ?? req.body?.street2 ?? business.addressLine2 ?? ''
    ).trim();

    // ✅ Legacy combined address
    const address = `${addressLine1}${addressLine2 ? `, ${addressLine2}` : ''}`.trim();

    const officialNumber = String(req.body?.officialNumber ?? business.officialNumber ?? '').trim();
    const officialNumberType = String(req.body?.officialNumberType ?? business.officialNumberType ?? 'OTHER').trim();

    // payoutsEnabled comes as "0", "1", or ["0","1"]
    const peRaw = req.body?.payoutsEnabled;
    const payoutsOn = Array.isArray(peRaw)
      ? peRaw.includes('1') || peRaw.includes('on') || peRaw.includes('true')
      : ['1', 'on', 'true', 'yes'].includes(String(peRaw || '').trim().toLowerCase());

    // paypalEmail may be missing when input is disabled
    const paypalFromBodyExists = Object.prototype.hasOwnProperty.call(req.body || {}, 'paypalEmail');
    const paypalEmailRaw = paypalFromBodyExists
      ? String(req.body.paypalEmail || '').trim()
      : existingPaypalEmail;

    // ---- Required field checks ----
        // ✅ Required (Shippo-ready + legacy)
    if (!name || !email || !phone || !country || !officialNumber) {
      req.flash('error', 'Please fill in all required fields.');
      return res.redirect('/business/profile/edit-details');
    }

    // ✅ Shippo-ready required fields
    if (!countryCode || countryCode.length !== 2) {
      req.flash('error', 'Country code must be 2 letters (ISO 2), e.g., ZA, US.');
      return res.redirect('/business/profile/edit-details');
    }

    if (!city || !postalCode || !addressLine1) {
      req.flash('error', 'Please fill in your City, Postal Code, and Address Line 1.');
      return res.redirect('/business/profile/edit-details');
    }

    // ✅ Same rule as /signup
    if (countryCode === 'US' && !state) {
      req.flash('error', 'State is required for US addresses.');
      return res.redirect('/business/profile/edit-details');
    }

    // ---- Validate officialNumberType ----
    const allowedTypes = ['CIPC_REG', 'VAT', 'TIN', 'OTHER'];
    if (!allowedTypes.includes(officialNumberType)) {
      req.flash('error', 'Invalid official number type.');
      return res.redirect('/business/profile/edit-details');
    }

    // ---- Email uniqueness if changed ----
    const emailChanged = email !== existingEmail;

    if (emailChanged) {
      const exists = await Business.findOne({ email, _id: { $ne: bizId } }).lean();
      if (exists) {
        req.flash('error', 'That email is already used by another business account.');
        return res.redirect('/business/profile/edit-details');
      }
    }

    // ---- Official number change => reset verification status ----
    const currentOfficial = String(business.officialNumber || '').trim();
    const officialChanged = officialNumber !== currentOfficial;

    // ---- PayPal payouts: use the SAME helper as /signup ----
    const applied = applyPaypalPayouts(business, paypalEmailRaw, payoutsOn);
    if (!applied || applied.ok !== true) {
      req.flash('error', applied?.error || 'Invalid PayPal payouts settings.');
      return res.redirect('/business/profile/edit-details');
    }

    // ---- Apply allowed fields on the doc ----
    business.name = name;
    business.phone = phone;

    // ✅ Shippo-ready structured address (single source of truth for shipping)
    business.countryCode = countryCode;
    business.city = city;
    business.state = state; // may be empty for non-US
    business.postalCode = postalCode;
    business.addressLine1 = addressLine1;
    business.addressLine2 = addressLine2;

    // ✅ Legacy fields (do NOT break other pages)
    business.country = country; // human readable legacy
    business.address = address; // combined legacy

    business.officialNumber = officialNumber;
    business.officialNumberType = officialNumberType;

    // ---- If email changed: require re-verify + set token (DECLARE ONCE) ----
    let token = null;
    if (emailChanged) {
      token = crypto.randomBytes(32).toString('hex');
      business.email = email;

      business.isVerified = false;
      business.emailVerifiedAt = null;

      business.emailVerificationToken = token;
      business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      business.verificationEmailSentAt = new Date();
    }

    // ---- Official number change => reset verification status ----
    if (officialChanged) {
      business.verification = business.verification || {};
      business.verification.status = 'pending';
      business.verification.reason = '';
      business.verification.updatedAt = new Date();
    }

    // Save
    await business.save();

    // ---- Keep session in sync ----
    if (!req.session.business) req.session.business = {};

    req.session.business.name = business.name;
    req.session.business.email = business.email;
    req.session.business.phone = business.phone || '';
    req.session.business.isVerified = business.isVerified;
    req.session.business.payouts = {
      enabled: business.payouts?.enabled === true,
      paypalEmail: business.payouts?.paypalEmail || '',
    };

    // ✅ keep address fields in session too (prevents “old profile data” issues)
    req.session.business.country = business.country || '';
    req.session.business.countryCode = business.countryCode || '';
    req.session.business.city = business.city || '';
    req.session.business.state = business.state || '';
    req.session.business.postalCode = business.postalCode || '';
    req.session.business.addressLine1 = business.addressLine1 || '';
    req.session.business.addressLine2 = business.addressLine2 || '';
    req.session.business.address = business.address || '';

    // ---- If email changed, send verification mail ----
    if (emailChanged) {
      try {
        await sendBusinessVerificationEmail(business, token, req);
        req.flash('success', '✅ Details saved. Please verify your new email address.');
      } catch (mailErr) {
        console.error(
          '❌ send verification after email change failed:',
          mailErr?.response?.body || mailErr?.message || mailErr
        );
        req.flash(
          'warning',
          'Details saved, but we could not send the verification email. Use “Resend verification”.'
        );
      }
      return res.redirect('/business/verify-pending');
    }

    req.flash('success', '✅ Business details updated.');
    return res.redirect('/business/profile');
  } catch (err) {
    console.error('❌ POST /business/profile/update-details error:', err);
    req.flash('error', err?.message || 'Failed to update business details.');
    return res.redirect('/business/profile/edit-details');
  }
});

/* ----------------------------------------------------------
 * 🗑️ Delete Profile
 * -------------------------------------------------------- */
router.get('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    return res.render('business-delete', {
      title: 'Delete Business Account',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      verificationToken: '',
      csrfToken: req.csrfToken ? req.csrfToken() : '',

      // ✅ so the page can show messages
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error('❌ Delete profile render error:', err);
    req.flash('error', 'Failed to load delete confirmation page.');
    return res.redirect('/business/profile');
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

    // ✅ NEW: stop deletion if business still has products
    const hasProducts = await Product.exists({ business: businessId });
    if (hasProducts) {
      req.flash(
        'error',
        'Deletion failed: your account still have products. If you really want to delete this account you must go to your dashboard delete its product first here: /products/all'
      );
      return res.redirect('/business/profile/delete');
    }

    const password = String(req.body.password || '').trim();
    if (!password) {
      req.flash('error', 'Please enter your password to confirm deletion.');
      return res.redirect('/business/profile/delete');
    }

    // Load business + password hash (your schema might have select:false)
    const business = await Business.findById(businessId).select('+password');
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    const bcrypt = require('bcrypt');
    const ok = await bcrypt.compare(password, String(business.password || ''));
    if (!ok) {
      req.flash('error', 'Incorrect password. Deletion cancelled.');
      return res.redirect('/business/profile/delete');
    }

    await Business.findByIdAndDelete(businessId);

    const message = '✅ Business account deleted.';

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
    return res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 📊 ANALYTICS CHART DASHBOARD (per business)
 * -------------------------------------------------------- */

router.get(
  '/analytics/chart',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);
      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      const business = await Business.findById(sessionBusiness._id).lean();
      if (!business) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      const activeProducts = await Product.countDocuments({
        business: business._id,
        stock: { $gt: 0 },
      });

      res.render('business-chart', {
        title: `${business.name} - Analytics Dashboard`,
        business: {
          ...business,
          activeProducts,
        },
        active: 'analytics',
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Analytics chart dashboard error:', err);
      req.flash('error', 'Failed to load analytics dashboard.');
      res.redirect('/business/dashboard');
    }
  }
);

// ----------------------------------------------------------
// 📊 ANALYTICS CHART DATA API (per business only)
// ✅ IGNORES refunded/cancelled orders AND refunded items
// ✅ Uses buildNonRefundedPaidMatch(OrderModel, extra) that exists ONCE above
// ----------------------------------------------------------
router.get(
  '/analytics/chart-data',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);
      if (!sessionBusiness || !sessionBusiness._id) {
        return res.status(401).json({ success: false, message: 'Unauthorized' });
      }

      const OrderModel = Order;
      if (!OrderModel) {
        return res.status(500).json({ success: false, message: 'Order model not available' });
      }

      const businessId = sessionBusiness._id;
      const now = new Date();

      // ----------------------------
      // 1) Load THIS business products
      // ----------------------------
      const products = await Product.find({ business: businessId })
        .select('customId name price stock soldCount _id')
        .lean();

      // Build keys set (supports BOTH customId and _id matching)
      const productKeys = products
        .flatMap((p) => {
          const keys = [];
          if (p?.customId) keys.push(String(p.customId).trim());
          if (p?._id) keys.push(String(p._id).trim());
          return keys;
        })
        .filter(Boolean);

      const productKeySet = new Set(productKeys);

      // Active products count (stock > 0)
      const activeProducts = products.filter((p) => (Number(p.stock) || 0) > 0).length;

      // Price lookup map for fast revenue calculation
      const productPriceByKey = new Map();
      for (const p of products) {
        const price = Number(p?.price || 0) || 0;
        if (p?.customId) productPriceByKey.set(String(p.customId).trim(), price);
        if (p?._id) productPriceByKey.set(String(p._id).trim(), price);
      }

      // If no products, return zero chart
      if (productKeys.length === 0) {
        const dailyData = [];
        const monthlyData = [];
        const yearlyData = [];

        for (let i = 6; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          dailyData.push({
            date: d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }),
            sales: 0,
            orders: 0,
          });
        }

        for (let i = 29; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(d.getDate() - i);
          monthlyData.push({
            date: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
            sales: 0,
            orders: 0,
          });
        }

        for (let i = 11; i >= 0; i--) {
          const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
          yearlyData.push({
            month: m.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }),
            sales: 0,
            orders: 0,
          });
        }

        return res.json({
          success: true,
          chartData: { daily: dailyData, monthly: monthlyData, yearly: yearlyData, custom: [] },
          metrics: {
            totalRevenue: 0,
            totalOrders: 0,
            avgOrderValue: 0,
            activeProducts,
            revenueChange: 0,
            ordersChange: 0,
            avgOrderChange: 0,
          },
          productPerformance: [],
          lastUpdated: new Date().toISOString(),
        });
      }

      // ----------------------------
      // 2) Helpers
      // ----------------------------
      const idMatchOr = [
        { 'items.productId': { $in: productKeys } },
        { 'items.customId': { $in: productKeys } },
        { 'items.pid': { $in: productKeys } },
        { 'items.sku': { $in: productKeys } },
      ];

      function moneyToNumber(m) {
        if (!m) return 0;
        if (typeof m === 'number') return m;
        if (typeof m === 'string') return Number(m) || 0;
        if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
        return 0;
      }

      function isRefundedItem(item) {
        if (!item) return false;
        if (item.isRefunded === true) return true;

        const rs = String(item.refundStatus || '').trim().toUpperCase();
        if (rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED' || rs === 'COMPLETED')
          return true;

        if (item.refundedAt) return true;
        return false;
      }

      // revenue for THIS business from an order (ignore refunded items)
      function computeSellerAmount(order) {
        let sellerAmount = 0;
        if (!Array.isArray(order.items)) return 0;

        for (const item of order.items) {
          if (isRefundedItem(item)) continue;

          const pid = String(item.productId || item.customId || item.pid || item.sku || '').trim();
          if (!pid || !productKeySet.has(pid)) continue;

          const qty = Number(item.quantity || 1);
          if (!Number.isFinite(qty) || qty <= 0) continue;

          const unitFromItem = moneyToNumber(item.price);
          const unitFromProduct = productPriceByKey.get(pid) || 0;

          const unit = unitFromItem || unitFromProduct;
          const line = qty * unit;

          if (line > 0) sellerAmount += line;
        }

        return sellerAmount;
      }

      // Use your shared refund/cancel exclusion helper
      function buildBaseMatch(extra = {}) {
        return buildNonRefundedPaidMatch(OrderModel, {
          ...extra,
          $or: idMatchOr,
        });
      }

      // Date keys (UTC-based, stable)
      const dayKey = (d) => new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
      const monthKey = (d) => new Date(d).toISOString().slice(0, 7); // YYYY-MM

      // ----------------------------
      // 3) Pull orders ONCE for last 30 days (covers daily + monthly)
      // ----------------------------
      const start30 = new Date(now);
      start30.setDate(start30.getDate() - 29);
      start30.setHours(0, 0, 0, 0);

      const orders30 = await OrderModel.find(buildBaseMatch({ createdAt: { $gte: start30 } }))
        .select('createdAt items status refundStatus isRefunded refundedAt')
        .lean();

      const salesByDay = new Map();   // YYYY-MM-DD -> { sales, orders }
      for (const o of orders30) {
        const amt = computeSellerAmount(o);
        if (amt <= 0) continue; // if all items refunded, don’t count order

        const k = dayKey(o.createdAt || now);
        const cur = salesByDay.get(k) || { sales: 0, orders: 0 };
        cur.sales += amt;
        cur.orders += 1;
        salesByDay.set(k, cur);
      }

      // Build monthlyData (last 30 days)
      const monthlyData = [];
      for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const k = dayKey(d);
        const v = salesByDay.get(k) || { sales: 0, orders: 0 };

        monthlyData.push({
          date: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
          sales: Math.round((v.sales || 0) * 100) / 100,
          orders: Number(v.orders || 0),
        });
      }

      // Build dailyData (last 7 days)
      const dailyData = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const k = dayKey(d);
        const v = salesByDay.get(k) || { sales: 0, orders: 0 };

        dailyData.push({
          date: d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }),
          sales: Math.round((v.sales || 0) * 100) / 100,
          orders: Number(v.orders || 0),
        });
      }

      // ----------------------------
      // 4) Pull orders ONCE for last 12 months (yearly)
      // ----------------------------
      const start12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
      start12.setHours(0, 0, 0, 0);

      const orders12 = await OrderModel.find(buildBaseMatch({ createdAt: { $gte: start12 } }))
        .select('createdAt items status refundStatus isRefunded refundedAt')
        .lean();

      const salesByMonth = new Map(); // YYYY-MM -> { sales, orders }
      for (const o of orders12) {
        const amt = computeSellerAmount(o);
        if (amt <= 0) continue;

        const k = monthKey(o.createdAt || now);
        const cur = salesByMonth.get(k) || { sales: 0, orders: 0 };
        cur.sales += amt;
        cur.orders += 1;
        salesByMonth.set(k, cur);
      }

      const yearlyData = [];
      for (let i = 11; i >= 0; i--) {
        const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const k = monthKey(m);
        const v = salesByMonth.get(k) || { sales: 0, orders: 0 };

        yearlyData.push({
          month: m.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }),
          sales: Math.round((v.sales || 0) * 100) / 100,
          orders: Number(v.orders || 0),
        });
      }

      // ----------------------------
      // 5) Metrics
      // ----------------------------
      const totalRevenue = yearlyData.reduce((sum, m) => sum + (Number(m.sales) || 0), 0);
      const totalOrders = yearlyData.reduce((sum, m) => sum + (Number(m.orders) || 0), 0);
      const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

      const lastIdx = yearlyData.length - 1;
      const prevIdx = lastIdx - 1;

      const currentMonthRevenue = lastIdx >= 0 ? yearlyData[lastIdx].sales : 0;
      const previousMonthRevenue = prevIdx >= 0 ? yearlyData[prevIdx].sales : 0;

      const revenueChange =
        previousMonthRevenue > 0
          ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100
          : 0;

      const currentMonthOrders = lastIdx >= 0 ? yearlyData[lastIdx].orders : 0;
      const previousMonthOrders = prevIdx >= 0 ? yearlyData[prevIdx].orders : 0;

      const ordersChange =
        previousMonthOrders > 0
          ? ((currentMonthOrders - previousMonthOrders) / previousMonthOrders) * 100
          : 0;

      const currentAvg = currentMonthOrders > 0 ? currentMonthRevenue / currentMonthOrders : 0;
      const previousAvg = previousMonthOrders > 0 ? previousMonthRevenue / previousMonthOrders : 0;

      const avgOrderChange = previousAvg > 0 ? ((currentAvg - previousAvg) / previousAvg) * 100 : 0;

      // ----------------------------
      // 6) Product performance (top 5) - same behavior as before
      // ----------------------------
      const productPerformance = [];

      if (products.length > 0) {
        const topProducts = products
          .filter((p) => (p.soldCount || 0) > 0)
          .sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0))
          .slice(0, 5);

        if (topProducts.length > 0) {
          topProducts.forEach((product) => {
            const nm = String(product.name || '');
            const name = nm.length > 15 ? nm.substring(0, 15) + '...' : nm;
            productPerformance.push({ name, sales: product.soldCount || 0 });
          });
        } else {
          const inStockProducts = products
            .filter((p) => (Number(p.stock) || 0) > 0)
            .sort((a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0))
            .slice(0, 5);

          if (inStockProducts.length > 0) {
            inStockProducts.forEach((product) => {
              const nm = String(product.name || '');
              const name = nm.length > 15 ? nm.substring(0, 15) + '...' : nm;
              productPerformance.push({ name, sales: Number(product.stock) || 0 });
            });
          } else {
            productPerformance.push(
              { name: 'No products yet', sales: 1 },
              { name: 'Add products', sales: 1 }
            );
          }
        }
      }

      // Final response
      return res.json({
        success: true,
        chartData: { daily: dailyData, monthly: monthlyData, yearly: yearlyData, custom: [] },
        metrics: {
          totalRevenue: Math.round(totalRevenue * 100) / 100,
          totalOrders,
          avgOrderValue: Math.round(avgOrderValue * 100) / 100,
          activeProducts,
          revenueChange: Math.round(revenueChange * 10) / 10,
          ordersChange: Math.round(ordersChange * 10) / 10,
          avgOrderChange: Math.round(avgOrderChange * 10) / 10,
        },
        productPerformance,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      console.error('❌ Chart data API error:', error);
      return res.status(500).json({
        success: false,
        message: 'Failed to fetch chart data',
        error: error.message,
      });
    }
  }
);

router.get('/_ping', (req, res) => res.send('business router OK'));


module.exports = router;


