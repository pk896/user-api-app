// routes/cart.js
'use strict';
const express = require('express');
const Product = require('../models/Product');

const router = express.Router();

/* ------------------------------------------------------------------
 * Second-hand cart policy (server enforcement)
 *
 * ✅ If cart contains ANY second-hand item:
 *    - cart becomes SECOND-HAND-ONLY
 *    - ONLY categories allowed:
 *        • second-hand-clothes
 *        • uncategorized-second-hand-things
 *    - ALL items must be from ONE business (same pickup address/business)
 *
 * ✅ If cart is NORMAL (no second-hand items):
 *    - you CANNOT add second-hand items (must clear cart first)
 * ------------------------------------------------------------------ */
const SECONDHAND_CATS = new Set([
  'second-hand-clothes',
  'uncategorized-second-hand-things',
]);

function isSecondhandCategory(cat) {
  return SECONDHAND_CATS.has(String(cat || '').trim().toLowerCase());
}

// Try hard to find the product’s “business owner” key
function businessKeyFromProduct(p) {
  const v =
    p?.businessId ||
    p?.business?._id ||
    p?.business ||
    p?.sellerBusinessId ||
    p?.seller?.businessId ||
    p?.sellerId ||
    p?.ownerBusinessId ||
    p?.ownerBusiness ||
    '';
  return String(v || '').trim();
}

function businessKeyFromCartItem(it) {
  const v =
    it?.businessId ||
    it?.business?._id ||
    it?.product?.businessId ||
    it?.product?.business?._id ||
    it?.sellerBusinessId ||
    it?.sellerId ||
    '';
  return String(v || '').trim();
}

function categoryFromCartItem(it) {
  return String(it?.category || it?.product?.category || '').trim().toLowerCase();
}

// If cart contains any second-hand items, we lock cart to that business
function getSecondhandLockBusiness(cartItems) {
  const items = Array.isArray(cartItems) ? cartItems : [];
  for (const it of items) {
    const cat = categoryFromCartItem(it);
    if (!isSecondhandCategory(cat)) continue;

    const biz = businessKeyFromCartItem(it);
    if (biz) return biz;
  }
  return '';
}

function cartHasSecondhand(items) {
  const list = Array.isArray(items) ? items : [];
  return list.some((it) => isSecondhandCategory(categoryFromCartItem(it)));
}

function cartHasNonSecondhand(items) {
  const list = Array.isArray(items) ? items : [];
  return list.some((it) => !isSecondhandCategory(categoryFromCartItem(it)));
}

function normVariants(v = {}) {
  const o = {};
  const keys = Object.keys(v || {}).sort();
  for (const k of keys) o[k] = String(v[k] ?? '').trim();
  return o;
}

function variantsEqual(a = {}, b = {}) {
  const A = normVariants(a);
  const B = normVariants(b);
  return JSON.stringify(A) === JSON.stringify(B);
}

// Optional cleanup: if cart is second-hand locked to a business,
// remove any items from other businesses (safety cleanup for legacy data).
function enforceSecondhandLockOnCart(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const lockBiz = getSecondhandLockBusiness(items);
  if (!lockBiz) return { lockBiz: '', removedCount: 0 };

  const before = items.length;
  cart.items = items.filter((it) => {
    const biz = businessKeyFromCartItem(it);
    if (!biz) return true; // keep unknown legacy item
    return biz === lockBiz;
  });

  return { lockBiz, removedCount: before - cart.items.length };
}

function secondhandRejectPayload() {
  return {
    success: false,
    code: 'SECONDHAND_ONE_BUSINESS_ONLY',
    message:
      'Rejected: Your cart already has second-hand items from a different business/location. ' +
      'Second-hand orders must be from ONE business only. ' +
      'Remove those cart items (or clear your cart) to shop other businesses.',
  };
}

function mixingRejectPayload() {
  return {
    success: false,
    code: 'SECONDHAND_NO_MIXING',
    message:
      'Rejected: You cannot mix second-hand items with normal items in the same cart. ' +
      'Please clear your cart to switch modes (normal ↔ second-hand).',
  };
}

