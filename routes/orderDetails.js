// routes/orderDetails.js
'use strict';

console.log('✅ LOADED orderDetails router from:', __filename);

const express = require('express');
const { isValidObjectId } = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product'); // ✅ needed for seller ownership check
const requireAnySession = require('../middleware/requireAnySession');

const router = express.Router();

/* -------------------------------------------------------
   DEV helper
   - In DEV: show real reason with 403 text (so you stop guessing)
   - In PROD: keep your "404 page" behavior (security-friendly)
-------------------------------------------------------- */
const DEV = String(process.env.NODE_ENV || '').toLowerCase() !== 'production';

function deny(req, res, message) {
  // keep nonce safe
  const nonce = res.locals?.nonce || '';
  const base = req.baseUrl || '';
  const url = req.originalUrl || '';

  if (DEV) {
    return res.status(403).type('text').send(
      [
        'Forbidden (DEV explain)',
        `Reason: ${message}`,
        `baseUrl: ${base}`,
        `url: ${url}`,
        `hasUser: ${!!req.session?.user}`,
        `hasBusiness: ${!!req.session?.business}`,
        `hasAdmin: ${!!req.session?.admin}`,
      ].join('\n')
    );
  }

  return res.status(200).render('404', {
    title: 'Order not found',
    nonce,
  });
}

// ✅ quick mount test
router.get('/_ping', (req, res) => {
  return res.json({
    ok: true,
    hit: '/orderDetails/_ping',
    baseUrl: req.baseUrl,
    originalUrl: req.originalUrl,
    hasUser: !!req.session?.user,
    hasBusiness: !!req.session?.business,
    hasAdmin: !!req.session?.admin,
  });
});

/* -------------------------------------------------------
   Router logger (helps you SEE requests reach this router)
-------------------------------------------------------- */
router.use((req, _res, next) => {
  console.log('➡️ orderDetails router saw:', req.method, req.originalUrl, 'baseUrl=', req.baseUrl);
  next();
});

/* -------------------------------------------------------
   Small helpers
-------------------------------------------------------- */
function idVal(x) {
  if (!x) return '';
  if (typeof x === 'string' || typeof x === 'number') return String(x);
  if (x._id) return String(x._id);
  if (x.id) return String(x.id);
  return String(x);
}

function emailVal(x) {
  return String(x || '').trim().toLowerCase();
}

function moneyToNumber(v) {
  // supports: 337.50 OR { value: "337.50", currency: "USD" }
  if (v && typeof v === 'object' && v.value !== undefined) return Number(v.value || 0) || 0;
  return Number(v || 0) || 0;
}

function currencyVal(order) {
  return String(
    (order?.amount && typeof order.amount === 'object' && order.amount.currency) ||
      order?.currency ||
      'USD'
  ).toUpperCase();
}

function normalizeItems(items) {
  const arr = Array.isArray(items) ? items : [];
  return arr.map((it) => {
    const o = { ...(it || {}) };

    // quantity can be qty or quantity
    const qty = Number(o.qty ?? o.quantity ?? 1) || 1;
    o.qty = qty;

    // price can be number OR {value,currency}
    const unit = moneyToNumber(o.price ?? o.unitPrice ?? 0);
    o.price = unit;

    // keep variants safe
    if (!o.variants || typeof o.variants !== 'object') o.variants = o.variants ? { variants: o.variants } : {};
    return o;
  });
}

/* -------------------------------------------------------
   Ownership checks
   - admin: always allowed
   - user: by userId OR email (if your order stores it)
   - business (seller): by order.businessId/sellerId OR by checking products in items
   - business (buyer): only works if you store buyerBusinessId on the Order (recommended)
-------------------------------------------------------- */
function userCanView(req, order) {
  const user = req.session?.user;
  if (!user) return false;

  const userId = idVal(user?._id || user?.id);
  const userEmail = emailVal(user?.email);

  const orderUserId =
    idVal(order.userId) ||
    idVal(order.user) ||
    idVal(order.customerId) ||
    idVal(order.buyerId);

  const orderEmail =
    emailVal(order.email) ||
    emailVal(order.customerEmail) ||
    emailVal(order.userEmail) ||
    emailVal(order?.shipping?.email);

  if (userId && orderUserId && userId === orderUserId) return true;
  if (userEmail && orderEmail && userEmail === orderEmail) return true;

  return false;
}

