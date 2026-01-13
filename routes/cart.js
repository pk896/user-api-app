// routes/cart.js
const express = require('express');
const Product = require('../models/Product');

const router = express.Router();

/* ------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------ */
function ensureCart(req) {
  if (!req.session.cart) {req.session.cart = { items: [] };}
  if (!Array.isArray(req.session.cart.items)) {req.session.cart.items = [];}

  // ✅ Upgrade old cart items (stored as NET before) → convert to GROSS once
  const r = vatRate(req);
  req.session.cart.items = (req.session.cart.items || []).map((it) => {
    if (!it) return it;

    // If already upgraded, keep as-is
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

  return req.session.cart;
}

async function findProductByPid(pid) {
  if (!pid) {return null;}
  // Try customId first (many product links use it)
  let p = await Product.findOne({ customId: pid }).lean();
  if (p) {return p;}
  // Fallback: treat pid as Mongo _id
  try {
    p = await Product.findById(pid).lean();
  } catch {
    // ignore invalid ObjectId
  }
  return p || null;
}

function productUnitPriceNumber(p) {
  // Prefer cents if your model stores priceCents; else use price (float)
  if (typeof p.priceCents === 'number') {return Number((p.priceCents || 0) / 100);}
  return Number(p.price || 0);
}

function normalizeCartItem(p, qty, variants = {}, req) {
  const { net, gross, vatIncluded, vatRate: r } = priceGrossFromProduct(p, req);

  return {
    productId: String(p._id),
    customId: p.customId,
    name: p.name,

    // ✅ Cart stores VAT-inclusive price (gross)
    price: gross,

    // Optional but useful for invoices/admin breakdowns later
    priceExVat: net,
    vatRate: r,
    vatIncluded,

    imageUrl: p.imageUrl || p.image || '',
    quantity: Math.max(1, Math.floor(Number(qty || 1))),
    variants: variants,
  };
}

function findIndexById(items, id, variants = {}) {
  if (Object.keys(variants).length === 0) {
    // If no variants, just match by productId
    return (items || []).findIndex((it) => String(it.productId) === String(id));
  } else {
    // Match by productId AND variants
    return (items || []).findIndex((it) => 
      String(it.productId) === String(id) &&
      JSON.stringify(it.variants || {}) === JSON.stringify(variants)
    );
  }
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
function vatRate(req) {
  // Priority: env → default 15%
  const r = Number(process.env.VAT_RATE || 0.15);
  return Number.isFinite(r) ? r : 0.15;
}

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function priceGrossFromProduct(p, req) {
  const net = productUnitPriceNumber(p); // ✅ product price in DB (excluding VAT)
  const r = vatRate(req);
  const gross = round2(net * (1 + r));
  return { net, gross, vatIncluded: true, vatRate: r };
}

/* ------------------------------------------------------------------
 * GET /api/cart
 * -> { items: [ { productId, name, price, imageUrl, quantity } ] }
 * ------------------------------------------------------------------ */
router.get('/', (req, res) => {
  const cart = ensureCart(req);
  return res.json({ items: cart.items || [] });
});

/* ------------------------------------------------------------------
 * GET /api/cart/items (legacy)
 * -> [ { productId, name, price, imageUrl, quantity } ]
 * ------------------------------------------------------------------ */
router.get('/items', (req, res) => {
  const cart = ensureCart(req);
  return res.json(cart.items || []);
});

/* ------------------------------------------------------------------
 * GET /api/cart/count
 * -> { count: number }
 * ------------------------------------------------------------------ */
router.get('/count', (req, res) => {
  const cart = ensureCart(req);
  return res.json({ count: cartCount(cart.items) });
});

/* ------------------------------------------------------------------
 * LEGACY LINK ENDPOINTS (kept for compatibility with existing views)
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
      if (wantsJson(req))
        {return res.status(404).json({ success: false, message: 'Product not found.' });}
      if (typeof req.flash === 'function') {req.flash('error', 'Product not found.');}
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
        // Don't fail, we’ll still look at ?size & ?color below
      }
    }

    // Fallback: support simple ?size=&color= from the frontend
    if (!variantData.size && req.query.size) {
      variantData.size = String(req.query.size).trim();
    }
    if (!variantData.color && req.query.color) {
      variantData.color = String(req.query.color).trim();
    }

    // Optional stock check (only if your Product has stock)
    if (typeof product.stock === 'number' && product.stock <= 0) {
      if (wantsJson(req)) {return res.status(400).json({ success: false, message: 'Out of stock.' });}
      if (typeof req.flash === 'function') {req.flash('error', 'Out of stock.');}
      const back = req.query.back || req.get('referer') || '/sales';
      return res.redirect(back);
    }

    // For clothing products, validate size/color selections
    if (product.role === 'clothes') {
      // Validate size if product has size options
      if (product.sizes && product.sizes.length > 0) {
        if (!variantData.size) {
          if (wantsJson(req)) {
            return res.status(400).json({ 
              success: false, 
              message: 'Please select a size' 
            });
          }
          if (typeof req.flash === 'function') {req.flash('error', 'Please select a size');}
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
        
        // Check if selected size is available
        if (!product.sizes.includes(variantData.size)) {
          if (wantsJson(req)) {
            return res.status(400).json({ 
              success: false, 
              message: `Size "${variantData.size}" is not available for this product` 
            });
          }
          if (typeof req.flash === 'function') {req.flash('error', 'Selected size is not available');}
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
      }

      // Validate color if product has color options
      if (product.colors && product.colors.length > 0) {
        if (!variantData.color) {
          if (wantsJson(req)) {
            return res.status(400).json({ 
              success: false, 
              message: 'Please select a color' 
            });
          }
          if (typeof req.flash === 'function') {req.flash('error', 'Please select a color');}
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
        
        // Check if selected color is available
        if (!product.colors.includes(variantData.color)) {
          if (wantsJson(req)) {
            return res.status(400).json({ 
              success: false, 
              message: `Color "${variantData.color}" is not available for this product` 
            });
          }
          if (typeof req.flash === 'function') {req.flash('error', 'Selected color is not available');}
          const back = req.query.back || req.get('referer') || '/sales';
          return res.redirect(back);
        }
      }
    }

    const cart = ensureCart(req);
    const id = String(product._id);
    
    // Find item with same product AND same variants
    const idx = cart.items.findIndex((it) => 
      String(it.productId) === id &&
      JSON.stringify(it.variants || {}) === JSON.stringify(variantData)
    );

    if (idx >= 0) {
      cart.items[idx].quantity = Number(cart.items[idx].quantity || 1) + qty;
    } else {
      // Create cart item with variants
      const cartItem = normalizeCartItem (product, qty, variantData, req);
      cartItem.variants = variantData; // Add variants to cart item
      cart.items.push(cartItem);
    }
    
    req.session.cart = cart;

    if (wantsJson(req))
      {return res.json({ 
        success: true, 
        message: 'Added to cart.', 
        cart: { items: cart.items },
        variants: variantData // Optional: return selected variants in response
      });}
    if (typeof req.flash === 'function') {req.flash('success', 'Added to cart.');}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/add error:', err);
    if (wantsJson(req))
      {return res.status(500).json({ success: false, message: 'Failed to add to cart.' });}
    if (typeof req.flash === 'function') {req.flash('error', 'Failed to add to cart.');}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

// Decrease quantity by 1 (legacy)
router.get('/dec', async (req, res) => {
  try {
    const pid = String(req.query.pid || '').trim();
    const cart = ensureCart(req);

    // pid may be customId or productId; resolve to productId if needed
    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) {idForCart = String(maybeProduct._id);}

    const idx = findIndexById(cart.items, idForCart);
    if (idx >= 0) {
      const newQty = Number(cart.items[idx].quantity || 1) - 1;
      if (newQty <= 0) {cart.items.splice(idx, 1);}
      else {cart.items[idx].quantity = newQty;}
      req.session.cart = cart;
    }

    if (wantsJson(req)) {return res.json({ success: true, cart: { items: cart.items } });}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/dec error:', err);
    if (wantsJson(req))
      {return res.status(500).json({ success: false, message: 'Failed to decrease.' });}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

// Remove item entirely (legacy)
router.get('/remove', async (req, res) => {
  try {
    const pid = String(req.query.pid || '').trim();
    const cart = ensureCart(req);

    // Resolve pid to productId if a customId was passed
    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) {idForCart = String(maybeProduct._id);}

    cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(idForCart));
    req.session.cart = cart;

    if (wantsJson(req)) {return res.json({ success: true, cart: { items: cart.items } });}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  } catch (err) {
    console.error('❌ /api/cart/remove error:', err);
    if (wantsJson(req))
      {return res.status(500).json({ success: false, message: 'Failed to remove.' });}
    const back = req.query.back || req.get('referer') || '/sales';
    return res.redirect(back);
  }
});

/* ==================================================================
 * JSON CART API for Checkout (clean programmatic endpoints)
 * ================================================================== */

/* ------------------------------------------------------------------
 * POST /api/cart/increase  { pid }
 * -> increments quantity by 1 (adds if absent)
 * ------------------------------------------------------------------ */
router.post('/increase', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    const variants = req.body?.variants || {};
    
    if (!pid) {return res.status(400).json({ message: 'pid is required' });}

    const product = await findProductByPid(pid);
    if (!product) {return res.status(404).json({ message: 'Product not found.' });}

    // Optional stock check
    if (typeof product.stock === 'number' && product.stock <= 0) {
      return res.status(400).json({ message: 'Out of stock.' });
    }

    const cart = ensureCart(req);
    const id = String(product._id);
    
    // Find item with same product AND same variants
    const idx = cart.items.findIndex((it) => 
      String(it.productId) === id &&
      JSON.stringify(it.variants || {}) === JSON.stringify(variants)
    );

    if (idx >= 0) {
      cart.items[idx].quantity = Number(cart.items[idx].quantity || 1) + 1;
    } else {
      const cartItem = normalizeCartItem(product, 1, variants, req);
      cartItem.variants = variants;
      cart.items.push(cartItem);
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
 * -> decrements quantity by 1 (removes if becomes 0)
 * ------------------------------------------------------------------ */
router.post('/decrease', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    if (!pid) {return res.status(400).json({ message: 'pid is required' });}

    // pid can be productId or customId
    const cart = ensureCart(req);
    let idForCart = pid;

    // If pid is customId, resolve to productId
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) {idForCart = String(maybeProduct._id);}

    const idx = findIndexById(cart.items, idForCart);
    if (idx >= 0) {
      const newQty = Number(cart.items[idx].quantity || 1) - 1;
      if (newQty <= 0) {cart.items.splice(idx, 1);}
      else {cart.items[idx].quantity = newQty;}
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
 * -> removes the item completely
 * ------------------------------------------------------------------ */
router.post('/remove', express.json(), async (req, res) => {
  try {
    const pid = String(req.body?.pid || '').trim();
    if (!pid) {return res.status(400).json({ message: 'pid is required' });}

    const cart = ensureCart(req);

    // Resolve pid to productId if a customId was passed
    let idForCart = pid;
    const maybeProduct = await findProductByPid(pid);
    if (maybeProduct) {idForCart = String(maybeProduct._id);}

    cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(idForCart));
    req.session.cart = cart;

    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ POST /api/cart/remove error:', err);
    return res
      .status(500)
      .json({ message: 'Failed to remove item.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * PATCH /api/cart/item/:id   body: { quantity }
 * -> sets quantity (<=0 removes)
 * ------------------------------------------------------------------ */
router.patch('/item/:id', express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    let { quantity } = req.body || {};
    quantity = Number(quantity);

    if (!Number.isFinite(quantity)) {
      return res
        .status(400)
        .json({ message: 'Quantity must be a number.', items: ensureCart(req).items });
    }

    const cart = ensureCart(req);

    if (quantity <= 0) {
      cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(id));
      req.session.cart = cart;
      return res.json({ items: cart.items });
    }

    const idx = findIndexById(cart.items, id);
    if (idx < 0) {
      // Seed from DB if not present (nice UX)
      const product = await findProductByPid(id);
      if (!product) {return res.status(404).json({ message: 'Item not found.', items: cart.items });}
      cart.items.push(normalizeCartItem(product, quantity, {}, req)); 
    } else {
      cart.items[idx].quantity = Math.max(1, Math.floor(quantity));
    }

    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ PATCH /api/cart/item/:id error:', err);
    return res
      .status(500)
      .json({ message: 'Failed to update quantity.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * DELETE /api/cart/item/:id
 * -> removes item
 * ------------------------------------------------------------------ */
router.delete('/item/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cart = ensureCart(req);
    cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(id));
    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error('❌ DELETE /api/cart/item/:id error:', err);
    return res
      .status(500)
      .json({ message: 'Failed to remove item.', items: ensureCart(req).items });
  }
});

/* ------------------------------------------------------------------
 * POST /api/cart/clear
 * -> clears the cart
 * ------------------------------------------------------------------ */
router.post('/clear', (req, res) => {
  req.session.cart = { items: [] };
  return res.json({ items: [] });
});

module.exports = router;