function nonSecondhandRejectPayloadWhenSecondhandLocked() {
  return {
    success: false,
    code: 'SECONDHAND_ONLY',
    message:
      'Rejected: Your cart is locked to second-hand items only. ' +
      'You can only add second-hand items (and from the same business). ' +
      'Clear your cart to shop normal items.',
  };
}

function secondhandRejectPayloadWhenNormalCartHasItems() {
  return {
    success: false,
    code: 'NORMAL_ONLY',
    message:
      'Rejected: Your cart has normal items. You must clear your cart before adding second-hand items.',
  };
}

/* ------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------ */
function ensureCart(req) {
  if (!req.session.cart) req.session.cart = { items: [] };
  if (!Array.isArray(req.session.cart.items)) req.session.cart.items = [];

  const r = vatRate(req);

  // ✅ One-time upgrade for old cart items (NET -> GROSS)
  if (!req.session.cart._vatUpgradedOnce) {
    req.session.cart.items = (req.session.cart.items || []).map((it) => {
      if (!it) return it;
      if (it.vatIncluded === true) return it;

      const net = Number(it.priceExVat ?? it.price ?? 0);
      const gross = round2(net * (1 + r));

      return {
        ...it,
        price: gross,
        priceExVat: net,
        vatRate: r,
        vatIncluded: true,
      };
    });

    req.session.cart._vatUpgradedOnce = true;
  } else {
    // ✅ Keep VAT fields consistent for newer items too
    req.session.cart.items = (req.session.cart.items || []).map((it) => {
      if (!it) return it;
      if (it.vatIncluded === true) return it;

      const net = Number(it.priceExVat ?? it.price ?? 0);
      const gross = round2(net * (1 + r));

      return {
        ...it,
        price: gross,
        priceExVat: net,
        vatRate: r,
        vatIncluded: true,
      };
    });
  }

  return req.session.cart;
}

async function findProductByPid(pid) {
  if (!pid) return null;

  // Try customId first
  let p = await Product.findOne({ customId: pid }).lean();
  if (p) return p;

  // Fallback: treat pid as Mongo _id
  try {
    p = await Product.findById(pid).lean();
  } catch {
    // ignore invalid ObjectId
  }
  return p || null;
}

function productUnitPriceNumber(p) {
  if (typeof p.priceCents === 'number') return Number((p.priceCents || 0) / 100);
  return Number(p.price || 0);
}

function normalizeCartItem(p, qty, variants = {}, req) {
  const { net, gross, vatIncluded, vatRate: r } = priceGrossFromProduct(p, req);

  return {
    productId: String(p._id),
    customId: p.customId,
    name: p.name,

    // ✅ store category + businessId in cart (needed for enforcement + UI filtering)
    category: String(p.category || '').trim(),
    businessId: businessKeyFromProduct(p),

    // ✅ Cart stores VAT-inclusive price (gross)
    price: gross,

    // Useful for invoices/admin breakdowns later
    priceExVat: net,
    vatRate: r,
    vatIncluded,

    imageUrl: p.imageUrl || p.image || '',
    quantity: Math.max(1, Math.floor(Number(qty || 1))),
    variants: normVariants(variants),
  };
}

function findIndexById(items, id, variants = {}) {
  const list = items || [];
  const wantVariants = normVariants(variants);
  const hasVariantKeys = Object.keys(wantVariants).length > 0;

  // ✅ Exact match when variants are provided
  if (hasVariantKeys) {
    return list.findIndex((it) => {
      if (String(it.productId) !== String(id)) return false;
      return variantsEqual(it.variants || {}, wantVariants);
    });
  }

  // ✅ Fallback when variants are NOT provided:
  // only match if there is exactly ONE cart line for this product
  // (prevents wrong increment when same product has multiple size/color variants)
  const sameProductIndexes = [];
  for (let i = 0; i < list.length; i++) {
    if (String(list[i]?.productId) === String(id)) sameProductIndexes.push(i);
  }

  if (sameProductIndexes.length === 1) return sameProductIndexes[0];

  // ambiguous or not found
  return -1;
}