async function sellerBusinessView(req, order) {
  const biz = req.session?.business;
  if (!biz) return { ok: false, items: [], reason: 'No business session' };

  const bizId = idVal(biz?._id || biz?.id);
  if (!bizId) return { ok: false, items: [], reason: 'Business session has no id' };

  // If the Order already stores seller business id, accept full view
  const orderSellerBizId =
    idVal(order.businessId) ||
    idVal(order.sellerId) ||
    idVal(order.merchantId);

  if (orderSellerBizId && bizId === orderSellerBizId) {
    return { ok: true, items: normalizeItems(order.items), reason: 'Matched order businessId/sellerId/merchantId' };
  }

  // If the Order stores buyerBusinessId and matches, accept full view
  const orderBuyerBizId =
    idVal(order.buyerBusinessId) ||
    idVal(order.buyerBusiness) ||
    idVal(order.buyerBusinessIdRef);

  if (orderBuyerBizId && bizId === orderBuyerBizId) {
    return { ok: true, items: normalizeItems(order.items), reason: 'Matched buyerBusinessId' };
  }

  // Seller ownership by checking Products referenced in order.items
  const items = Array.isArray(order.items) ? order.items : [];
  const ids = items
    .map((it) => String(it?.productId || it?.customId || it?._id || '').trim())
    .filter(Boolean);

  if (!ids.length) return { ok: false, items: [], reason: 'Order has no item product ids' };

  const objIds = [];
  const otherIds = [];

  for (const pid of ids) {
    if (isValidObjectId(pid)) objIds.push(pid);
    else otherIds.push(pid);
  }

  // ✅ broaden product matching:
  // - your order items show productId values like UUIDs, "PROD3", "COOL-...", etc.
  // So we try multiple fields on Product.
  const queryOr = [];
  if (objIds.length) queryOr.push({ _id: { $in: objIds } });

  if (otherIds.length) {
    queryOr.push({ customId: { $in: otherIds } });   // common in your app
    queryOr.push({ productId: { $in: otherIds } });  // if your Product model uses productId
    queryOr.push({ sku: { $in: otherIds } });        // optional
  }

  const products = queryOr.length
    ? await Product.find({ $or: queryOr })
        .select('_id customId productId sku businessId sellerId merchantId')
        .lean()
    : [];

  if (!products.length) {
    return { ok: false, items: [], reason: 'No Product docs matched any item product ids' };
  }

  // index products by multiple identifiers
  const map = new Map();
  for (const p of products) {
    const k1 = p?._id ? String(p._id) : '';
    const k2 = p?.customId ? String(p.customId) : '';
    const k3 = p?.productId ? String(p.productId) : '';
    const k4 = p?.sku ? String(p.sku) : '';

    if (k1) map.set(k1, p);
    if (k2) map.set(k2, p);
    if (k3) map.set(k3, p);
    if (k4) map.set(k4, p);
  }

  const normalized = normalizeItems(order.items);

  const filtered = normalized.filter((it) => {
    const key = String(it?.productId || it?.customId || it?._id || '').trim();
    const p = map.get(key);
    const pBizId = idVal(p?.businessId || p?.sellerId || p?.merchantId);
    return pBizId && pBizId === bizId;
  });

  if (!filtered.length) {
    return {
      ok: false,
      items: [],
      reason: 'Products matched, but none belong to this businessId (ownership mismatch)',
    };
  }

  // Seller can view, but ONLY their items
  return { ok: true, items: filtered, sellerOnly: true, reason: 'Matched by product ownership' };
}

/* -------------------------------------------------------
   GET /orderDetails/:id
   Router is mounted at /orderDetails
-------------------------------------------------------- */
router.get('/:id', requireAnySession, async (req, res) => {
  try {
    const raw = String(req.params.id || '').trim();

    let order = null;

    // find by Mongo _id
    if (isValidObjectId(raw)) {
      order = await Order.findById(raw).lean();
    }

    // fallback: find by PayPal orderId
    if (!order) {
      order = await Order.findOne({ orderId: raw }).lean();
    }

    if (!order) {
      return deny(req, res, `Order not found for id="${raw}" (no _id / orderId match)`);
    }

    // admin shortcut
    if (req.session?.admin) {
      const o = { ...order };
      o.currency = currencyVal(o);
      o.amount = moneyToNumber(o.amount);
      o.items = normalizeItems(o.items);

      return res.render('order-details', {
        title: 'Order Details',
        nonce: res.locals?.nonce || '',
        order: o,
        success: req.flash?.('success') || [],
        error: req.flash?.('error') || [],
      });
    }

    // user view
    if (req.session?.user) {
      if (!userCanView(req, order)) {
        return deny(req, res, 'User session does not match this order (userId/email mismatch)');
      }

      const o = { ...order };
      o.currency = currencyVal(o);
      o.amount = moneyToNumber(o.amount);
      o.items = normalizeItems(o.items);

      return res.render('order-details', {
        title: 'Order Details',
        nonce: res.locals?.nonce || '',
        order: o,
        success: req.flash?.('success') || [],
        error: req.flash?.('error') || [],
      });
    }

    // business view (seller/buyer business)
    const bizView = await sellerBusinessView(req, order);
    if (!bizView.ok) {
      return deny(req, res, `Business cannot view this order: ${bizView.reason || 'unknown reason'}`);
    }

    const o = { ...order };
    o.currency = currencyVal(o);
    o.amount = moneyToNumber(o.amount);
    o.items = bizView.items;

    // optional flags (won’t break your view)
    o._sellerOnly = !!bizView.sellerOnly;
    o._bizReason = bizView.reason || '';

    return res.render('order-details', {
      title: 'Order Details',
      nonce: res.locals?.nonce || '',
      order: o,
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  } catch (err) {
    console.error('❌ /orderDetails/:id error:', err);
    return deny(req, res, `Server error: ${String(err?.message || err)}`);
  }
});

module.exports = router;
