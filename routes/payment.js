// routes/payment.js
'use strict';

const express = require('express');
const router = express.Router();
const { fetch } = require('undici');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { creditSellersFromOrder } = require('../utils/payouts/creditSellersFromOrder');

// ======================================================
// ✅ Admin guard (PROD SAFE)
// ======================================================
let requireAdmin = null;
try {
  requireAdmin = require('../middleware/requireAdmin');
} catch {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error(
      'Missing middleware/requireAdmin in production. Fix path or deploy build. Refusing to start.'
    );
  }
  // DEV fallback only
  requireAdmin = (req, res, next) => {
    if (req.session?.admin) return next();
    return res.status(401).json({ ok: false, message: 'Unauthorized (admin only).' });
  };
}

// ======================================================
// ✅ Optional helpers/models
// ======================================================
let debitSellersFromRefund = null;
try {
  ({ debitSellersFromRefund } = require('../utils/payouts/debitSellersFromRefund'));
} catch {
  // optional
}

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  Order = null;
}

let Product = null;
try {
  Product = require('../models/Product');
} catch {
  Product = null;
}

let Business = null;
try {
  Business = require('../models/Business');
} catch {
  Business = null;
}

let buildShippoAddressFromBusiness = null;
try {
  ({ buildShippoAddressFromBusiness } = require('../utils/shippo/buildShippoAddressFromBusiness'));
} catch {
  buildShippoAddressFromBusiness = null;
}

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
  BASE_CURRENCY = 'USD',
  VAT_RATE = '0.15',
  BRAND_NAME = 'Unicoporate',
  RECEIPT_TOKEN_SECRET = '', // optional (shareable receipt links)
} = process.env;

// ✅ Normalize + validate (so Render env changes are safe)
const PAYPAL_MODE_N = (() => {
  const m = String(PAYPAL_MODE || 'sandbox').trim().toLowerCase();
  return m === 'live' ? 'live' : 'sandbox'; // fallback to sandbox on typos
})();

const PP_API =
  PAYPAL_MODE_N === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const upperCcy = (() => {
  const c = String(BASE_CURRENCY || 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : 'USD'; // fallback to USD if invalid
})();

const vatRate = (() => {
  const n = Number(String(VAT_RATE || '0.15').trim());
  if (!Number.isFinite(n)) return 0.15;
  return Math.max(0, Math.min(1, n)); // clamp 0..1
})();

const BRAND_NAME_N = (() => {
  const s = String(BRAND_NAME || 'Unicoporate').trim();
  return s.slice(0, 127) || 'Unicoporate'; // PayPal brand_name length safety
})();

const PLATFORM_FEE_BPS = (() => {
  const n = Number(process.env.PLATFORM_FEE_BPS || 1300); // default 13%
  if (!Number.isFinite(n)) return 1300;
  return Math.max(0, Math.min(5000, Math.round(n))); // clamp 0%..50% safety
})();

// ======================================================
// ✅ Origin protection for cookie-session JSON endpoints (anti-CSRF)
// ======================================================
function normalizeOrigin(s) {
  return String(s || '').trim().replace(/\/$/, '').toLowerCase();
}

// ✅ Single source of truth: WEB_ORIGINS env
// Example:
// WEB_ORIGINS="https://unicoporate.com,https://www.unicoporate.com"
const ALLOWED_ORIGINS = String(process.env.WEB_ORIGINS || '')
  .split(',')
  .map(normalizeOrigin)
  .filter(Boolean);

function requireAllowedOriginJson(req, res, next) {
  const method = String(req.method || '').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
  if (!isProd) return next();

  if (!ALLOWED_ORIGINS.length) {
    return res.status(500).json({
      ok: false,
      code: 'WEB_ORIGINS_NOT_SET',
      message: 'Server misconfiguration: WEB_ORIGINS must be set in production.',
    });
  }

  // ✅ Prefer Origin; fallback to Referer (some browsers/proxies strip Origin)
  const origin = normalizeOrigin(req.headers.origin);
  const referer = normalizeOrigin(req.headers.referer);

  if (!origin && !referer) {
    return res.status(403).json({
      ok: false,
      code: 'ORIGIN_MISSING',
      message: 'Missing Origin/Referer.',
    });
  }

  const ok =
    (origin && ALLOWED_ORIGINS.includes(origin)) ||
    (referer && ALLOWED_ORIGINS.some((o) => referer.startsWith(o)));

  if (!ok) {
    const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
    return res.status(403).json({
      ok: false,
      code: 'ORIGIN_BLOCKED',
      message: 'Blocked request from untrusted origin.',
      ...(isProd
        ? {}
        : {
            debug: {
              origin: req.headers.origin || null,
              referer: req.headers.referer || null,
              allowed: ALLOWED_ORIGINS,
            },
          }),
    });
  }

  return next();
}

// ======================================================
// ✅ AUTH helpers (everyone can buy; everyone sees ONLY own orders)
// ======================================================
function getUserId(req) {
  return req.user?._id || req.session?.user?._id || req.session?.userId || null;
}
function getBusinessId(req) {
  return req.session?.business?._id || req.session?.businessId || null;
}
function isAnyLoggedIn(req) {
  return !!(req.session?.admin || getUserId(req) || getBusinessId(req));
}
function requireAnyAuth(req, res, next) {
  if (isAnyLoggedIn(req)) return next();
  try {
    req.flash?.('error', 'Please login first.');
  } catch {
    // placeholding
  }
  return res.redirect('/users/login');
}

function requireAnyAuthJson(req, res, next) {
  if (isAnyLoggedIn(req)) return next();
  return res.status(401).json({ ok: false, code: 'AUTH_REQUIRED', message: 'Login required.' });
}

function cartSig(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const parts = items.map((it) => {
    const id = String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim();
    const qty = toQty(it?.qty ?? it?.quantity, 1);
    return `${id}:${qty}`;
  });
  parts.sort();
  return parts.join('|');
}

// ======================================================
// ✅ Small helpers
// ======================================================
function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}
function themeCssFrom(req) {
  return req.session?.theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}
function safeStr(v, max = 2000) {
  return String(v || '').trim().slice(0, max);
}

function normalizeMoneyNumber(v) {
  if (v === null || v === undefined || v === '') return null;

  // ✅ handle { value, amount } objects
  if (typeof v === 'object') {
    const inner = v.value ?? v.amount ?? v.price ?? null;
    if (inner === null || inner === undefined || inner === '') return null;
    const n2 = Number(String(inner).trim());
    return Number.isFinite(n2) ? n2 : null;
  }

  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toMoney2(v, fallback = '0.00') {
  const n = normalizeMoneyNumber(v);
  if (n === null) return fallback;
  return n.toFixed(2);
}
function toQty(v, fallback = 1) {
  const n = normalizeMoneyNumber(v);
  if (n === null) return fallback;
  const q = Math.floor(n);
  return q >= 1 ? q : fallback;
}
function safeMoneyString(v, max = 32) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, max);
  return s ? s : null;
}
function saveSession(req) {
  return new Promise((resolve) => {
    if (req.session && typeof req.session.save === 'function') req.session.save(() => resolve());
    else resolve();
  });
}

function asIdVariants(id) {
  const s = String(id || '').trim();
  const out = [];
  if (s) out.push(s);
  if (mongoose?.Types?.ObjectId?.isValid?.(s)) out.push(new mongoose.Types.ObjectId(s));
  return out;
}