function wantsJson(req) {
  const accept = (req.get('accept') || '').toLowerCase();
  return req.query.json === '1' || accept.includes('application/json');
}

function cartCount(items) {
  return (items || []).reduce((n, it) => n + Number(it.quantity || 1), 0);
}

/* ------------------------------------------------------------------
 * VAT helpers (NET in DB, GROSS in cart)
 * ------------------------------------------------------------------ */
function vatRate(_req) {
  const r = Number(process.env.VAT_RATE || 0.15);
  return Number.isFinite(r) ? r : 0.15;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function priceGrossFromProduct(p, req) {
  const net = productUnitPriceNumber(p); // product price in DB (excluding VAT)
  const r = vatRate(req);
  const gross = round2(net * (1 + r));
  return { net, gross, vatIncluded: true, vatRate: r };
}

/* ------------------------------------------------------------------
 * GET /api/cart
 * -> { items: [...] }
 * ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const cart = ensureCart(req);
  return res.json({ items: cart.items || [] });
});

/* ------------------------------------------------------------------
 * GET /api/cart/items (legacy)
 * -> [...]
 * ------------------------------------------------------------------ */
router.get('/items', (req, res) => {
  const cart = ensureCart(req);
  return res.json(cart.items || []);
});

/* ------------------------------------------------------------------
 * GET /api/cart/count
 * -> { count }
 * ------------------------------------------------------------------ */
router.get('/count', (req, res) => {
  const cart = ensureCart(req);
  return res.json({ count: cartCount(cart.items) });
});

/* ------------------------------------------------------------------
 * LEGACY LINK ENDPOINTS (kept for compatibility)
 * - /api/cart/add?pid=...&qty=1[&json=1][&back=/sales]
 * - /api/cart/dec?pid=...&json=1
 * - /api/cart/remove?pid=...&json=1
 * ------------------------------------------------------------------ */
router.get('/add', async (req, res) => {
  try {
    const pid = String(req.query.pid || '').trim();
    const qty = Math.max(1, Number(req.query.qty || 1));
    const product = await findProductByPid(pid);

    if (!product) {
      if (wantsJson(req)) return res.status(404).json({ success: false, message: 'Product not found.' });
      if (typeof req.flash === 'function') req.flash('error', 'Product not found.');
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    // Parse variants from query parameter (JSON or simple size/color)
    let variantData = {};
    if (req.query.variants) {
      try {
        variantData = JSON.parse(req.query.variants);
      } catch (e) {
        console.error('Failed to parse variants:', e);
      }
    }
    if (!variantData.size && req.query.size) variantData.size = String(req.query.size).trim();
    if (!variantData.color && req.query.color) variantData.color = String(req.query.color).trim();
    variantData = normVariants(variantData);

    // Optional stock check
    if (typeof product.stock === 'number' && product.stock <= 0) {
      if (wantsJson(req)) return res.status(400).json({ success: false, message: 'Out of stock.' });
      if (typeof req.flash === 'function') req.flash('error', 'Out of stock.');
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    // Variant validation (clothes/shoes) — ✅ use category first (matches sales-products.ejs)
    const cat  = String(product.category || '').toLowerCase();
    const type = String(product.type || '').toLowerCase(); // fallback only

    const isClothes = (cat === 'clothes' || cat === 'second-hand-clothes' || type === 'clothes');
    const isShoes   = (cat === 'shoes' || type === 'shoes');

    const isVariantProduct = isClothes || isShoes;

    if (isVariantProduct) {
      if (product.sizes && product.sizes.length > 0) {
        if (!variantData.size) {
          if (wantsJson(req)) return res.status(400).json({ success: false, message: 'Please select a size' });
          if (typeof req.flash === 'function') req.flash('error', 'Please select a size');
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
        if (!product.sizes.includes(variantData.size)) {
          if (wantsJson(req))
            return res.status(400).json({ success: false, message: `Size "${variantData.size}" is not available for this product` });
          if (typeof req.flash === 'function') req.flash('error', 'Selected size is not available');
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
      }

      if (product.colors && product.colors.length > 0) {
        if (!variantData.color) {
          if (wantsJson(req)) return res.status(400).json({ success: false, message: 'Please select a color' });
          if (typeof req.flash === 'function') req.flash('error', 'Please select a color');
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
        if (!product.colors.includes(variantData.color)) {
          if (wantsJson(req))
            return res.status(400).json({ success: false, message: `Color "${variantData.color}" is not available for this product` });
          if (typeof req.flash === 'function') req.flash('error', 'Selected color is not available');
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
      }
    }

    const cart = ensureCart(req);

    // Safety cleanup: if cart already has a second-hand lock, remove conflicting business items
    enforceSecondhandLockOnCart(cart);

    // ✅ STRICT NO-MIXING enforcement (legacy carts could already be mixed)
    const hasSH = cartHasSecondhand(cart.items);
    const hasNSH = cartHasNonSecondhand(cart.items);
    if (hasSH && hasNSH) {
      if (wantsJson(req)) return res.status(409).json(mixingRejectPayload());
      if (typeof req.flash === 'function') req.flash('error', mixingRejectPayload().message);
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    const prodCat = String(product.category || '').trim().toLowerCase();
    const prodIsSH = isSecondhandCategory(prodCat);
    const prodBiz = businessKeyFromProduct(product);

    // If cart is second-hand mode → only allow second-hand + same business
    const lockBiz = getSecondhandLockBusiness(cart.items);

    if (lockBiz) {
      if (!prodIsSH) {
        if (wantsJson(req)) return res.status(409).json(nonSecondhandRejectPayloadWhenSecondhandLocked());
        if (typeof req.flash === 'function') req.flash('error', nonSecondhandRejectPayloadWhenSecondhandLocked().message);
        const back = req.query.back || req.get('referer') || '/sales';
        return res.redirect(back);
      }
      if (prodBiz && prodBiz !== lockBiz) {
        if (wantsJson(req)) return res.status(409).json(secondhandRejectPayload());
        if (typeof req.flash === 'function') req.flash('error', secondhandRejectPayload().message);
        const back = req.query.back || req.get('referer') || '/sales';
        return res.redirect(back);
      }
    }

    // If cart is normal mode (has items but no second-hand) → block adding second-hand
    if (!lockBiz && cart.items.length > 0 && prodIsSH) {
      if (wantsJson(req)) return res.status(409).json(secondhandRejectPayloadWhenNormalCartHasItems());
      if (typeof req.flash === 'function') req.flash('error', secondhandRejectPayloadWhenNormalCartHasItems().message);
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    // If product itself is second-hand → must have businessId
    if (prodIsSH && !prodBiz) {
      const msg =
        'Rejected: This second-hand product is missing its business/location reference. ' +
        'Please contact support or re-save the product with a business owner.';
      if (wantsJson(req)) return res.status(400).json({ success: false, message: msg });
      if (typeof req.flash === 'function') req.flash('error', msg);
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    const id = String(product._id);

    const idx = findIndexById(cart.items, id, variantData);

    if (idx >= 0) {
      cart.items[idx].quantity = Number(cart.items[idx].quantity || 1) + qty;
    } else {
      const cartItem = normalizeCartItem(product, qty, variantData, req);
      cart.items.push(cartItem);
    }

    req.session.cart = cart;

    if (wantsJson(req)) {
      return res.json({
        success: true,
        message: 'Added to cart.',
        cart: { items: cart.items },
        variants: variantData,
      });
    }

    if (typeof req.flash === 'function') req.flash('success', 'Added to cart.');
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/add error:', err);
    if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Failed to add to cart.' });
    if (typeof req.flash === 'function') req.flash('error', 'Failed to add to cart.');
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

// Decrease quantity by 1 (legacy)
router.get('/dec', async (req, res) => {
  try {
    const pid = String(req.query.pid || '').trim();
    const cart = ensureCart(req);

    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) idForCart = String(maybeProduct._id);

    // ✅ Optional variants support for legacy dec endpoint
    let variantData = {};
    if (req.query.variants) {
      try { variantData = JSON.parse(req.query.variants); } catch {
        // placeholding
      }
    }
    if (!variantData.size && req.query.size) variantData.size = String(req.query.size).trim();
    if (!variantData.color && req.query.color) variantData.color = String(req.query.color).trim();
    variantData = normVariants(variantData);

    const idx = findIndexById(cart.items, idForCart, variantData);

    if (idx >= 0) {
      const newQty = Number(cart.items[idx].quantity || 1) - 1;
      if (newQty <= 0) cart.items.splice(idx, 1);
      else cart.items[idx].quantity = newQty;
      req.session.cart = cart;
    }

    if (wantsJson(req)) return res.json({ success: true, cart: { items: cart.items } });
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/dec error:', err);
    if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Failed to decrease.' });
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

// Remove item entirely (legacy)
router.get('/remove', async (req, res) => {
  try {
    const pid = String(req.query.pid || '').trim();
    const cart = ensureCart(req);

    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) idForCart = String(maybeProduct._id);

    // ✅ Optional variants support for legacy remove endpoint
    let variantData = {};
    if (req.query.variants) {
      try { variantData = JSON.parse(req.query.variants); } catch {
        // placeholding
      }
    }
    if (!variantData.size && req.query.size) variantData.size = String(req.query.size).trim();
    if (!variantData.color && req.query.color) variantData.color = String(req.query.color).trim();
    variantData = normVariants(variantData);

    const hasVariantKeys = Object.keys(variantData).length > 0;

    if (hasVariantKeys) {
      cart.items = (cart.items || []).filter((i) => {
        if (String(i.productId) !== String(idForCart)) return true;
        return !variantsEqual(i.variants || {}, variantData); // remove only exact variant line
      });
    } else {
      // keep old behavior for non-variant items
      cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(idForCart));
    }
        
    req.session.cart = cart;

    if (wantsJson(req)) return res.json({ success: true, cart: { items: cart.items } });
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/remove error:', err);
    if (wantsJson(req)) return res.status(500).json({ success: false, message: 'Failed to remove.' });
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

/* ==================================================================
 * JSON CART API for Checkout (programmatic endpoints)
 * ================================================================== */

/* ------------------------------------------------------------------
 * POST /api/cart/increase  { pid, variants? }
 * -> increments quantity by 1 (adds if absent)
 * ------------------------------------------------------------------ */
router.post('/increase', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    let variants = req.body?.variants || {};
    variants = normVariants(variants);

    if (!pid) return res.status(400).json({ message: 'pid is required' });

    const product = await findProductByPid(pid);
    if (!product) return res.status(404).json({ message: 'Product not found.' });

    if (typeof product.stock === 'number' && product.stock <= 0) {
      return res.status(400).json({ message: 'Out of stock.' });
    }

    const cart = ensureCart(req);

    // Safety cleanup: if cart already has a second-hand lock, remove conflicting business items
    enforceSecondhandLockOnCart(cart);

    // ✅ STRICT NO-MIXING enforcement for legacy carts
    const hasSH = cartHasSecondhand(cart.items);
    const hasNSH = cartHasNonSecondhand(cart.items);
    if (hasSH && hasNSH) {
      return res.status(409).json({ ...mixingRejectPayload(), items: cart.items });
    }

    const prodCat = String(product.category || '').trim().toLowerCase();
    const prodIsSH = isSecondhandCategory(prodCat);
    const prodBiz = businessKeyFromProduct(product);

    const lockBiz = getSecondhandLockBusiness(cart.items);

    if (lockBiz) {
      if (!prodIsSH) return res.status(409).json({ ...nonSecondhandRejectPayloadWhenSecondhandLocked(), items: cart.items });
      if (prodBiz && prodBiz !== lockBiz) return res.status(409).json({ ...secondhandRejectPayload(), items: cart.items });
    }

    if (!lockBiz && cart.items.length > 0 && prodIsSH) {
      return res.status(409).json({ ...secondhandRejectPayloadWhenNormalCartHasItems(), items: cart.items });
    }

    if (prodIsSH && !prodBiz) {
      const msg =
        'Rejected: This second-hand product is missing its business/location reference. ' +
        'Please contact support or re-save the product with a business owner.';
      return res.status(400).json({ success: false, message: msg, items: cart.items });
    }

    const id = String(product._id);

    const idx = findIndexById(cart.items, id, variants);

    if (idx >= 0) {
      cart.items[idx].quantity = Number(cart.items[idx].quantity || 1) + 1;
    } else {
      // ✅ If caller forgot variants but cart already has multiple variants of same product,
      // do NOT create a duplicate ambiguous line.
      const sameProductCount = (cart.items || []).filter(
        (it) => String(it.productId) === id
      ).length;

      const noVariantsSent = Object.keys(normVariants(variants)).length === 0;

      if (noVariantsSent && sameProductCount > 0) {
        return res.status(409).json({
          message: 'This item has size/color variants. Please send the selected variant when changing quantity.',
          code: 'VARIANT_REQUIRED_FOR_QTY',
          items: cart.items,
        });
      }

      cart.items.push(normalizeCartItem(product, 1, variants, req));
    }

    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ POST /api/cart/increase error:', err);
    return res.status(500).json({ message: 'Failed to increase.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * POST /api/cart/decrease  { pid }
 * ------------------------------------------------------------------ */
router.post('/decrease', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    if (!pid) return res.status(400).json({ message: 'pid is required' });

    let variants = req.body?.variants || {};
    variants = normVariants(variants);

    const cart = ensureCart(req);
    let idForCart = pid;

    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) idForCart = String(maybeProduct._id);

    const idx = findIndexById(cart.items, idForCart, variants);
    if (idx >= 0) {
      const newQty = Number(cart.items[idx].quantity || 1) - 1;
      if (newQty <= 0) cart.items.splice(idx, 1);
      else cart.items[idx].quantity = newQty;
      req.session.cart = cart;
    }

    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ POST /api/cart/decrease error:', err);
    return res.status(500).json({ message: 'Failed to decrease.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * POST /api/cart/remove  { pid }
 * ------------------------------------------------------------------ */
router.post('/remove', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    if (!pid) return res.status(400).json({ message: 'pid is required' });

    let variants = req.body?.variants || {};
    variants = normVariants(variants);

    const cart = ensureCart(req);

    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) idForCart = String(maybeProduct._id);

    const hasVariantKeys = Object.keys(variants).length > 0;

    if (hasVariantKeys) {
      cart.items = (cart.items || []).filter((i) => {
        if (String(i.productId) !== String(idForCart)) return true;
        return !variantsEqual(i.variants || {}, variants); // remove exact variant only
      });
    } else {
      cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(idForCart));
    }

    req.session.cart = cart;
        return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ POST /api/cart/remove error:', err);
    return res.status(500).json({ message: 'Failed to remove item.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * PATCH /api/cart/item/:id   body: { quantity }
 * -> sets quantity (<=0 removes)
 * NOTE: If item doesn't exist, this can "seed" from DB (kept),
 *       BUT we must enforce the same second-hand rules.
 * ------------------------------------------------------------------ */
router.patch('/item/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    let { quantity } = req.body || {};
    quantity = Number(quantity);

    if (!Number.isFinite(quantity)) {
      return res.status(400).json({ message: 'Quantity must be a number.', items: ensureCart(req).items });
    }

    const cart = ensureCart(req);

    let variants = req.body?.variants || {
      // placeholding
    };
    variants = normVariants(variants);

    if (quantity <= 0) {
      const hasVariantKeys = Object.keys(variants).length > 0;

      if (hasVariantKeys) {
        cart.items = (cart.items || []).filter((i) => {
          if (String(i.productId) !== String(id)) return true;
          return !variantsEqual(i.variants || {}, variants); // remove exact variant only
        });
      } else {
        // keep old behavior if no variants were sent
        cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(id));
      }

      req.session.cart = cart;
      return res.json({ items: cart.items });
    }

    const idx = findIndexById(cart.items, id, variants);

    if (idx < 0) {
      // ✅ If same product exists in multiple variant lines and caller did not send variants,
      // reject instead of creating ambiguous/ghost behavior
      const sameProductCount = (cart.items || []).filter((it) => String(it.productId) === String(id)).length;
      const noVariantsSent = Object.keys(variants).length === 0;

      if (sameProductCount > 0 && noVariantsSent) {
        return res.status(409).json({
          message: 'This item has size/color variants. Please send the selected variant when changing quantity.',
          code: 'VARIANT_REQUIRED_FOR_QTY',
          items: cart.items,
        });
      }
      const product = await findProductByPid(id);
      if (!product) return res.status(404).json({ message: 'Item not found.', items: cart.items });

      // Safety cleanup (legacy)
      enforceSecondhandLockOnCart(cart);

      // Strict no-mixing
      const hasSH = cartHasSecondhand(cart.items);
      const hasNSH = cartHasNonSecondhand(cart.items);
      if (hasSH && hasNSH) return res.status(409).json({ ...mixingRejectPayload(), items: cart.items });

      const prodCat = String(product.category || '').trim().toLowerCase();
      const prodIsSH = isSecondhandCategory(prodCat);
      const prodBiz = businessKeyFromProduct(product);
      const lockBiz = getSecondhandLockBusiness(cart.items);

      if (lockBiz) {
        if (!prodIsSH) return res.status(409).json({ ...nonSecondhandRejectPayloadWhenSecondhandLocked(), items: cart.items });
        if (prodBiz && prodBiz !== lockBiz) return res.status(409).json({ ...secondhandRejectPayload(), items: cart.items });
      }

      if (!lockBiz && cart.items.length > 0 && prodIsSH) {
        return res.status(409).json({ ...secondhandRejectPayloadWhenNormalCartHasItems(), items: cart.items });
      }

      if (prodIsSH && !prodBiz) {
        const msg =
          'Rejected: This second-hand product is missing its business/location reference. ' +
          'Please contact support or re-save the product with a business owner.';
        return res.status(400).json({ success: false, message: msg, items: cart.items });
      }

      cart.items.push(normalizeCartItem(product, quantity, variants, req));
    } else {
      cart.items[idx].quantity = Math.max(1, Math.floor(quantity));
    }

    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ PATCH /api/cart/item/:id error:', err);
    return res.status(500).json({ message: 'Failed to update quantity.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * DELETE /api/cart/item/:id
 * ------------------------------------------------------------------ */
router.delete('/item/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    let variants = req.body?.variants || {};
    variants = normVariants(variants);

    const cart = ensureCart(req);
    const hasVariantKeys = Object.keys(variants).length > 0;

    if (hasVariantKeys) {
      cart.items = (cart.items || []).filter((i) => {
        if (String(i.productId) !== String(id)) return true;
        return !variantsEqual(i.variants || {}, variants); // remove exact variant only
      });
    } else {
      cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(id));
    }

    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ DELETE /api/cart/item/:id error:', err);
    return res.status(500).json({ message: 'Failed to remove item.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * POST /api/cart/clear
 * ------------------------------------------------------------------ */
router.post('/clear', (req, res) => {
  req.session.cart = { items: [], _vatUpgradedOnce: true };
  return res.json({ items: [] });
});

// ✅ GET alias
router.get('/clear', (req, res) => {
  req.session.cart = { items: [], _vatUpgradedOnce: true };
  return res.json({ items: [] });
});

module.exports = router;

