// routes/wishlist.js
'use strict';

const express = require('express');
const { isValidObjectId, Types } = require('mongoose');

const router = express.Router();

const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');

/* -----------------------------
 * Helpers
 * --------------------------- */
function themeCssFrom(req) {
  return req.session?.theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}
function nonceFrom(res) {
  return res?.locals?.nonce || '';
}

// Accept either req.session.user or req.session.business
function getPrincipal(req) {
  if (req.session?.user?._id) return { type: 'user', id: req.session.user._id };
  if (req.session?.business?._id) return { type: 'business', id: req.session.business._id };
  return null;
}

// Page gate: redirects (good for normal pages)
function requireAnyAccountPage(req, res, next) {
  const p = getPrincipal(req);
  if (!p) {
    req.flash?.('error', 'Please sign in to use your wishlist.');
    return res.redirect('/users/login');
  }
  req.principal = p;
  next();
}

// API gate: JSON 401 (good for fetch)
function requireAnyAccountApi(req, res, next) {
  const p = getPrincipal(req);
  if (!p) return res.status(401).json({ ok: false, message: 'Not signed in' });
  req.principal = p;
  next();
}

// Resolve either ObjectId string OR customId -> ObjectId string
async function resolveProductObjectId(productIdOrCustomId) {
  const raw = String(productIdOrCustomId || '').trim();
  if (!raw) return null;

  if (isValidObjectId(raw)) return String(raw);

  // fallback: treat as customId
  const p = await Product.findOne({ customId: raw }).select('_id customId').lean();
  return p ? String(p._id) : null;
}

// Fetch wishlist items + attach product (supports old entries where productId was string)
async function fetchWishlistWithProducts(owner) {
  const rows = await Wishlist.find({ ownerType: owner.type, ownerId: owner.id }).lean();

  const objIds = [];
  const customIds = [];

  for (const r of rows) {
    const pid = r.productId;
    const s = pid == null ? '' : String(pid);
    if (isValidObjectId(s)) objIds.push(new Types.ObjectId(s));
    else if (s) customIds.push(s); // legacy string entry support
  }

  const productsA =
    objIds.length > 0 ? await Product.find({ _id: { $in: objIds } }).lean() : [];
  const productsB =
    customIds.length > 0 ? await Product.find({ customId: { $in: customIds } }).lean() : [];

  // map by both _id and customId
  const pMap = new Map();
  for (const p of [...productsA, ...productsB]) {
    pMap.set(String(p._id), p);
    if (p.customId) pMap.set(String(p.customId), p);
  }

  return rows.map((r) => {
    const key = r.productId == null ? '' : String(r.productId);
    return {
      _id: r._id,
      productId: r.productId,
      addedAt: r.createdAt,
      product: pMap.get(key) || null,
    };
  });
}

/* -----------------------------
 * Page: GET /users/wishlist
 * --------------------------- */
router.get('/wishlist', requireAnyAccountPage, async (req, res) => {
  try {
    const items = await fetchWishlistWithProducts(req.principal);

    return res.render('users-wishlist', {
      title: 'My Wishlist',
      themeCss: themeCssFrom(req),
      nonce: nonceFrom(res),
      items,
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  } catch (err) {
    console.error('wishlist page error:', err);
    req.flash?.('error', 'Could not load wishlist.');
    return res.redirect('/sales');
  }
});

/* -----------------------------
 * API: list GET /users/wishlist/api
 * --------------------------- */
router.get('/wishlist/api', requireAnyAccountApi, async (req, res) => {
  try {
    const items = await fetchWishlistWithProducts(req.principal);
    res.json({ ok: true, items });
  } catch (err) {
    console.error('wishlist api error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* -----------------------------
 * API: count GET /users/wishlist/api/count
 * --------------------------- */
router.get('/wishlist/api/count', requireAnyAccountApi, async (req, res) => {
  try {
    const count = await Wishlist.countDocuments({
      ownerType: req.principal.type,
      ownerId: req.principal.id,
    });
    res.json({ ok: true, count });
  } catch (err) {
    console.error('wishlist count error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* -----------------------------
 * Add (idempotent): POST /users/wishlist/add/:productIdOrCustomId
 * --------------------------- */
router.post('/wishlist/add/:productId', requireAnyAccountPage, async (req, res) => {
  try {
    const productId = await resolveProductObjectId(req.params.productId);
    if (!productId) {
      req.flash?.('error', 'Product not found.');
      return res.redirect('/users/wishlist');
    }

    await Wishlist.updateOne(
      { ownerType: req.principal.type, ownerId: req.principal.id, productId },
      { $setOnInsert: { ownerType: req.principal.type, ownerId: req.principal.id, productId } },
      { upsert: true },
    );

    req.flash?.('success', 'Added to wishlist.');
    return res.redirect('/users/wishlist');
  } catch (err) {
    console.error('wishlist add error:', err);
    req.flash?.('error', 'Could not add to wishlist.');
    return res.redirect('/users/wishlist');
  }
});

/* -----------------------------
 * Remove: POST /users/wishlist/remove/:productIdOrCustomId
 * --------------------------- */
router.post('/wishlist/remove/:productId', requireAnyAccountPage, async (req, res) => {
  try {
    const raw = String(req.params.productId || '').trim();
    if (!raw) {
      req.flash?.('error', 'Missing product id.');
      return res.redirect('/users/wishlist');
    }

    // Try resolve normal (ObjectId or customId -> ObjectId)
    const resolved = await resolveProductObjectId(raw);

    if (resolved) {
      await Wishlist.deleteOne({
        ownerType: req.principal.type,
        ownerId: req.principal.id,
        productId: resolved,
      });
    }

    // Also try deleting legacy string productId entries (no casting)
    await Wishlist.collection.deleteOne({
      ownerType: req.principal.type,
      ownerId: new Types.ObjectId(String(req.principal.id)),
      productId: raw,
    });

    req.flash?.('success', 'Removed from wishlist.');
    return res.redirect('/users/wishlist');
  } catch (err) {
    console.error('wishlist remove error:', err);
    req.flash?.('error', 'Could not remove from wishlist.');
    return res.redirect('/users/wishlist');
  }
});

/* -----------------------------
 * API: toggle POST /users/wishlist/api/toggle
 * Body: { productId: "<_id OR customId>" }
 * --------------------------- */
router.post('/wishlist/api/toggle', express.json(), requireAnyAccountApi, async (req, res) => {
  try {
    const resolvedId = await resolveProductObjectId(req.body?.productId);
    if (!resolvedId) return res.status(400).json({ ok: false, message: 'Invalid productId' });

    const query = {
      ownerType: req.principal.type,
      ownerId: req.principal.id,
      productId: resolvedId,
    };

    const found = await Wishlist.findOne(query).lean();

    let wished;
    if (found) {
      await Wishlist.deleteOne(query);
      wished = false;
    } else {
      await Wishlist.create(query);
      wished = true;
    }

    const count = await Wishlist.countDocuments({
      ownerType: req.principal.type,
      ownerId: req.principal.id,
    });

    res.json({ ok: true, wished, count, productId: resolvedId });
  } catch (err) {
    console.error('wishlist toggle error:', err);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

module.exports = router;