function normalizeCountryCode(code) {
  const c = String(code || '').trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

function cleanAddrField(v, max = 100) {
  const s = String(v || '').trim();
  return s ? s.slice(0, max) : '';
}

function _normCmp(v) {
  return String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
function shippoToFromShippingInput(shippingInput) {
  // shippingInput is from requireShippingAddressFromBody()
  return {
    name: shippingInput.fullName,
    phone: shippingInput.phone,
    email: shippingInput.email,
    street1: shippingInput.address.address_line_1,
    street2: shippingInput.address.address_line_2 || '',
    city: shippingInput.address.admin_area_2,
    state: shippingInput.address.admin_area_1,
    zip: shippingInput.address.postal_code,
    country: shippingInput.address.country_code,
  };
}

function sameShippoTo(a, b) {
  if (!a || !b) return false;
  return (
    _normCmp(a.street1) === _normCmp(b.street1) &&
    _normCmp(a.street2 || '') === _normCmp(b.street2 || '') &&
    _normCmp(a.city) === _normCmp(b.city) &&
    _normCmp(a.state) === _normCmp(b.state) &&
    _normCmp(a.zip) === _normCmp(b.zip) &&
    _normCmp(a.country) === _normCmp(b.country)
  );
}

function _shippoToFromOrderShipping(orderShipping) {
  const s = orderShipping || {};
  return {
    name: cleanAddrField(s.name || s.fullName || 'Customer', 120),
    phone: cleanAddrField(s.phone || '', 40),
    email: cleanAddrField(s.email || '', 140),
    street1: cleanAddrField(s.address_line_1 || s.street1 || '', 300),
    street2: cleanAddrField(s.address_line_2 || s.street2 || '', 300),
    city: cleanAddrField(s.admin_area_2 || s.city || '', 120),
    state: cleanAddrField(s.admin_area_1 || s.state || '', 120),
    zip: cleanAddrField(s.postal_code || s.zip || '', 60),
    country: normalizeCountryCode(s.country_code || s.country) || '',
  };
}

function _cartFromOrderDoc(orderDoc) {
  const items = Array.isArray(orderDoc?.items) ? orderDoc.items : [];
  return {
    items: items.map((it) => ({
      name: it?.name || 'Item',
      qty: toQty(it?.quantity ?? it?.qty, 1),
      // use gross if available; else fall back
      price:
        it?.priceGross?.value ??
        it?.price?.value ??
        it?.price ??
        it?.unitPrice ??
        0,
    })),
  };
}

function requireShippingAddressFromBody(req) {
  // Accept:
  // 1) req.body.shipping = PayPal-ish keys
  // 2) req.body.shipTo   = your checkout.ejs keys
  // 3) flat fields (fallback)
  const b = req.body || {};

  const s =
    (b.shipping && typeof b.shipping === 'object' && b.shipping) ||
    (b.shipTo && typeof b.shipTo === 'object' && b.shipTo) ||
    b;

  // shipTo fields:
  //  name, phone, email, street1, street2, city, state, zip, country
  // shipping fields:
  //  fullName/name, address_line_1/line1, address_line_2/line2, admin_area_2/city, admin_area_1/state, postal_code/zip, country_code/countryCode

  const fullName = cleanAddrField(s.fullName || s.name || s.full_name, 120);
  const line1 = cleanAddrField(
    s.address_line_1 || s.line1 || s.address1 || s.street1,
    300
  );
  const line2 = cleanAddrField(
    s.address_line_2 || s.line2 || s.address2 || s.street2,
    300
  );
  const city = cleanAddrField(s.admin_area_2 || s.city, 120);
  const state = cleanAddrField(s.admin_area_1 || s.state || s.province, 120);
  const postalCode = cleanAddrField(s.postal_code || s.postalCode || s.zip, 60);

  const countryCode = normalizeCountryCode(
    s.country_code || s.countryCode || s.country
  );

  const phone = cleanAddrField(s.phone || '', 40); // required for couriers (Shippo)
  const email = cleanAddrField(s.email || '', 140); // optional

  // Required minimum for real shipping
  const missing = [];
  if (!fullName) missing.push('fullName/name');
  if (!line1) missing.push('address_line_1/street1');
  if (!city) missing.push('admin_area_2/city');
  if (!state) missing.push('admin_area_1/state');
  if (!postalCode) missing.push('postal_code/zip');
  if (!countryCode) missing.push('country_code/country (2-letter like ZA)');
  if (!phone) missing.push('phone');

  if (missing.length) {
    const err = new Error(`Missing shipping fields: ${missing.join(', ')}`);
    err.code = 'SHIPPING_ADDRESS_INVALID';
    throw err;
  }

  return {
    fullName,
    phone,
    email: email || null,
    address: {
      address_line_1: line1,
      address_line_2: line2 || '',
      admin_area_2: city,
      admin_area_1: state,
      postal_code: postalCode,
      country_code: countryCode,
    },
  };
}

function isInternationalShipment({ toCountry, fromCountry }) {
  const a = String(toCountry || '').toUpperCase();
  const b = String(fromCountry || '').toUpperCase();
  return !!(a && b && a !== b);
}

function variantText(variants) {
  const v = variants && typeof variants === 'object' ? variants : {};

  const size = v.size ?? v.Size ?? v.s ?? null;
  const color = v.color ?? v.Color ?? null;

  const parts = [];
  if (size) parts.push(`Size: ${String(size)}`);
  if (color) parts.push(`Color: ${String(color)}`);

  // Include other simple variant keys if they exist (optional)
  for (const [k, val] of Object.entries(v)) {
    if (!val) continue;
    const key = String(k).toLowerCase();
    if (key === 'size' || key === 'color') continue;
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      parts.push(`${k}: ${String(val)}`);
    }
  }

  return parts.join(', ').slice(0, 127);
}

function paypalNameWithVariants(baseName, variants) {
  const base = String(baseName || 'Item').trim().slice(0, 127);
  const vt = variantText(variants);
  if (!vt) return base;
  const combined = `${base} (${vt})`;
  return combined.slice(0, 127); // PayPal name limit
}

// ======================================================
// ✅ PayPal fetch timeout wrapper
// ======================================================
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

// ======================================================
// ✅ Shippo (LIVE RATES) helpers
// ======================================================
const SHIPPO_API = 'https://api.goshippo.com';
const SHIPPO_TOKEN = String(process.env.SHIPPO_TOKEN || '').trim();

// Shippo can be slow to return rates (especially international). Make it configurable.
const SHIPPO_TIMEOUT_MS = (() => {
  const n = Number(String(process.env.SHIPPO_TIMEOUT_MS || '').trim());
  return Number.isFinite(n) ? Math.max(5000, Math.min(120000, Math.floor(n))) : 45000; // default 45s
})();

function mustShippoToken() {
  if (!SHIPPO_TOKEN) {
    const err = new Error('SHIPPO_TOKEN is missing in .env');
    err.code = 'SHIPPO_NOT_CONFIGURED';
    throw err;
  }
}

function shippoHeaders() {
  mustShippoToken();
  return {
    Authorization: `ShippoToken ${SHIPPO_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function envStr(name, fallback = '') {
  const v = String(process.env[name] || '').trim();
  return v || fallback;
}

// ✅ FROM address (your warehouse / sender address)
function getShippoFromAddress() {
  const country = normalizeCountryCode(envStr('SHIPPO_FROM_COUNTRY', 'ZA')) || 'ZA';

  const from = {
    name: envStr('SHIPPO_FROM_NAME', BRAND_NAME_N),
    street1: envStr('SHIPPO_FROM_STREET1', ''),
    street2: envStr('SHIPPO_FROM_STREET2', ''),
    city: envStr('SHIPPO_FROM_CITY', ''),
    state: envStr('SHIPPO_FROM_STATE', ''),
    zip: envStr('SHIPPO_FROM_ZIP', ''),
    country,
    phone: envStr('SHIPPO_FROM_PHONE', ''),
    email: envStr('SHIPPO_FROM_EMAIL', ''),
  };

  // minimal required for Shippo rating
  const missing = [];
  if (!from.street1) missing.push('SHIPPO_FROM_STREET1');
  if (!from.city) missing.push('SHIPPO_FROM_CITY');
  if (!from.state) missing.push('SHIPPO_FROM_STATE');
  if (!from.zip) missing.push('SHIPPO_FROM_ZIP');
  if (!from.country) missing.push('SHIPPO_FROM_COUNTRY');

  if (missing.length) {
    const err = new Error(`Missing Shippo FROM env vars: ${missing.join(', ')}`);
    err.code = 'SHIPPO_FROM_ADDRESS_INCOMPLETE';
    throw err;
  }

  return from;
}

async function resolveShippoFromAddressForCart(cart) {
  // Default: always use .env address
  const envFrom = getShippoFromAddress();

  const allowedCats = new Set(['second-hand-clothes', 'uncategorized-second-hand-things']);

  // If we can't load Product/Business/helper, we cannot safely build seller FROM
  if (!Product || !Business || typeof buildShippoAddressFromBusiness !== 'function') {
    return envFrom; // do NOT disturb other flows
  }

  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) return envFrom;

  // Load products (we need category + business owner id)
  const ids = items
    .map((it) => String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim())
    .filter(Boolean);

  const unique = [...new Set(ids)];
  if (!unique.length) return envFrom;

  const prods = await Product.find({ customId: { $in: unique } })
    .select('customId name category businessId sellerId seller ownerBusiness business')
    .lean();

  const map = new Map(prods.map((p) => [String(p.customId), p]));

  // Build product rows in cart order
  const rows = unique.map((cid) => ({ cid, product: map.get(cid) || null }));

  // If any product missing OR any product not in those 2 categories => use env FROM
  for (const r of rows) {
    if (!r.product) return envFrom;

    const catRaw = r.product.category;
    const cat = String(catRaw || '').trim();
    if (!allowedCats.has(cat)) return envFrom;
  }

  // At this point: ALL products are in allowed categories.
  // Now ensure they all belong to the SAME seller business (otherwise one shipment can't have multiple FROMs).
  const pickBizId = (p) =>
    p.businessId || p.sellerId || p.seller || p.ownerBusiness || p.business || null;

  const firstBizId = pickBizId(rows[0].product);
  if (!firstBizId) {
    const err = new Error(
      'Second-hand order detected, but product is missing seller businessId. Cannot build FROM address.'
    );
    err.code = 'SELLER_BUSINESS_MISSING';
    throw err;
  }

  for (const r of rows) {
    const bid = pickBizId(r.product);
    if (!bid || String(bid) !== String(firstBizId)) {
      const err = new Error(
        'Second-hand order contains products from different sellers. Cannot build one FROM address for one shipment.'
      );
      err.code = 'MIXED_SELLERS_NOT_SUPPORTED';
      throw err;
    }
  }

  // Load the seller business and build Shippo address
  const biz = await Business.findById(firstBizId).lean();
  if (!biz) {
    const err = new Error('Seller business not found for second-hand order.');
    err.code = 'SELLER_BUSINESS_NOT_FOUND';
    throw err;
  }

  // This will throw ADDRESS_INCOMPLETE with your nice message if fields are missing
  return buildShippoAddressFromBusiness(biz);
}

function kgFrom(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unit || 'kg').toLowerCase();
  if (u === 'kg') return v;
  if (u === 'g') return v / 1000;
  if (u === 'lb') return v * 0.45359237;
  if (u === 'oz') return v * 0.028349523125;
  return null;
}

function cmFrom(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unit || 'cm').toLowerCase();
  if (u === 'cm') return v;
  if (u === 'in') return v * 2.54;
  return null;
}

async function loadProductsForCart(cart) {
  if (!Product) {
    const err = new Error('Product model not available for shipping calculation.');
    err.code = 'NO_PRODUCT_MODEL';
    throw err;
  }

  const items = Array.isArray(cart?.items) ? cart.items : [];
  const ids = items
    .map((it) => String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim())
    .filter(Boolean);

  const unique = [...new Set(ids)];
  if (!unique.length) return [];

  // We only need shipping + name + customId
  const prods = await Product.find({ customId: { $in: unique } })
    .select('customId name shipping')
    .lean();

  // Map for fast lookup
  const map = new Map(prods.map((p) => [String(p.customId), p]));
  return items.map((it) => {
    const id = String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim();
    return { cartItem: it, product: map.get(id) || null, customId: id };
  });
}

function validateCartProductsShippingOrThrow(pairs) {
  const missingList = [];

  for (const row of pairs) {
    const p = row.product;
    if (!p) {
      missingList.push(`${row.customId || 'UNKNOWN'} (product not found)`);
      continue;
    }

    const sh = p.shipping || {};
    const wVal = sh?.weight?.value;
    const wUnit = sh?.weight?.unit;

    const d = sh?.dimensions || {};
    const len = d.length;
    const wid = d.width;
    const hei = d.height;
    const dUnit = d.unit;

    const problems = [];
    if (kgFrom(wVal, wUnit) === null) problems.push('weight');
    if (cmFrom(len, dUnit) === null) problems.push('length');
    if (cmFrom(wid, dUnit) === null) problems.push('width');
    if (cmFrom(hei, dUnit) === null) problems.push('height');

    if (problems.length) {
      missingList.push(`${p.name || p.customId} (missing: ${problems.join(', ')})`);
    }
  }

  if (missingList.length) {
    const err = new Error(
      `Shipping is unavailable because these products are missing shipping measurements: ${missingList.join(' | ')}`
    );
    err.code = 'PRODUCT_SHIPPING_MISSING';
    throw err;
  }
}

function buildCalculatedParcelFromProducts(rows, { onlyFragile } = {}) {
  // Build ONE parcel:
  // - weight = sum(weight * qty)
  // - dimensions = MAX of each dimension (do NOT multiply dimensions by qty)
  let totalKg = 0;

  let maxLenCm = 0;
  let maxWidCm = 0;
  let maxHeiCm = 0;

  for (const row of rows) {
    const p = row.product;
    const sh = p.shipping || {};
    const qty = toQty(row?.cartItem?.qty ?? row?.cartItem?.quantity, 1);

    const isFragile = !!sh?.fragile;

    if (onlyFragile === true && !isFragile) continue;
    if (onlyFragile === false && isFragile) continue;

    const kgEach = kgFrom(sh?.weight?.value, sh?.weight?.unit);
    const d = sh?.dimensions || {};
    const unit = d.unit;

    const lenCm = cmFrom(d.length, unit);
    const widCm = cmFrom(d.width, unit);
    const heiCm = cmFrom(d.height, unit);

    totalKg += kgEach * qty;

    // ✅ dimensions should NOT be multiplied by qty
    maxLenCm = Math.max(maxLenCm, lenCm);
    maxWidCm = Math.max(maxWidCm, widCm);
    maxHeiCm = Math.max(maxHeiCm, heiCm);
  }

  const safeKg = Math.max(0.001, Number(totalKg.toFixed(3)));
  const safeLen = Math.max(0.1, Number(maxLenCm.toFixed(1)));
  const safeWid = Math.max(0.1, Number(maxWidCm.toFixed(1)));
  const safeHei = Math.max(0.1, Number(maxHeiCm.toFixed(1)));

  return {
    length: String(safeLen),
    width: String(safeWid),
    height: String(safeHei),
    distance_unit: 'cm',
    weight: String(safeKg),
    mass_unit: 'kg',
  };
}

async function buildShippoParcelsFromCart_Strict(cart) {
  const pairs = await loadProductsForCart(cart);
  validateCartProductsShippingOrThrow(pairs);

  const hasFragile = pairs.some((r) => !!r?.product?.shipping?.fragile);

  // ✅ Rule: ONE parcel by default
  if (!hasFragile) {
    return [buildCalculatedParcelFromProducts(pairs)];
  }

  // ✅ Rule: split ONLY when fragile exists
  const fragileRows = pairs.filter((r) => !!r?.product?.shipping?.fragile);
  const normalRows  = pairs.filter((r) => !r?.product?.shipping?.fragile);

  const parcels = [];

  // Only add a parcel if it actually has items
  if (fragileRows.length) parcels.push(buildCalculatedParcelFromProducts(fragileRows));
  if (normalRows.length) parcels.push(buildCalculatedParcelFromProducts(normalRows));

  // Safety: should never be empty, but just in case
  if (!parcels.length) {
    return [buildCalculatedParcelFromProducts(pairs)];
  }

  return parcels;
}

async function shippoCreateCustomsDeclaration({ cart, toCountry }) {
  // ✅ Customs line items MUST be based on Product.shipping (not .env)
  // ✅ We will:
  // - load products for cart
  // - enforce measurements exist (already strict)
  // - compute net_weight per line = productKg * qty
  // - compute value_amount per line = unitPrice * qty (from cart snapshot)

  const pairs = await loadProductsForCart(cart);
  validateCartProductsShippingOrThrow(pairs);

  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  if (!itemsArr.length) {
    const err = new Error('Cart is empty; cannot create customs declaration.');
    err.code = 'CART_EMPTY';
    throw err;
  }

  const originCountry = normalizeCountryCode(envStr('SHIPPO_FROM_COUNTRY', 'ZA')) || 'ZA'; // ok to keep: this is the ship-from country
  const currency = upperCcy; // ✅ keep consistent with your PayPal currency
  const massUnit = 'kg';     // ✅ we calculate in kg

  function clip(str, max) {
    const s = String(str || '');
    return s.length > max ? s.slice(0, max) : s;
  }

  // Keep short + traceable (Shippo accepts exporter_reference)
  const exporterRef = (() => {
    const pref = 'UNIC';
    const dest = clip((toCountry ? String(toCountry).toUpperCase() : 'XX'), 2);
    const ts = Math.floor(Date.now() / 1000);
    return clip(`${pref}-${dest}-${ts}`, 20);
  })();

  const signer =
    envStr('SHIPPO_FROM_NAME', BRAND_NAME_N) ||
    BRAND_NAME_N;

  // Build customs items from pairs (product + cart qty)
  const items = pairs.map((row, i) => {
    const p = row.product;
    const it = row.cartItem;

    const qty = toQty(it?.qty ?? it?.quantity, 1);

    // Prefer product name for customs description
    const name = String(p?.name || it?.name || it?.title || `Item ${i + 1}`).slice(0, 50);

    // Unit value: use cart snapshot price (your cart is gross per unit)
    const unitVal = normalizeMoneyNumber(it?.price ?? it?.unitPrice) ?? 0;
    const totalVal = +(Number(unitVal) * qty).toFixed(2);

    // ✅ Weight from Product.shipping
    const sh = p?.shipping || {};
    const kgEach = kgFrom(sh?.weight?.value, sh?.weight?.unit);

    // validateCartProductsShippingOrThrow already ensured kgEach is not null
    const totalKg = +(kgEach * qty).toFixed(3);

    return {
      description: name,
      quantity: qty,

      // ✅ Shippo requires TOTAL weight for this line item
      net_weight: String(Math.max(0.001, totalKg)),
      mass_unit: massUnit,

      // ✅ Shippo requires TOTAL value for this line item
      value_amount: String(Math.max(0, totalVal)),
      value_currency: currency,

      origin_country: originCountry,
    };
  });

  // ✅ Shippo requires certify + signer and a few basic customs fields
  // We will NOT use .env for weights/hs defaults anymore.
  const payload = {
    certify: true,
    certify_signer: String(signer).slice(0, 100),

    contents_type: 'MERCHANDISE',
    non_delivery_option: 'RETURN',
    incoterm: 'DDU',

    exporter_reference: exporterRef,

    items,
  };

  const res = await fetchWithTimeout(
    `${SHIPPO_API}/customs/declarations/`,
    {
      method: 'POST',
      headers: shippoHeaders(),
      body: JSON.stringify(payload),
    },
    SHIPPO_TIMEOUT_MS
  );

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      (Array.isArray(json?.messages) && json.messages.length)
        ? JSON.stringify(json.messages)
        : (json?.detail || json?.message || JSON.stringify(json));
    const err = new Error(`Shippo customs declaration error (${res.status}): ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_FAILED';
    throw err;
  }

  const status = String(json?.object_status || '').toUpperCase();
  if (status && status !== 'SUCCESS') {
    const msg =
      (Array.isArray(json?.messages) && json.messages.length)
        ? JSON.stringify(json.messages)
        : (json?.detail || json?.message || JSON.stringify(json));
    const err = new Error(`Shippo customs declaration object_status=${status}: ${msg}`);
    err.code = 'SHIPPO_CUSTOMS_OBJECT_ERROR';
    throw err;
  }

  const id = json?.object_id ? String(json.object_id) : null;
  if (!id) throw new Error('Shippo customs declaration did not return object_id.');
  return id;
}

async function shippoCreateShipment({ to, cart }) {
  const from = await resolveShippoFromAddressForCart(cart); 

  const intl = isInternationalShipment({ toCountry: to?.country, fromCountry: from?.country });

  // ✅ Create customs once for international shipments
  let customsDeclarationId = null;
  if (intl) {
    customsDeclarationId = await shippoCreateCustomsDeclaration({ cart, toCountry: to.country });
  }

  const parcels = await buildShippoParcelsFromCart_Strict(cart);

  const payload = {
    address_from: {
      name: from.name,
      street1: from.street1,
      street2: from.street2,
      city: from.city,
      state: from.state,
      zip: from.zip,
      country: from.country,
      phone: from.phone || undefined,
      email: from.email || undefined,
    },
    address_to: {
      name: to.name,
      street1: to.street1,
      street2: to.street2 || '',
      city: to.city,
      state: to.state,
      zip: to.zip,
      country: to.country,
      phone: to.phone || undefined,
      email: to.email || undefined,
      is_residential: true,
    },
    parcels,
    async: false, // keep synchronous so we get rates immediately
    ...(customsDeclarationId ? { customs_declaration: customsDeclarationId } : {}),
  };

  const res = await fetchWithTimeout(
    `${SHIPPO_API}/shipments/`,
    {
      method: 'POST',
      headers: shippoHeaders(),
      body: JSON.stringify(payload),
    },
    SHIPPO_TIMEOUT_MS
  );

  const json = await res.json().catch(() => ({}));

  console.log('[Shippo shipment] carrier_accounts=', Array.isArray(json?.carrier_accounts) ? json.carrier_accounts.length : null);
  console.log('[Shippo shipment] rates=', Array.isArray(json?.rates) ? json.rates.length : null);
  console.log('[Shippo shipment] messages=', json?.messages || null);

  // Shippo sometimes returns 200 but object_status="ERROR"
  const objStatus = String(json?.object_status || '').toUpperCase();
  if (objStatus && objStatus !== 'SUCCESS') {
    const msg =
      (Array.isArray(json?.messages) && json.messages.length)
        ? JSON.stringify(json.messages)
        : (json?.detail || json?.message || 'Shippo shipment object_status=ERROR');
    const err = new Error(`Shippo shipment error: ${msg}`);
    err.code = 'SHIPPO_SHIPMENT_OBJECT_ERROR';
    throw err;
  }

  if (!res.ok) {
    const msg = json?.detail || json?.message || JSON.stringify(json);
    const err = new Error(`Shippo shipment error (${res.status}): ${msg}`);
    err.code = 'SHIPPO_SHIPMENT_FAILED';
    throw err;
  }

  json._customsDeclarationId = customsDeclarationId || null;
  json._isInternational = !!intl;

  return json; // includes object_id + rates
}

function normalizeShippoRates(shipmentJson) {
  const rates = Array.isArray(shipmentJson?.rates) ? shipmentJson.rates : [];

  const out = rates
    .map((r) => {
      const amount = normalizeMoneyNumber(r?.amount);
      const currency = String(r?.currency || '').toUpperCase() || upperCcy;

      const days = normalizeMoneyNumber(r?.estimated_days);
      const provider = String(r?.provider || '').trim();
      const service = String(r?.servicelevel?.name || r?.servicelevel?.token || '').trim();

      return {
        rateId: r?.object_id ? String(r.object_id) : null,
        amount: amount == null ? null : +amount.toFixed(2),
        currency,
        provider,
        service,
        days: days == null ? null : Math.max(0, Math.floor(days)),
      };
    })
    .filter((x) => x.rateId && x.amount != null);

  // cheapest first
  out.sort((a, b) => (a.amount - b.amount));

  return out;
}

// ======================================================
// ✅ Totals from cart
// ======================================================
function computeTotalsFromSession(cart, delivery = 0) {
  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];

  // Cart item prices are VAT-INCLUSIVE (gross)
  // ✅ PayPal requires: item_total = sum(items.unit_amount * qty)
  // So we must send NET unit_amount to PayPal and put VAT in tax_total.
  const r = Number.isFinite(vatRate) ? vatRate : 0;

  let netItemsTotal = 0;
  let grossItemsTotal = 0;

  const ppItems = itemsArr.map((it, i) => {
    const grossUnitRaw = normalizeMoneyNumber(it.price ?? it.unitPrice); // gross
    const qtyN = toQty(it.qty ?? it.quantity, 1);

    const grossUnit = grossUnitRaw === null ? 0 : +grossUnitRaw.toFixed(2);

    // NET per unit (rounded to 2dp for PayPal consistency)
    const netUnit = r > 0 ? +(grossUnit / (1 + r)).toFixed(2) : grossUnit;

    const lineNet = +(netUnit * qtyN).toFixed(2);
    const lineGross = +(grossUnit * qtyN).toFixed(2);

    netItemsTotal += lineNet;
    grossItemsTotal += lineGross;

    const name = (it.name || `Item ${i + 1}`).toString().slice(0, 127);

    const description = safeStr(it.description || '', 127);
const sku = safeStr(it.sku || '', 127);

    return {
      name,
      ...(description ? { description } : {}),
      ...(sku ? { sku } : {}),
      quantity: String(qtyN),
      unit_amount: { currency_code: upperCcy, value: toMoney2(netUnit) }, // ✅ NET
    };
  });

  netItemsTotal = +netItemsTotal.toFixed(2);
  grossItemsTotal = +grossItemsTotal.toFixed(2);

  // VAT extracted as: gross - net (using the same rounded sums)
  const vat = +(grossItemsTotal - netItemsTotal).toFixed(2);

  const del = +Number(delivery || 0).toFixed(2);

  // amount.value MUST equal item_total + tax_total + shipping
  const grand = +(netItemsTotal + vat + del).toFixed(2);

  return {
    items: ppItems,
    subTotal: netItemsTotal,     // ✅ NET (PayPal item_total)
    vatTotal: vat,               // ✅ VAT (PayPal tax_total)
    delivery: del,
    grandTotal: grand,           // ✅ PayPal amount.value
  };
}

