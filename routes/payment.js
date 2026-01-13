// routes/payment.js
'use strict';

const express = require('express');
const router = express.Router();
const { fetch } = require('undici');
const crypto = require('crypto');

const DeliveryOption = require('../models/DeliveryOption');
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

// ======================================================
// ✅ ENV
// ======================================================
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
  BASE_CURRENCY = 'USD',
  VAT_RATE = '0.15',
  BRAND_NAME = 'Phakisi Global',
  SHIPPING_PREF = 'NO_SHIPPING',
  RECEIPT_TOKEN_SECRET = '', // optional (shareable receipt links)
} = process.env;

const PP_API =
  String(PAYPAL_MODE).toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const upperCcy = String(BASE_CURRENCY || 'USD').toUpperCase();
const vatRate = Number(VAT_RATE || 0);
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 1000);

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
// ✅ Delivery helpers
// ======================================================
async function cheapestDelivery() {
  const opt = await DeliveryOption.findOne({ active: true })
    .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
    .lean();

  if (!opt) return { opt: null, dollars: 0 };

  const dollars = Number(((opt.priceCents || 0) / 100).toFixed(2));
  return { opt, dollars };
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

    return {
      name,
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
          platformFeeBps: PLATFORM_FEE_BPS,
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
  let shippingFlat = 0;
  try {
    const { dollars } = await cheapestDelivery();
    shippingFlat = dollars;
  } catch {
    // placeholding
  }

  return res.render('checkout', {
    title: 'Checkout',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    paypalClientId: String(PAYPAL_CLIENT_ID || '').trim(),
    currency: upperCcy,
    brandName: BRAND_NAME,
    vatRate,
    shippingFlat,
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
    mode: PAYPAL_MODE,
    baseCurrency: upperCcy,
    brandName: BRAND_NAME,
  });
});

// ======================================================
// ✅ CREATE ORDER (PayPal)
// ======================================================
router.post('/create-order', express.json(), async (req, res) => {
  try {
    const cart = req.session?.cart || { items: [] };

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({ ok: false, code: 'CART_EMPTY', message: 'Cart is empty (server session).' });
    }

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
        productId, // ✅ MUST be Product.customId (string)
        name: (it.name || it.title || `Item ${i + 1}`).toString().slice(0, 127),
        quantity: qty,

        // ✅ keep unitPrice for compatibility (still gross)
        unitPrice: grossUnit,

        // ✅ add these two (NEW)
        unitPriceGross: grossUnit,
        unitPriceNet: netUnit,

        imageUrl: it.imageUrl || it.image || '',
        variants: it.variants || {},
      };
    });

    const providedId = safeStr(req.body?.deliveryOptionId, 64);
    const simpleDelivery = safeStr(req.body?.delivery, 32).toLowerCase();

    let opt = null;

    if (simpleDelivery === 'collect') {
      opt = { _id: null, name: 'Collect in store', deliveryDays: 0, priceCents: 0, active: true };
    } else if (providedId) {
      try {
        const found = await DeliveryOption.findById(providedId).lean();
        if (found && found.active) opt = found;
      } catch {
        // placeholding
      }
    }

    if (!opt) {
      opt = await DeliveryOption.findOne({ active: true })
        .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
        .lean();
    }

    if (!opt) {
      return res.status(404).json({
        ok: false,
        code: 'NO_ACTIVE_DELIVERY',
        message: 'No active delivery options available.',
      });
    }

    const deliveryDollars = Number(((opt.priceCents || 0) / 100).toFixed(2));

    const { items: ppItems, subTotal, vatTotal, delivery: del, grandTotal: grand } = computeTotalsFromSession(
      { items: itemsBrief.map((x) => ({ name: x.name, price: x.unitPrice, quantity: x.quantity })) },
      deliveryDollars
    );

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
          description: `Delivery: ${opt.name} (${opt.deliveryDays || 0} days)`,
        },
      ],
      application_context: {
        brand_name: BRAND_NAME,
        user_action: 'PAY_NOW',
        shipping_preference: SHIPPING_PREF,
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

    req.session.pendingOrder = {
      id: data.id,
      itemsBrief,
      deliveryOptionId: opt._id ? String(opt._id) : null,
      deliveryName: opt.name,
      deliveryDays: opt.deliveryDays || 0,
      deliveryPrice: del,
      subTotal,
      vatTotal,
      grandTotal: grand,
      currency: upperCcy,
      createdAt: Date.now(),
    };

    await saveSession(req);
    return res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('create-order error:', err?.stack || err);
    return res.status(500).json({ ok: false, code: 'SERVER_ERROR', message: err?.message || 'Server error creating order' });
  }
});

// ======================================================
// ✅ CAPTURE ORDER (PayPal)
// ======================================================
router.post('/capture-order', express.json(), async (req, res) => {
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

    const shippingAddress = {
      name: puShipping.name?.full_name || puShipping.name?.name || payerFullName || 'No name provided',
      address_line_1: puAddr.address_line_1 || puAddr.line1 || '',
      address_line_2: puAddr.address_line_2 || puAddr.line2 || '',
      admin_area_2: puAddr.admin_area_2 || puAddr.city || '',
      admin_area_1: puAddr.admin_area_1 || puAddr.state || '',
      postal_code: puAddr.postal_code || '',
      country_code: puAddr.country_code || '',
    };

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
              const feeBps = Number.isFinite(PLATFORM_FEE_BPS) ? PLATFORM_FEE_BPS : 1000;
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
      brandName: BRAND_NAME,
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
// ✅ My Orders JSON (ONLY purchases for current identity)
// GET /payment/my-orders
// ======================================================
router.get('/my-orders', requireAnyAuth, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, error: 'Order model not available.' });

    const userId = getUserId(req);
    const businessId = getBusinessId(req);

    let query = null;
    if (businessId) query = { businessBuyer: businessId };
    else if (userId) query = { userId };
    else return res.status(401).json({ ok: false, error: 'Not logged in.' });

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(200)
      .select(
        'orderId paypalOrderId status paymentStatus createdAt amount total totalAmount currency items shippingTracking refunds refundedTotal'
      )
      .lean();

    const normalized = orders.map((o) => {
      const orderId = o.orderId || o.paypalOrderId || (o._id ? String(o._id) : '');

      const status = String(o.status || 'PROCESSING');
      const paymentStatus = String(o.paymentStatus || '').toLowerCase();

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
        createdAt: o.createdAt,
        amount,
        currency: String(currency || upperCcy).toUpperCase(),
        items: Array.isArray(o.items) ? o.items : [],
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

router.post('/refund', requireAdmin, express.json(), async (req, res) => {
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
              platformFeeBps: PLATFORM_FEE_BPS,
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
router.post('/sync-refunds', requireAdmin, express.json(), async (req, res) => {
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

router.post('/reconcile-recent-refunds', requireAdmin, express.json(), async (req, res) => {
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