// ======================================================
// ✅ PayPal auth (token cache)
// ======================================================
let _ppTokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const cid = String(PAYPAL_CLIENT_ID || '').trim();
  const sec = String(PAYPAL_CLIENT_SECRET || '').trim();
  if (!cid || !sec) throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');

  const now = Date.now();
  if (_ppTokenCache.token && _ppTokenCache.expiresAt > now + 20_000) return _ppTokenCache.token;

  const auth = Buffer.from(`${cid}:${sec}`).toString('base64');

  const res = await fetchWithTimeout(`${PP_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);

  const json = await res.json();
  _ppTokenCache.token = json.access_token;
  _ppTokenCache.expiresAt = Date.now() + Math.max(30, Number(json.expires_in || 0)) * 1000;

  return _ppTokenCache.token;
}

// ======================================================
// ✅ Order lookups
// ======================================================
async function findOrderByAnyId(id) {
  if (!Order) return null;
  const s = String(id || '').trim();
  if (!s) return null;

  let doc =
    (await Order.findOne({ orderId: s }).lean()) ||
    (await Order.findOne({ paypalOrderId: s }).lean()) ||
    (await Order.findOne({ 'paypal.orderId': s }).lean());

  if (doc) return doc;

  if (/^[0-9a-fA-F]{24}$/.test(s)) {
    try {
      doc = await Order.findById(s).lean();
      if (doc) return doc;
    } catch {
      // placeholging
    }
  }

  doc =
    (await Order.findOne({ 'paypal.captureId': s }).lean()) ||
    (await Order.findOne({ 'captures.captureId': s }).lean()) ||
    (await Order.findOne({ 'captures.0.captureId': s }).lean()) ||
    (await Order.findOne({ captureId: s }).lean());

  return doc || null;
}

async function findOrderByCaptureId(captureId) {
  if (!Order) return null;
  const cid = String(captureId || '').trim();
  if (!cid) return null;

  return Order.findOne({
    $or: [{ 'paypal.captureId': cid }, { 'captures.captureId': cid }, { captureId: cid }],
  });
}

// ======================================================
// ✅ Ownership helpers (only own orders)
// ======================================================
function docOwnedByRequester(req, doc) {
  if (!doc) return false;
  if (req.session?.admin) return true;

  const userId = getUserId(req);
  const bizId = getBusinessId(req);

  const ownedByUser = userId && doc?.userId && String(doc.userId) === String(userId);
  const ownedByBiz = bizId && doc?.businessBuyer && String(doc.businessBuyer) === String(bizId);

  return !!(ownedByUser || ownedByBiz);
}

// ======================================================
// ✅ Refund helpers
// ======================================================
async function listRefundsForCapture(captureId) {
  const token = await getAccessToken();

  const res = await fetchWithTimeout(
    `${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refunds`,
    { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `PayPal list refunds failed (${res.status}): ${json?.message || JSON.stringify(json)}`
    );
  }

  return Array.isArray(json.refunds) ? json.refunds : [];
}

function getCapturedAmountFromOrder(doc) {
  try {
    const v1 = normalizeMoneyNumber(doc?.amount?.value);
    const c1 = doc?.amount?.currency || upperCcy;
    if (v1 != null) return { value: v1, currency: c1 };

    const cap0 = Array.isArray(doc?.captures) ? doc.captures[0] : null;
    const v2 = normalizeMoneyNumber(cap0?.amount?.value);
    const c2 = cap0?.amount?.currency || upperCcy;
    if (v2 != null) return { value: v2, currency: c2 };

    const pu = Array.isArray(doc?.raw?.purchase_units) ? doc.raw.purchase_units[0] : null;
    const cap = pu?.payments?.captures?.[0] || null;
    const v3 = normalizeMoneyNumber(cap?.amount?.value);
    const c3 = cap?.amount?.currency_code || c1;

    return { value: v3 ?? null, currency: c3 || upperCcy };
  } catch {
    return { value: null, currency: doc?.amount?.currency || upperCcy };
  }
}

function sumRefundedFromOrder(doc) {
  try {
    const arr = Array.isArray(doc?.refunds) ? doc.refunds : [];
    let sum = 0;
    for (const r of arr) {
      const n = normalizeMoneyNumber(r?.amount);
      if (n != null) sum += n;
    }
    return +sum.toFixed(2);
  } catch {
    return 0;
  }
}

async function reconcileRefundsForOrderDoc(orderDoc, captureId, { source = 'sync' } = {}) {
  if (!Order || !orderDoc) return { ok: false, reason: 'NO_ORDER' };

  const cid = String(captureId || '').trim();
  if (!cid) return { ok: false, reason: 'NO_CAPTURE_ID' };

  const refunds = await listRefundsForCapture(cid);
  orderDoc.refunds = Array.isArray(orderDoc.refunds) ? orderDoc.refunds : [];

  let newlyAdded = 0;
  const processed = [];

  for (const r of refunds) {
    const refundId = r?.id ? String(r.id) : null;
    if (!refundId) continue;

    const exists = orderDoc.refunds.some((x) => String(x?.refundId || '') === refundId);
    if (exists) {
      processed.push({ refundId, skipped: true });
      continue;
    }

    const amtVal = r?.amount?.value ?? null;
    const ccy = String(r?.amount?.currency_code || orderDoc?.amount?.currency || upperCcy).toUpperCase();

    orderDoc.refunds.push({
      refundId,
      status: r?.status || null,
      amount: safeMoneyString(amtVal, 32),
      currency: ccy,
      createdAt: r?.create_time ? new Date(r.create_time) : new Date(),
      source,
    });

    newlyAdded++;

    if (typeof debitSellersFromRefund === 'function') {
      try {
        const rr = await debitSellersFromRefund(orderDoc, {
          refundId,
          amount: amtVal ?? null,
          currency: ccy,
          allowWhenUnpaid: true,
          platformFeeBps: Number.isFinite(orderDoc?.platformFeeBps)
            ? orderDoc.platformFeeBps
            : PLATFORM_FEE_BPS,
        });
        processed.push({ refundId, debited: true, result: rr });
      } catch (e) {
        processed.push({ refundId, debited: false, error: e?.message || String(e) });
      }
    } else {
      processed.push({ refundId, debited: false, warning: 'debitSellersFromRefund NOT loaded.' });
    }
  }

  const captured = getCapturedAmountFromOrder(orderDoc);
  const refundedSoFar = sumRefundedFromOrder(orderDoc);

  orderDoc.refundedTotal = String(refundedSoFar.toFixed(2));

  if (captured.value != null) {
    if (refundedSoFar >= captured.value - 0.00001) {
      orderDoc.status = 'REFUNDED';
      orderDoc.paymentStatus = 'refunded';
    } else if (refundedSoFar > 0) {
      orderDoc.status = 'PARTIALLY_REFUNDED';
      orderDoc.paymentStatus = 'partially_refunded';
    }
  } else {
    orderDoc.status = 'REFUND_SUBMITTED';
    orderDoc.paymentStatus = 'refund_submitted';
  }

  if (refundedSoFar > 0) orderDoc.refundedAt = new Date();

  await orderDoc.save();

  return {
    ok: true,
    orderId: String(orderDoc.orderId || orderDoc._id),
    captureId: cid,
    paypalRefundsFound: refunds.length,
    newlyAdded,
    status: orderDoc.status,
    refundedTotal: orderDoc.refundedTotal,
    processed,
  };
}

// ======================================================
// ✅ INVENTORY (Stock decrease on sale, restore on refund)
// IMPORTANT: Your Order.items[].productId stores Product.customId (string)
// ======================================================
function pickProductKeyFromItem(it) {
  return String(it?.productId || it?.customId || it?.pid || it?.sku || '').trim();
}

async function applyStockDelta(items, deltaSign /* -1 sale, +1 restore */) {
  if (!Product) return { ok: false, reason: 'NO_PRODUCT_MODEL' };

  const arr = Array.isArray(items) ? items : [];
  if (arr.length === 0) return { ok: true, changed: 0 };

  const ops = [];

  for (const it of arr) {
    const key = String(it?.productId || it?.customId || it?.pid || it?.sku || '').trim(); // should be customId
    const qty = Number(it?.quantity || 1);

    if (!key) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;

    ops.push({
      updateOne: {
        filter: { customId: key }, // ✅ match Product.customId
        update: { $inc: { stock: deltaSign * qty } },
      },
    });
  }

  if (ops.length === 0) return { ok: true, changed: 0 };

  const res = await Product.bulkWrite(ops, { ordered: false });
  const changed = Number(res?.modifiedCount || 0);

  return { ok: true, changed };
}

function buildStockAppliedItemsFromOrder(orderDoc) {
  const items = Array.isArray(orderDoc?.items) ? orderDoc.items : [];
  return items
    .map((it) => ({
      productId: pickProductKeyFromItem(it),
      name: String(it?.name || '').slice(0, 120),
      quantity: Number(it?.quantity || 1),
    }))
    .filter((x) => x.productId && Number.isFinite(x.quantity) && x.quantity > 0);
}

async function applyInventoryOnPaidOrder(orderDoc) {
  if (!orderDoc || !Order) return { ok: false, reason: 'NO_ORDERDOC' };

  if (orderDoc.inventoryAdjusted) {
    return { ok: true, skipped: true, reason: 'ALREADY_ADJUSTED' };
  }

  const appliedItems = buildStockAppliedItemsFromOrder(orderDoc);
  if (appliedItems.length === 0) return { ok: false, reason: 'NO_ITEMS_TO_APPLY' };

  const out = await applyStockDelta(appliedItems, -1);

  if (out.ok) {
    // ✅ requires these fields in Order model:
    // inventoryAdjustedItems: [{ productId, quantity }]
    orderDoc.inventoryAdjusted = true;
    orderDoc.inventoryAdjustedItems = appliedItems.map((x) => ({
      productId: x.productId,
      quantity: x.quantity,
    }));
    await orderDoc.save();
  }

  return out;
}

async function restoreInventoryOnRefundedOrder(orderDoc, reason = 'refund') {
  if (!orderDoc || !Order) return { ok: false, reason: 'NO_ORDERDOC' };

  // ✅ requires this field in Order model:
  // inventoryRestored: Boolean
  if (orderDoc.inventoryRestored) {
    return { ok: true, skipped: true, reason: 'ALREADY_RESTORED' };
  }

  // Only restore if we actually deducted before
  if (!orderDoc.inventoryAdjusted) {
    return { ok: true, skipped: true, reason: 'NOT_DEDUCTED_BEFORE' };
  }

  const items =
    Array.isArray(orderDoc.inventoryAdjustedItems) && orderDoc.inventoryAdjustedItems.length
      ? orderDoc.inventoryAdjustedItems
      : buildStockAppliedItemsFromOrder(orderDoc);

  if (!items.length) return { ok: false, reason: 'NO_ITEMS_TO_RESTORE' };

  const out = await applyStockDelta(items, +1);

  if (out.ok) {
    orderDoc.inventoryRestored = true;
    // keep inventoryAdjusted true for history (or set false if you prefer)
    // orderDoc.inventoryAdjusted = false;
    orderDoc.raw = orderDoc.raw || {};
    orderDoc.raw._inventoryRestoreReason = String(reason).slice(0, 80); // harmless debug note
    await orderDoc.save();
  }

  return out;
}

// ======================================================
// ✅ View shaping (NO NaN)
// ======================================================
function shapeOrderForClient(doc) {
  const currency = doc?.amount?.currency || doc?.breakdown?.itemTotal?.currency || upperCcy;

  const amountVal =
    normalizeMoneyNumber(doc?.amount?.value) ??
    normalizeMoneyNumber(doc?.raw?.purchase_units?.[0]?.amount?.value) ??
    0;

  const items = Array.isArray(doc?.items)
    ? doc.items.map((it) => {
        const raw =
        it?.priceGross?.value ??   // ✅ prefer gross for display
        it?.price?.value ??
        it?.price ??
        it?.unitPrice ??
        it?.unit_amount?.value ??
        it?.unit_amount ??
        0;

        const priceN = normalizeMoneyNumber(raw);
        return {
          name: it?.name || '',
          quantity: toQty(it?.quantity, 1),
          price: { value: priceN === null ? 0 : Number(priceN) },
          imageUrl: it?.imageUrl || '',

          // ✅ add back size/color (and anything else you stored)
          variants: it?.variants || {},

          // ✅ optional (only if you want to show gross separately later)
          priceGross: it?.priceGross || null,
        };
      })
    : [];

  const b = doc.breakdown || {};
  const itemTotalVal = normalizeMoneyNumber(b?.itemTotal?.value) ?? null;
  const taxTotalVal = normalizeMoneyNumber(b?.taxTotal?.value) ?? null;
  const shipVal = normalizeMoneyNumber(b?.shipping?.value) ?? null;

  return {
    id: doc.orderId || String(doc._id),
    orderId: doc.orderId || String(doc._id),
    status: doc.status || 'COMPLETED',
    createdAt: doc.createdAt || new Date(),
    currency,
    amount: { value: Number(amountVal || 0) },
    items,
    breakdown: {
      itemTotal: itemTotalVal != null ? { value: itemTotalVal } : null,
      taxTotal: taxTotalVal != null ? { value: taxTotalVal } : null,
      shipping: shipVal != null ? { value: shipVal } : null,
    },
    delivery: doc.delivery
      ? {
          name: doc.delivery.name || null,
          deliveryDays: doc.delivery.deliveryDays ?? null,
          amount: doc.delivery.amount != null ? Number(doc.delivery.amount) : null,
        }
      : null,
    shipping: doc.shipping || null,
  };
}

function buildSessionSnapshot(orderId, pending) {
  const items = Array.isArray(pending?.itemsBrief)
    ? pending.itemsBrief.map((it) => ({
        name: it?.name || '',
        quantity: toQty(it?.quantity, 1),
        price: { value: Number(normalizeMoneyNumber(it?.unitPriceGross ?? it?.unitPrice) ?? 0) },
        variants: it?.variants || {},
      }))
    : [];

  return {
    id: orderId,
    orderId,
    status: 'COMPLETED',
    createdAt: new Date(),
    currency: pending?.currency || upperCcy,
    amount: { value: Number(normalizeMoneyNumber(pending?.grandTotal) ?? 0) },
    items,
    breakdown: {
      itemTotal: pending?.subTotal != null ? { value: Number(normalizeMoneyNumber(pending.subTotal) ?? 0) } : null,
      taxTotal: pending?.vatTotal != null ? { value: Number(normalizeMoneyNumber(pending.vatTotal) ?? 0) } : null,
      shipping:
        pending?.deliveryPrice != null
          ? { value: Number(normalizeMoneyNumber(pending.deliveryPrice) ?? 0) }
          : null,
    },
    delivery:
      pending && (pending.deliveryName || pending.deliveryDays != null)
        ? {
            name: pending.deliveryName || null,
            deliveryDays: pending.deliveryDays ?? null,
            amount:
              pending.deliveryPrice != null
                ? Number(normalizeMoneyNumber(pending.deliveryPrice) ?? 0)
                : null,
          }
        : null,
    shipping: null,
  };
}

// ======================================================
// ✅ Seller helpers (used by /payment/my-orders seller view)
// ======================================================
function isSellerBusiness(req) {
  const b = req.session?.business || {};
  const role =
    String(b.role || b.type || b.accountType || b.kind || '').trim().toLowerCase();
  // treat seller + supplier as "can fulfill / see their items"
  return role === 'seller' || role === 'supplier';
}

function pickItemProductId(it) {
  // Your Order.items[].productId stores Product.customId (string)
  return String(it?.productId || it?.customId || it?.pid || it?.sku || '').trim();
}

function itemLineTotal(it) {
  // price might be {value,currency} OR string/number
  const qty = toQty(it?.quantity ?? it?.qty, 1);

  let unit =
    it?.priceGross?.value ??
    it?.price?.value ??
    it?.price ??
    it?.unitPrice ??
    it?.unitPriceNet ??
    0;

  if (unit && typeof unit === 'object') unit = unit.value ?? unit.amount ?? 0;

  const unitN = normalizeMoneyNumber(unit) ?? 0;
  return +(unitN * qty).toFixed(2);
}

// ======================================================
// ✅ Receipt token helpers (optional public share links)
// ======================================================
function makeReceiptToken(orderId) {
  const secret = String(RECEIPT_TOKEN_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(orderId)).digest('hex');
}
function safeEq(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}
function buildReceiptLink(orderId) {
  const tok = makeReceiptToken(orderId);
  if (!tok) return `/payment/receipt/${encodeURIComponent(orderId)}`; // logged-in only
  return `/payment/receipt/${encodeURIComponent(orderId)}?t=${tok}`; // shareable
}

// ======================================================
// ✅ VIEWS
// ======================================================
router.get('/checkout', async (req, res) => {
  return res.render('checkout', {
    title: 'Checkout',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    paypalClientId: String(PAYPAL_CLIENT_ID || '').trim(),
    currency: upperCcy,
    brandName: BRAND_NAME_N,
    vatRate,
    // COUNTRIES,

    // ✅ Shippo-only checkout (no delivery options)
    shippoOnly: true,

    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

router.get('/orders', requireAnyAuth, (req, res) => {
  return res.render('orders', {
    title: 'My Orders',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

router.get('/config', (req, res) => {
  res.json({
    clientId: String(PAYPAL_CLIENT_ID || '').trim(),
    currency: upperCcy,
    intent: 'capture',
    mode: PAYPAL_MODE_N,
    baseCurrency: upperCcy,
    brandName: BRAND_NAME_N,
  });
});

// ======================================================
// ✅ Remember payer-selected Shippo rate (SESSION)
// POST /payment/shippo/remember-rate
// ======================================================
router.post('/shippo/remember-rate', requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    const b = req.body || {};

    const shipmentId = String(b.shippoShipmentId || '').trim();
    const rateId     = String(b.shippoRateId || '').trim();

    if (!shipmentId || !rateId) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_FIELDS',
        message: 'Missing shipmentId or rateId.',
      });
    }

    // ✅ Validate against the CURRENT session quote (prevents stale/fake rate selection)
    const q = req.session?.shippoQuote || null;

    const fresh = q?.createdAt && (Date.now() - q.createdAt) < 30 * 60 * 1000; // 30 min
    const sameShipment = q?.shipmentId && String(q.shipmentId) === String(shipmentId);

    if (!q || !fresh || !sameShipment) {
      return res.status(409).json({
        ok: false,
        code: 'SHIPPO_QUOTE_EXPIRED',
        message: 'Shipping quote expired. Please refresh rates and re-select.',
      });
    }

    const exists =
      Array.isArray(q.rates) &&
      q.rates.some((r) => String(r.rateId) === String(rateId));

    if (!exists) {
      return res.status(409).json({
        ok: false,
        code: 'SHIPPO_RATE_NOT_IN_QUOTE',
        message: 'Selected rate is not part of the current quote. Please re-select.',
      });
    }

    // ✅ Grab details from the quote (server-trusted)
    const picked = q.rates.find((r) => String(r.rateId) === String(rateId)) || null;

    req.session.shippoSelectedRate = {
      shipmentId,
      rateId,
      provider: picked?.provider ? String(picked.provider).trim() : String(b.provider || '').trim(),
      service:  picked?.service  ? String(picked.service).trim()  : String(b.service || '').trim(),
      amount:   picked?.amount != null ? Number(picked.amount) : Number(b.amount || 0),
      currency: picked?.currency ? String(picked.currency).toUpperCase() : String(b.currency || 'USD').toUpperCase(),
      days:     picked?.days != null ? Number(picked.days) : Number(b.days || 0),
      selectedAt: new Date().toISOString(),
    };

    await saveSession(req);

    return res.json({ ok: true });
  } catch (e) {
    console.error('remember-rate error:', e);
    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Server error remembering rate.',
    });
  }
});

// ======================================================
// ✅ LIVE Shippo Rates (Quote) - used by checkout dropdown
// POST /payment/shippo/quote
// Body: { shipTo: { name, phone, email, street1, street2, city, state, zip, country } }
// ======================================================
router.post('/shippo/quote', requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    // Validate shipTo using your existing validator
    const shipTo = requireShippingAddressFromBody(req); // returns PayPal-shaped keys
    // Convert back to the checkout-style keys we need
    const to = {
      name: shipTo.fullName,
      phone: shipTo.phone,
      email: shipTo.email,
      street1: shipTo.address.address_line_1,
      street2: shipTo.address.address_line_2,
      city: shipTo.address.admin_area_2,
      state: shipTo.address.admin_area_1,
      zip: shipTo.address.postal_code,
      country: shipTo.address.country_code,
    };

    const cart = req.session?.cart || { items: [] };
    const sig = cartSig(cart);
    const q = req.session?.shippoQuote || null;

    // ✅ 5 minute cache when cart+address match
    const isFresh = q?.createdAt && (Date.now() - q.createdAt) < 5 * 60 * 1000;
    if (
      q &&
      isFresh &&
      q.cartSig === sig &&
      q.to &&
      sameShippoTo(q.to, to) &&
      q.shipmentId &&
      Array.isArray(q.rates) &&
      q.rates.length
    ) {
      return res.json({ ok: true, shipmentId: q.shipmentId, rates: q.rates, cached: true });
    }

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({ ok: false, code: 'CART_EMPTY', message: 'Cart is empty.' });
    }

    
    const shipment = await shippoCreateShipment({ to, cart });

    const shipmentId = shipment?.object_id ? String(shipment.object_id) : null;
    const rates = normalizeShippoRates(shipment);

    if (!rates.length) {
      console.error('Shippo NO_RATES debug:', {
        shipmentId,
        object_status: shipment?.object_status,
        messages: shipment?.messages,
        address_from: shipment?.address_from,
        address_to: shipment?.address_to,
        carrier_accounts: shipment?.carrier_accounts,
        rates_raw_count: Array.isArray(shipment?.rates) ? shipment.rates.length : null,
      });
    }

    // const shipmentId = shipment?.object_id ? String(shipment.object_id) : null;
    // const rates = normalizeShippoRates(shipment);

    const customsDeclarationId = shipment?._customsDeclarationId ? String(shipment._customsDeclarationId) : null;
    const isInternational = !!shipment?._isInternational;

    const fromCountry = normalizeCountryCode(envStr('SHIPPO_FROM_COUNTRY', 'ZA')) || 'ZA';

    const toCountry = String(to.country || '').toUpperCase();

    if (!shipmentId || !rates.length) {
      return res.status(502).json({
        ok: false,
        code: 'NO_RATES',
        message: 'Shippo returned no rates for this address/cart.',
      });
    }

    // ✅ Store quote in session so user cannot fake prices/rateIds
    req.session.shippoQuote = {
      shipmentId,
      rates,
      to,
      cartSig: sig,
      createdAt: Date.now(),

      // ✅ persist intl metadata for later label buying
      isInternational,
      fromCountry,
      toCountry,
      customsDeclarationId,
    };

    req.session.shippoSelectedRate = null; // ✅ clear stale selection when quote changes

    await saveSession(req);

    return res.json({ ok: true, shipmentId, rates });
  } catch (err) {
    console.error('POST /payment/shippo/quote error:', err?.message || err);

        const isAbort =
      err?.name === 'AbortError' ||
      String(err?.message || '').toLowerCase().includes('aborted');

    const code = err?.code || (isAbort ? 'SHIPPO_TIMEOUT' : 'SHIPPO_QUOTE_FAILED');

    return res.status(isAbort ? 504 : 500).json({
      ok: false,
      code,
      message: err?.message || (isAbort ? 'Shippo quote timed out.' : 'Failed to load Shippo rates.'),
    }); 
  }
});

// ======================================================
// ✅ CREATE ORDER (PayPal) — SHIPPO ONLY (NO DeliveryOption, NO collect)
// ======================================================
router.post('/create-order', requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    const cart = req.session?.cart || { items: [] };

    // ✅ Shippo-only: shipping address is ALWAYS required
    let shippingInput = null;
    try {
      shippingInput = requireShippingAddressFromBody(req);
    } catch (e) {
      return res.status(422).json({
        ok: false,
        code: e.code || 'SHIPPING_ADDRESS_INVALID',
        message: e.message || 'Invalid shipping address.',
      });
    }

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({
        ok: false,
        code: 'CART_EMPTY',
        message: 'Cart is empty (server session).',
      });
    }

    // ✅ Build itemsBrief (keep your existing logic)
    const itemsBrief = cart.items.map((it, i) => {
      const qty = toQty(it.qty ?? it.quantity, 1);
      const unitPriceN = normalizeMoneyNumber(it.price ?? it.unitPrice);
      if (unitPriceN === null || unitPriceN < 0) {
        throw new Error(`Invalid price for item #${i + 1}. Fix cart item price before checkout.`);
      }

      const productId = String(
        it.customId != null
          ? it.customId
          : it.productId != null
          ? it.productId
          : it.pid != null
          ? it.pid
          : it.sku != null
          ? it.sku
          : ''
      ).trim();

      if (!productId) {
        throw new Error(
          `Missing productId/customId for cart item #${i + 1}. Your cart must store Product.customId.`
        );
      }

      const grossUnit = Number(unitPriceN.toFixed(2));
      const r = Number.isFinite(vatRate) ? vatRate : 0;
      const netUnit = r > 0 ? Number((grossUnit / (1 + r)).toFixed(2)) : grossUnit;

      return {
        productId,
        name: (it.name || it.title || `Item ${i + 1}`).toString().slice(0, 127),
        quantity: qty,
        unitPrice: grossUnit,        // gross
        unitPriceGross: grossUnit,   // gross
        unitPriceNet: netUnit,       // net
        imageUrl: it.imageUrl || it.image || '',
        variants: it.variants || {},
      };
    });

    // ✅ Shippo selection must come from checkout
    let shippoRateId = safeStr(req.body?.shippoRateId, 128);
    let shippoShipmentId = safeStr(req.body?.shippoShipmentId, 128);

    // ✅ Fallback: if frontend forgot to send, use remember-rate session (if present)
    if ((!shippoRateId || !shippoShipmentId) && req.session?.shippoSelectedRate) {
      shippoRateId = shippoRateId || safeStr(req.session.shippoSelectedRate.rateId, 128);
      shippoShipmentId = shippoShipmentId || safeStr(req.session.shippoSelectedRate.shipmentId, 128);
    }

    // ✅ Extra fallback: use current quote shipmentId as last resort (prevents missing shipmentId bugs)
    if (!shippoShipmentId && req.session?.shippoQuote?.shipmentId) {
      shippoShipmentId = safeStr(req.session.shippoQuote.shipmentId, 128);
    }

    if (!shippoRateId || !shippoShipmentId) {
      return res.status(422).json({
        ok: false,
        code: 'SHIPPO_RATE_REQUIRED',
        message: 'Please select a shipping rate (Shippo) before paying.',
      });
    }

    // ✅ Validate against the session quote (prevents fake rateId/price)
    const q = req.session?.shippoQuote || null;

    const fresh = q?.createdAt && Date.now() - q.createdAt < 30 * 60 * 1000; // 30 min
    const sameShipment = q?.shipmentId && String(q.shipmentId) === String(shippoShipmentId);

    if (!q || !fresh || !sameShipment) {
      return res.status(409).json({
        ok: false,
        code: 'SHIPPO_QUOTE_EXPIRED',
        message: 'Shipping quote expired. Please re-select your shipping rate.',
      });
    }

    // ✅ Prevent address mismatch (quoted "to" must match current shipping input)
    const toFromInput = shippoToFromShippingInput(shippingInput);
    if (!sameShippoTo(q.to, toFromInput)) {
      return res.status(409).json({
        ok: false,
        code: 'SHIPPO_ADDRESS_CHANGED',
        message: 'Shipping address changed after quoting. Please re-select your shipping rate.',
      });
    }

    const rate = Array.isArray(q.rates)
      ? q.rates.find((r) => String(r.rateId) === String(shippoRateId))
      : null;

    if (!rate) {
      const isProd = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
      return res.status(409).json({
        ok: false,
        code: 'SHIPPO_RATE_NOT_FOUND',
        message: 'Selected shipping rate not found. Please re-select.',
        ...(isProd
          ? {}
          : {
              debug: {
                received: { shippoRateId, shippoShipmentId },
                session: {
                  shipmentId: q?.shipmentId || null,
                  rateIds: Array.isArray(q?.rates) ? q.rates.map((x) => String(x.rateId)) : [],
                },
              },
            }),
      });
    }

    // ✅ This is the ONLY "delivery option" now (Shippo)
    const shippoPicked = {
      shipmentId: String(q.shipmentId),
      rateId: String(rate.rateId),
      provider: rate.provider || null,
      service: rate.service || null,
      days: rate.days ?? null,
      amount: Number(rate.amount || 0),
      currency: rate.currency || upperCcy,
    };

    // ✅ Use the rate amount as delivery/shipping
    const deliveryDollars = Number((Number(rate.amount || 0)).toFixed(2));

    const {
      items: ppItems,
      subTotal,
      vatTotal,
      delivery: del,
      grandTotal: grand,
    } = computeTotalsFromSession(
      {
        items: itemsBrief.map((x) => ({
          name: paypalNameWithVariants(x.name, x.variants),
          description: variantText(x.variants),
          sku: x.productId,
          price: x.unitPrice, // gross input (computeTotalsFromSession converts to NET)
          quantity: x.quantity,
        })),
      },
      deliveryDollars
    );

    // ✅ Shippo-only: PayPal must receive the shipping address
    const shippingPref = 'SET_PROVIDED_ADDRESS';

    const orderBody = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `PK-${Date.now()}`,
          amount: {
            currency_code: upperCcy,
            value: grand.toFixed(2),
            breakdown: {
              item_total: { currency_code: upperCcy, value: subTotal.toFixed(2) },
              tax_total: { currency_code: upperCcy, value: vatTotal.toFixed(2) },
              shipping: { currency_code: upperCcy, value: del.toFixed(2) },
            },
          },
          items: ppItems,
          description: `Shipping: ${shippoPicked.provider || 'Carrier'} ${shippoPicked.service || 'Service'}`.trim(),
          shipping: {
            name: { full_name: shippingInput.fullName },
            address: shippingInput.address,
          },
        },
      ],
      application_context: {
        brand_name: BRAND_NAME_N,
        user_action: 'PAY_NOW',
        shipping_preference: shippingPref,
      },
    };

    const token = await getAccessToken();

    const ppRes = await fetchWithTimeout(`${PP_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    });

    const data = await ppRes.json().catch(() => ({}));

    if (!ppRes.ok) {
      console.error('PayPal create error:', ppRes.status, data);
      return res.status(502).json({
        ok: false,
        code: 'PAYPAL_CREATE_FAILED',
        message: `PayPal create order failed (${ppRes.status}).`,
        details: String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? undefined : data,
      });
    }

    // ✅ Persist what we need for capture-order + optional label buying
    req.session.pendingOrder = {
      id: data.id,
      itemsBrief,

      deliveryOptionId: null, // ✅ shippo-only
      deliveryName: `Shippo: ${(shippoPicked.provider || 'Carrier')} ${(shippoPicked.service || 'Service')}`.trim(),
      deliveryDays: shippoPicked.days ?? 0,
      deliveryPrice: del,

      subTotal,
      vatTotal,
      grandTotal: grand,
      currency: upperCcy,

      shippo: {
        shipmentId: shippoPicked.shipmentId,
        payerShipmentId: shippoPicked.shipmentId,
        // ✅ keep both (backward compatible)
        payerRateId: shippoPicked.rateId,
        rateId: shippoPicked.rateId,
        provider: shippoPicked.provider || null,
        service: shippoPicked.service || null,
        days: shippoPicked.days ?? null,
        amount: shippoPicked.amount ?? null,
        currency: shippoPicked.currency || upperCcy,

        // ✅ bring customs/intl info from the session quote
        isInternational: !!q?.isInternational,
        fromCountry: q?.fromCountry ? String(q.fromCountry).toUpperCase() : null,
        toCountry: q?.toCountry ? String(q.toCountry).toUpperCase() : null,
        customsDeclarationId: q?.customsDeclarationId ? String(q.customsDeclarationId) : null,
      },

      shippingInput: {
        fullName: shippingInput.fullName,
        phone: shippingInput.phone || null,
        email: shippingInput.email || null,
        address: shippingInput.address,
      },

      createdAt: Date.now(),
    };

    await saveSession(req);

    return res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('create-order error:', err?.stack || err);
    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: err?.message || 'Server error creating order',
    });
  }
});

// ======================================================
// ✅ CAPTURE ORDER (PayPal)
// ======================================================
router.post('/capture-order', requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    const orderID = safeStr(req.body?.orderID || req.query?.orderId, 128);
    if (!orderID) {
      return res.status(400).json({ ok: false, code: 'MISSING_ORDER_ID', message: 'Missing orderId/orderID' });
    }

    const pending = req.session.pendingOrder || null;

    // ✅ must have a pending session order (guest-safe & abuse-safe)
    if (!pending?.id) {
      return res.status(409).json({
        ok: false,
        code: 'NO_PENDING_ORDER',
        message: 'No pending checkout found. Please restart checkout.',
      });
    }

    // ✅ prevent cross-session capture
    if (String(pending.id) !== String(orderID)) {
      return res.status(409).json({
        ok: false,
        code: 'ORDER_MISMATCH',
        message: 'OrderID does not match the pending session order.',
      });
    }

    const token = await getAccessToken();

    const capRes = await fetchWithTimeout(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const capture = await capRes.json().catch(() => ({}));

    if (!capRes.ok) {
      console.error('PayPal capture error:', capture);
      return res.status(capRes.status).json({
        ok: false,
        code: 'PAYPAL_CAPTURE_FAILED',
        message: 'PayPal capture failed',
        details: String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? undefined : capture,
      });
    }

    const pu = capture?.purchase_units?.[0] || {};
    const cap0 = Array.isArray(pu?.payments?.captures) ? pu.payments.captures[0] : null;

    const payer = capture?.payer || {};
    const payerName = payer?.name || {};
    const payerGivenName = payerName.given_name || payerName.given || '';
    const payerSurname = payerName.surname || payerName.family_name || '';
    const payerFullName = [payerGivenName, payerSurname].filter(Boolean).join(' ');

    const puShipping = pu.shipping || {};
    const puAddr = puShipping.address || {};

    const pendingShip = pending?.shippingInput || null;
    const shipPhone = pendingShip?.phone || null;
    const shipEmail = pendingShip?.email || payer.email_address || null;

    // 1) Prefer PayPal shipping (source of truth if present)
    let shippingAddress = {
      name: puShipping.name?.full_name || puShipping.name?.name || payerFullName || 'No name provided',
      phone: shipPhone,
      email: shipEmail,
      address_line_1: puAddr.address_line_1 || puAddr.line1 || '',
      address_line_2: puAddr.address_line_2 || puAddr.line2 || '',
      admin_area_2: puAddr.admin_area_2 || puAddr.city || '',
      admin_area_1: puAddr.admin_area_1 || puAddr.state || '',
      postal_code: puAddr.postal_code || '',
      country_code: puAddr.country_code || '',
    };

    // 2) If PayPal didn't provide address, fall back to the session shippingInput you validated in create-order
    const paypalMissing =
      !shippingAddress.address_line_1 ||
      !shippingAddress.admin_area_2 ||
      !shippingAddress.admin_area_1 ||
      !shippingAddress.postal_code ||
      !shippingAddress.country_code;

    if (paypalMissing && pendingShip?.address) {
      shippingAddress = {
        name: pendingShip.fullName || shippingAddress.name,
        phone: shipPhone,
        email: shipEmail,
        address_line_1: pendingShip.address.address_line_1 || '',
        address_line_2: pendingShip.address.address_line_2 || '',
        admin_area_2: pendingShip.address.admin_area_2 || '',
        admin_area_1: pendingShip.address.admin_area_1 || '',
        postal_code: pendingShip.address.postal_code || '',
        country_code: pendingShip.address.country_code || '',
      };
    }

    const finalAmount =
      cap0?.amount ||
      pu?.amount || {
        value: String(pending?.grandTotal || '0'),
        currency_code: upperCcy,
      };

    const captureId = cap0?.id || null;

    const srb = cap0?.seller_receivable_breakdown || null;
    const paypalFeeVal = srb?.paypal_fee?.value ?? null;
    const netVal = srb?.net_amount?.value ?? null;
    const grossVal = srb?.gross_amount?.value ?? null;

    const itemsFromPending = Array.isArray(pending?.itemsBrief)
      ? pending.itemsBrief.map((it) => {
          const grossN = normalizeMoneyNumber(it?.unitPriceGross ?? it?.unitPrice);
          const grossUnit = grossN === null ? 0 : Number(grossN.toFixed(2));

          const netN = normalizeMoneyNumber(it?.unitPriceNet);
          const r = Number.isFinite(vatRate) ? vatRate : 0;
          const computedNet = r > 0 ? Number((grossUnit / (1 + r)).toFixed(2)) : grossUnit;
          const netUnit = netN === null ? computedNet : Number(netN.toFixed(2));

          return {
            productId: String(it?.productId || '').trim(), // ✅ Product.customId
            name: it?.name || '',
            quantity: toQty(it?.quantity, 1),

            // ✅ IMPORTANT:
            // price = NET (seller crediting will use this)
            price: { value: toMoney2(netUnit), currency: upperCcy },

            // ✅ keep gross for receipts/UI
            priceGross: { value: toMoney2(grossUnit), currency: upperCcy },

            imageUrl: it?.imageUrl || '',
            variants: it?.variants || {},
          };
        })
      : [];

    // ✅ ANYONE can buy (user or business buyer)
    const businessBuyer = getBusinessId(req) || null;
    const userId = getUserId(req) || null;

    let doc = null;

    // Persist order (best effort)
    try {
      if (Order) {
        const captureEntry =
          cap0 && captureId
            ? {
                captureId,
                status: cap0.status || undefined,
                amount: cap0.amount
                  ? { value: String(cap0.amount.value || '0'), currency: cap0.amount.currency_code || upperCcy }
                  : undefined,
                sellerReceivable: srb
                  ? {
                      gross:
                        grossVal != null
                          ? { value: String(grossVal), currency: cap0.amount?.currency_code || upperCcy }
                          : undefined,
                      paypalFee:
                        paypalFeeVal != null
                          ? { value: String(paypalFeeVal), currency: cap0.amount?.currency_code || upperCcy }
                          : undefined,
                      net:
                        netVal != null
                          ? { value: String(netVal), currency: cap0.amount?.currency_code || upperCcy }
                          : undefined,
                    }
                  : undefined,
                createTime: cap0?.create_time ? new Date(cap0.create_time) : undefined,
                updateTime: cap0?.update_time ? new Date(cap0.update_time) : undefined,
              }
            : null;

        const paidLike = String(capture?.status || '').toUpperCase() === 'COMPLETED';

        const update = {
          orderId: orderID,
          status: String(capture?.status || 'COMPLETED'),
          paymentStatus: paidLike ? 'paid' : (safeStr(capture?.status, 32).toLowerCase() || 'unknown'),

          platformFeeBps: PLATFORM_FEE_BPS, // ✅ ADDED THIS

          paypal: { orderId: orderID, captureId: captureId || null },

          payer: {
            payerId: payer.payer_id || null,
            email: payer.email_address || null,
            name: { given: payerGivenName, surname: payerSurname },
            countryCode: payer.address?.country_code || shippingAddress.country_code,
          },

          shipping: shippingAddress,

          amount: { value: toMoney2(finalAmount.value || '0'), currency: finalAmount.currency_code || upperCcy },

          breakdown: pending
            ? {
                itemTotal: pending.subTotal != null ? { value: toMoney2(pending.subTotal), currency: upperCcy } : undefined,
                taxTotal: pending.vatTotal != null ? { value: toMoney2(pending.vatTotal), currency: upperCcy } : undefined,
                shipping: pending.deliveryPrice != null ? { value: toMoney2(pending.deliveryPrice), currency: upperCcy } : undefined,
              }
            : undefined,

          delivery: pending
            ? {
                id: pending.deliveryOptionId || null,
                name: pending.deliveryName || null,
                deliveryDays: pending.deliveryDays ?? null,
                amount: pending.deliveryPrice != null ? toMoney2(pending.deliveryPrice) : null,
              }
            : null,

          items: itemsFromPending,
          raw: capture,

          userId,
          businessBuyer,
        };

        doc = await Order.findOneAndUpdate(
          { orderId: orderID },
          { $set: update, $setOnInsert: { createdAt: new Date() } },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        // ✅ Payment succeeded, but fulfillment may still be pending
        // IMPORTANT: must match enum values (UPPERCASE)
        if (!doc.fulfillmentStatus) {
          doc.fulfillmentStatus = 'PENDING';
        } else {
          // normalize if something saved lowercase by mistake
          const fs = String(doc.fulfillmentStatus || '').toUpperCase();
          doc.fulfillmentStatus = fs || 'PENDING';
        }

        // Optional: if PayPal capture completed, you can mark fulfillment as PAID
        // (keep this ONLY if you want that behavior)
        // const paidLike = String(capture?.status || '').toUpperCase() === 'COMPLETED';
        // if (paidLike) doc.fulfillmentStatus = 'PAID';

        await doc.save();

        // ======================================================
        // ✅ Persist Shippo payer-selected rateId for Admin Shippo
        // DO NOT overwrite an existing purchased label/transaction
        // ======================================================
        try {
          const pShippo = pending?.shippo || null;

          if (doc && pShippo?.rateId && pShippo?.shipmentId) {
            doc.shippo = doc.shippo || {};

            // ✅ Always keep payer choice if we have it (even after purchase)
            if (!doc.shippo.payerShipmentId && (pShippo.payerShipmentId || pShippo.shipmentId)) {
              doc.shippo.payerShipmentId = String(pShippo.payerShipmentId || pShippo.shipmentId);
            }
            if (!doc.shippo.payerRateId && pShippo.rateId) {
              doc.shippo.payerRateId = String(pShippo.rateId);
            }

            const alreadyPurchased =
              !!doc.shippo.transactionId ||
              !!doc.shippo.labelUrl ||
              !!doc.shippo.trackingNumber;

            // ✅ always persist customs/intl metadata if present (even if label already exists)
            if (pShippo.customsDeclarationId && !doc.shippo.customsDeclarationId) {
              doc.shippo.customsDeclarationId = String(pShippo.customsDeclarationId);
            }
            if (
              typeof pShippo.isInternational === 'boolean' &&
              typeof doc.shippo.isInternational !== 'boolean'
            ) {
              doc.shippo.isInternational = pShippo.isInternational;
            }
            if (pShippo.fromCountry && !doc.shippo.fromCountry) {
              doc.shippo.fromCountry = String(pShippo.fromCountry).toUpperCase();
            }
            if (pShippo.toCountry && !doc.shippo.toCountry) {
              doc.shippo.toCountry = String(pShippo.toCountry).toUpperCase();
            }

            if (!alreadyPurchased) {
              // ✅ shipment used to generate rates at checkout
              doc.shippo.shipmentId = String(pShippo.shipmentId);

              // ✅ admin "payer choice" requires this
              doc.shippo.payerShipmentId = String(pShippo.payerShipmentId || pShippo.shipmentId);

              // ✅ store payer choice permanently
              doc.shippo.payerRateId = String(pShippo.rateId);

              // ✅ keep rateId for backwards compatibility / existing UI
              doc.shippo.rateId = String(pShippo.rateId);

              doc.shippo.createdAt = new Date();

              doc.shippo.chosenRate = {
                provider: pShippo.provider ? String(pShippo.provider).slice(0, 80) : null,
                service: pShippo.service ? String(pShippo.service).slice(0, 120) : null,
                amount:
                  pShippo.amount != null && Number.isFinite(Number(pShippo.amount))
                    ? String(Number(pShippo.amount).toFixed(2))
                    : null,
                currency: pShippo.currency ? String(pShippo.currency).toUpperCase() : upperCcy,
                estimatedDays:
                  pShippo.days != null && Number.isFinite(Number(pShippo.days))
                    ? Math.max(0, Math.floor(Number(pShippo.days)))
                    : null,
                durationTerms:
                  pShippo.days != null && Number.isFinite(Number(pShippo.days))
                    ? `~${Math.max(0, Math.floor(Number(pShippo.days)))} days`
                    : null,
              };

              await doc.save();
            }
          }
        } catch (e) {
          console.warn('⚠️ Could not persist Shippo selection:', e?.message || String(e));
        }

        if (doc && captureEntry) {
          const already = Array.isArray(doc.captures)
            ? doc.captures.some((c) => String(c?.captureId || '') === String(captureId))
            : false;
          if (!already) {
            doc.captures = Array.isArray(doc.captures) ? doc.captures : [];
            doc.captures.push(captureEntry);
            await doc.save();
          }
        }

        // ✅ credit sellers (ledger) best effort
        try {
          if (doc && typeof creditSellersFromOrder === 'function') {
            const paidStatus = String(capture?.status || doc.status || '').toUpperCase();
            if (paidStatus === 'COMPLETED' || paidStatus === 'PAID') {
              const feeBps = Number.isFinite(doc?.platformFeeBps) ? doc.platformFeeBps : PLATFORM_FEE_BPS;
              await creditSellersFromOrder(doc, { platformFeeBps: feeBps, onlyIfPaidLike: false });
            }
          }
        } catch (e) {
          console.error('⚠️ Seller crediting failed (checkout continues):', e?.message || e);
        }

        // ✅ stock decrement (IDEMPOTENT)
        try {
          const paidStatus = String(capture?.status || doc?.status || '').toUpperCase();
          if (doc && (paidStatus === 'COMPLETED' || paidStatus === 'PAID')) {
            const invOut = await applyInventoryOnPaidOrder(doc);
            if (!invOut.ok) console.warn('⚠️ Inventory decrement failed:', invOut);
          }
        } catch (invErr) {
          console.warn('⚠️ Inventory decrement exception:', invErr?.message || String(invErr));
        }
      }
    } catch (e) {
      console.error('❌ Failed to persist Order:', e?.message || e);
    }

    req.session.lastOrderSnapshot = {
      ...buildSessionSnapshot(orderID, pending),
      shipping: shippingAddress,
      amount: { value: Number(normalizeMoneyNumber(finalAmount?.value) ?? pending?.grandTotal ?? 0) },
      currency: String(finalAmount?.currency_code || pending?.currency || upperCcy).toUpperCase(),
    };

    req.session.cart = { items: [] };
    req.session.pendingOrder = null;
    req.session.shippoSelectedRate = null; // ✅ clear after successful payment
    req.session.shippoQuote = null;        // optional: clear quote too
    await saveSession(req);

    return res.json({
      ok: true,
      orderId: orderID,
      capture,
      hasShipping: !!shippingAddress.address_line_1,
      amount: finalAmount,
      captureId,
    });
  } catch (err) {
    console.error('capture-order error:', err?.stack || err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: 'Server error capturing order' });
  }
});

// ======================================================
// ✅ THANK-YOU JSON fetch (ONLY owner/admin; snapshot allowed for same session)
// GET /payment/order/:id
// ======================================================
router.get('/order/:id', async (req, res) => {
  try {
    const id = safeStr(req.params.id, 128);
    const snap = req.session?.lastOrderSnapshot;

    if (!isAnyLoggedIn(req)) {
      if (snap && String(snap.id) === id) return res.json({ success: true, order: snap });
      return res.status(401).json({ success: false, message: 'Login required.' });
    }

    if (Order) {
      const doc = await findOrderByAnyId(id);
      if (doc) {
        if (!docOwnedByRequester(req, doc)) return res.status(403).json({ success: false, message: 'Forbidden.' });
        return res.json({ success: true, order: shapeOrderForClient(doc) });
      }
    }

    if (snap && String(snap.id) === id) return res.json({ success: true, order: snap });

    return res.status(404).json({ success: false, message: 'Order not found' });
  } catch (err) {
    console.error('order fetch error:', err?.stack || err);
    return res.status(500).json({ success: false, message: 'Server error loading order' });
  }
});

router.get('/thank-you', (req, res) => {
  const id = safeStr(req.query.orderId, 128);
  const snapId = req.session?.lastOrderSnapshot?.id;

  if (!id && snapId) return res.redirect(`/payment/thank-you?orderId=${encodeURIComponent(snapId)}`);

  return res.render('thank-you', {
    title: 'Thank you',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ['Payment captured successfully.'],
    error: [],
  });
});

router.get('/success', (req, res) => {
  const qid = safeStr(req.query.id, 128);
  const snapId = req.session?.lastOrderSnapshot?.id;

  if (!qid && snapId) return res.redirect(`/payment/success?id=${encodeURIComponent(snapId)}`);

  return res.render('thank-you', {
    title: 'Thank you',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ['Payment captured successfully.'],
    error: [],
  });
});

// ======================================================
// ✅ RECEIPT (owner/admin OR valid token)
// GET /payment/receipt/:id
// ======================================================
router.get('/receipt/:id', async (req, res) => {
  try {
    if (!Order) return res.status(500).send('Order model not available.');

    const wantedId = String(req.params.id || '').trim();
    if (!wantedId) return res.redirect('/payment/orders');

    const doc = await findOrderByAnyId(wantedId);
    if (!doc) {
      req.flash?.('error', 'Receipt not found.');
      return res.redirect('/payment/orders');
    }

    const tokenFromQuery = String(req.query.t || '').trim();
    const expectedToken = makeReceiptToken(doc.orderId || wantedId);
    const tokenOk = expectedToken && tokenFromQuery && safeEq(tokenFromQuery, expectedToken);

    const loggedIn = isAnyLoggedIn(req);
    const ownerOk = loggedIn && docOwnedByRequester(req, doc);

    if (!tokenOk && !ownerOk) {
      if (!loggedIn) {
        req.flash?.('error', 'Please login to view your receipt.');
        return res.redirect('/users/login');
      }
      return res.status(403).send('Forbidden.');
    }

    return res.render('receipt', {
      title: 'Receipt',
      themeCss: themeCssFrom(req),
      nonce: resNonce(req),
      order: doc,
      brandName: BRAND_NAME_N,
      currency: doc?.amount?.currency || doc?.currency || upperCcy,
      publicMode: tokenOk && !loggedIn,
      shareLink: doc?.orderId ? buildReceiptLink(doc.orderId) : null,
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  } catch (err) {
    console.error('receipt error:', err);
    return res.status(500).send('Failed to load receipt.');
  }
});

router.get('/cancel', (req, res) => {
  return res.render('payment-cancel', {
    title: 'Payment Cancelled',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: [],
    error: ['Payment was cancelled or failed.'],
  });
});

// ======================================================
// ✅ My Orders JSON
// GET /payment/my-orders
// - Buyer/User: returns purchases for current identity
// - Seller/Supplier business: returns orders that CONTAIN seller items,
//   but returns ONLY seller items + shipping + status.
// ======================================================
router.get('/my-orders', requireAnyAuthJson, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, error: 'Order model not available.' });

    const userId = getUserId(req);
    const businessId = getBusinessId(req);

    // ------------------------------------------------------
    // ✅ SELLER MODE: "contains items belonging to seller"
    // ------------------------------------------------------
    if (businessId && isSellerBusiness(req)) {
      if (!Product) {
        return res
          .status(500)
          .json({ ok: false, error: 'Product model not available (seller view).' });
      }

      // 1) Find all Product.customId owned by this business (try common field names)
      const bizIds = asIdVariants(businessId);

      const sellerProducts = await Product.find({
        $or: [
          { businessId: { $in: bizIds } },
          { sellerId: { $in: bizIds } },
          { seller: { $in: bizIds } },
          { ownerBusiness: { $in: bizIds } },
          { business: { $in: bizIds } },
        ],
      })
        .select('customId')
        .lean();

      const sellerIds = sellerProducts
        .map((p) => String(p?.customId || '').trim())
        .filter(Boolean);

      if (!sellerIds.length) {
        return res.json({ ok: true, orders: [] });
      }

      // ⚠️ safety cap (avoid giant $in queries)
      const cappedIds = sellerIds.slice(0, 5000);
      const sellerIdSet = new Set(cappedIds);

      // 2) Query orders that contain ANY of these productIds
      const orders = await Order.find({ 'items.productId': { $in: cappedIds } })
        .sort({ createdAt: -1 })
        .limit(200)
        .select(
          'orderId paypalOrderId status paymentStatus fulfillmentStatus createdAt amount total totalAmount currency items shipping shippingTracking refunds refundedTotal'
        )
        .lean();

      // 3) Return only seller items per order + shipping + status
      const normalized = orders.map((o) => {
        const orderId = o.orderId || o.paypalOrderId || (o._id ? String(o._id) : '');

        const status = String(o.status || 'PROCESSING');
        const paymentStatus = String(o.paymentStatus || '').toLowerCase();
        const fulfillmentStatus = String(o.fulfillmentStatus || '').toLowerCase();

        const currency =
          (o.amount && (o.amount.currency ?? o.amount.currency_code ?? o.currency)) ??
          o.currency ??
          upperCcy;

        const allItems = Array.isArray(o.items) ? o.items : [];
        const sellerItems = allItems.filter((it) => sellerIdSet.has(pickItemProductId(it)));

        // seller-only total (display helper)
        const sellerAmount = +sellerItems
          .reduce((sum, it) => sum + itemLineTotal(it), 0)
          .toFixed(2);

        return {
          id: o._id ? String(o._id) : orderId,
          orderId,
          status,
          paymentStatus,
          fulfillmentStatus,
          createdAt: o.createdAt,
          currency: String(currency || upperCcy).toUpperCase(),

          // ✅ seller-only view:
          amount: sellerAmount,
          items: sellerItems,

          // ✅ include shipping + tracking + refund summary
          shipping: o.shipping || null,
          shippingTracking: o.shippingTracking || {},
          refundedTotal: o.refundedTotal ?? null,
          refundsCount: Array.isArray(o.refunds) ? o.refunds.length : 0,

          receiptLink: orderId ? buildReceiptLink(orderId) : null,
        };
      });

      // Remove orders where sellerItems ended up empty (extra safety)
      const filtered = normalized.filter((o) => Array.isArray(o.items) && o.items.length > 0);

      return res.json({ ok: true, orders: filtered });
    }

    // ------------------------------------------------------
    // ✅ BUYER/USER MODE: only purchases for this identity
    // ------------------------------------------------------
    let query = null;
    if (businessId) query = { businessBuyer: businessId };
    else if (userId) query = { userId };
    else return res.status(401).json({ ok: false, error: 'Not logged in.' });

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .select(
        'orderId paypalOrderId status paymentStatus fulfillmentStatus createdAt amount total totalAmount currency items shipping shippingTracking refunds refundedTotal'
      )
      .lean();

    const normalized = orders.map((o) => {
      const orderId = o.orderId || o.paypalOrderId || (o._id ? String(o._id) : '');

      const status = String(o.status || 'PROCESSING');
      const paymentStatus = String(o.paymentStatus || '').toLowerCase();
      const fulfillmentStatus = String(o.fulfillmentStatus || '').toLowerCase();

      let amountRaw =
        (o.amount && (o.amount.value ?? o.amount)) ??
        (o.total?.value ?? o.total) ??
        (o.totalAmount?.value ?? o.totalAmount) ??
        0;

      if (amountRaw && typeof amountRaw === 'object') {
        amountRaw = amountRaw.value ?? amountRaw.amount ?? 0;
      }

      const amountNum = Number(amountRaw);
      const amount = Number.isFinite(amountNum) ? amountNum : 0;

      const currency =
        (o.amount && (o.amount.currency ?? o.amount.currency_code ?? o.currency)) ??
        o.currency ??
        upperCcy;

      return {
        id: o._id ? String(o._id) : orderId,
        orderId,
        status,
        paymentStatus,
        fulfillmentStatus,
        createdAt: o.createdAt,
        amount,
        currency: String(currency || upperCcy).toUpperCase(),
        items: Array.isArray(o.items) ? o.items : [],
        shipping: o.shipping || null,
        shippingTracking: o.shippingTracking || {},
        refundedTotal: o.refundedTotal ?? null,
        refundsCount: Array.isArray(o.refunds) ? o.refunds.length : 0,
        receiptLink: orderId ? buildReceiptLink(orderId) : null,
      };
    });

    return res.json({ ok: true, orders: normalized });
  } catch (err) {
    console.error('GET /payment/my-orders error:', err);
    return res.status(500).json({ ok: false, error: 'Failed to load orders.' });
  }
});

// ======================================================
// 💸 Admin Refunds
// POST /payment/refund
// ======================================================
function refundSoFarWouldExceed(captured, refundedSoFar, want) {
  const remaining = captured - refundedSoFar;
  return want > remaining + 0.00001;
}

router.post('/refund', requireAdmin, requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    const captureId = safeStr(req.body?.captureId, 128);
    if (!captureId) return res.status(400).json({ success: false, message: 'captureId is required.' });

    const amountNum = normalizeMoneyNumber(req.body?.amount);
    if (amountNum !== null && (!Number.isFinite(amountNum) || amountNum <= 0)) {
      return res.status(400).json({
        success: false,
        message: 'Amount must be a positive number, or omit for full refund.',
      });
    }

    let currency = safeStr(req.body?.currency || upperCcy, 8).toUpperCase();

    let orderDoc = null;
    if (Order) {
      orderDoc = await findOrderByCaptureId(captureId);

      const bodyOrderId = safeStr(req.body?.orderId, 64);
      if (bodyOrderId && orderDoc) {
        const dbOrderId = String(orderDoc.orderId || orderDoc._id);
        if (dbOrderId !== bodyOrderId) {
          return res.status(400).json({ success: false, message: 'captureId does not match the provided orderId.' });
        }
      }
    }

    if (orderDoc) {
      const captured = getCapturedAmountFromOrder(orderDoc);
      const refundedSoFar = sumRefundedFromOrder(orderDoc);

      const capturedCcy = String(captured?.currency || '').toUpperCase();
      if (capturedCcy) currency = capturedCcy;

      if (captured.value != null) {
        const want = amountNum === null ? captured.value - refundedSoFar : amountNum;

        if (want <= 0) {
          return res.status(400).json({ success: false, message: 'Nothing left to refund for this capture.' });
        }

        if (refundSoFarWouldExceed(captured.value, refundedSoFar, want)) {
          return res.status(400).json({
            success: false,
            message: `Refund exceeds remaining refundable amount (${(captured.value - refundedSoFar).toFixed(2)}).`,
          });
        }
      }
    }

    const payload = {};
    if (amountNum !== null) payload.amount = { value: amountNum.toFixed(2), currency_code: currency };

    const note = safeStr(req.body?.note, 255);
    if (note) payload.note_to_payer = note;

    const token = await getAccessToken();

    const ppRes = await fetchWithTimeout(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const refundJson = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error('PayPal refund error:', ppRes.status, refundJson);
      return res.status(502).json({
        success: false,
        message: refundJson?.message || `PayPal refund failed (${ppRes.status}).`,
        details: String(process.env.NODE_ENV || '').toLowerCase() === 'production' ? undefined : refundJson,
      });
    }

    let duplicated = false;
    let ledger = null;
    let inventoryRestore = null;

    // Persist refund to DB + seller debit + reconcile (best effort)
    try {
      if (orderDoc) {
        const refundId = refundJson?.id ? String(refundJson.id) : null;
        const paypalRefundValue = refundJson?.amount?.value ?? null;
        const paypalRefundCurrency = refundJson?.amount?.currency_code ?? null;

        const refundedAmountStr = safeMoneyString(
          paypalRefundValue ?? (amountNum !== null ? amountNum.toFixed(2) : null),
          32
        );
        const refundedCurrencyStr = String(paypalRefundCurrency || currency || upperCcy).toUpperCase();

        orderDoc.refunds = Array.isArray(orderDoc.refunds) ? orderDoc.refunds : [];
        if (refundId) duplicated = orderDoc.refunds.some((r) => String(r?.refundId || '') === refundId);

        if (!duplicated) {
          orderDoc.refunds.push({
            refundId,
            status: refundJson?.status || null,
            amount: refundedAmountStr,
            currency: refundedCurrencyStr || null,
            createdAt: new Date(),
            source: 'admin-refund',
          });
        }

        const captured = getCapturedAmountFromOrder(orderDoc);
        const refundedSoFar = sumRefundedFromOrder(orderDoc);

        orderDoc.refundedTotal = String(refundedSoFar.toFixed(2));
        orderDoc.refundedAt = new Date();

        if (captured.value != null) {
          if (refundedSoFar >= captured.value - 0.00001) {
            orderDoc.status = 'REFUNDED';
            orderDoc.paymentStatus = 'refunded';
          } else if (refundedSoFar > 0) {
            orderDoc.status = 'PARTIALLY_REFUNDED';
            orderDoc.paymentStatus = 'partially_refunded';
          }
        } else {
          orderDoc.status = 'REFUND_SUBMITTED';
          orderDoc.paymentStatus = 'refund_submitted';
        }

        await orderDoc.save();

        // ✅ restore inventory ONLY on full refund (IDEMPOTENT)
        try {
          if (String(orderDoc.status || '').toUpperCase() === 'REFUNDED') {
            inventoryRestore = await restoreInventoryOnRefundedOrder(orderDoc, 'admin-refund');
            if (!inventoryRestore.ok) console.warn('⚠️ Inventory restore failed:', inventoryRestore);
          }
        } catch (e) {
          console.warn('⚠️ Inventory restore exception:', e?.message || String(e));
        }

        // ✅ debit sellers using PayPal-returned amount
        if (typeof debitSellersFromRefund === 'function') {
          try {
            ledger = await debitSellersFromRefund(orderDoc, {
              refundId,
              amount: paypalRefundValue ?? refundedAmountStr,
              currency: refundedCurrencyStr,
              allowWhenUnpaid: true,
              platformFeeBps: Number.isFinite(orderDoc?.platformFeeBps)
                ? orderDoc.platformFeeBps
                : PLATFORM_FEE_BPS,
            });
          } catch (e2) {
            ledger = { ok: false, error: e2?.message || String(e2) };
          }
        } else {
          ledger = { ok: false, error: 'debitSellersFromRefund not available' };
        }

        try {
          await reconcileRefundsForOrderDoc(orderDoc, captureId, { source: 'admin-refund-sync' });
        } catch (e3) {
          console.warn('⚠️ reconcileRefundsForOrderDoc failed:', e3?.message || String(e3));
        }
      } else {
        console.warn('⚠️ Refund succeeded in PayPal but no matching orderDoc found for captureId:', captureId);
      }
    } catch (e) {
      console.warn('⚠️ Refund saved to PayPal but failed to persist to DB:', e?.message || String(e));
    }

    return res.json({ success: true, refund: refundJson, duplicated, ledger, inventoryRestore });
  } catch (err) {
    console.error('refund error:', err?.stack || err);
    return res.status(500).json({ success: false, message: 'Server error refunding payment.' });
  }
});

// ======================================================
// 🔒 Manual sync routes (ADMIN ONLY)
// ======================================================
router.post('/sync-refunds', requireAdmin, requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    const captureId = safeStr(req.body?.captureId, 128);
    if (!captureId) return res.status(400).json({ ok: false, message: 'captureId is required.' });
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const orderDoc = await findOrderByCaptureId(captureId);
    if (!orderDoc) {
      return res.status(404).json({
        ok: false,
        message: 'No local order found for this captureId. Refund exists in PayPal, but your DB has no matching order.',
      });
    }

    const out = await reconcileRefundsForOrderDoc(orderDoc, captureId, { source: 'sync-refunds' });

    // If full refund detected, restore inventory
    try {
      if (out?.ok && String(out.status || '').toUpperCase() === 'REFUNDED') {
        await restoreInventoryOnRefundedOrder(orderDoc, 'sync-refunds');
      }
    } catch (e) {
      console.warn('⚠️ restoreInventoryOnRefundedOrder (sync-refunds) failed:', e?.message || String(e));
    }

    return res.json(out);
  } catch (err) {
    console.error('sync-refunds error:', err?.stack || err);
    return res.status(500).json({ ok: false, message: err?.message || 'Server error syncing refunds.' });
  }
});

router.post('/reconcile-recent-refunds', requireAdmin, requireAllowedOriginJson, express.json(), async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const days = Math.max(1, Math.min(120, Number(req.body?.days || 30)));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const candidates = await Order.find({
      createdAt: { $gte: since },
      status: { $in: ['COMPLETED', 'PAID', 'REFUND_SUBMITTED', 'PARTIALLY_REFUNDED', 'REFUNDED'] },
      $or: [
        { 'paypal.captureId': { $exists: true, $ne: null } },
        { 'captures.0.captureId': { $exists: true } },
      ],
    }).sort({ createdAt: -1 });

    const results = [];
    let changed = 0;

    for (const orderDoc of candidates) {
      const cid =
        orderDoc?.paypal?.captureId ||
        (Array.isArray(orderDoc.captures) && orderDoc.captures[0]?.captureId) ||
        null;

      if (!cid) continue;

      const out = await reconcileRefundsForOrderDoc(orderDoc, cid, { source: 'reconcile-recent' });
      results.push(out);
      if (out?.ok && out.newlyAdded > 0) changed++;

      // If now fully refunded, restore inventory
      try {
        if (out?.ok && String(out.status || '').toUpperCase() === 'REFUNDED') {
          await restoreInventoryOnRefundedOrder(orderDoc, 'reconcile-recent-refunds');
        }
      } catch (e) {
        console.warn('⚠️ restoreInventoryOnRefundedOrder (reconcile-recent) failed:', e?.message || String(e));
      }
    }

    return res.json({ ok: true, days, scanned: candidates.length, changed, results });
  } catch (err) {
    console.error('reconcile-recent-refunds error:', err?.stack || err);
    return res.status(500).json({ ok: false, message: err?.message || 'Server error reconciling refunds.' });
  }
});

// ======================================================
// Export
// ======================================================
router.computeTotalsFromSession = computeTotalsFromSession;
module.exports = router;


