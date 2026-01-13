// routes/productRatings.js
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { isValidObjectId } = require('mongoose');

const Product = require('../models/Product');
const Rating = require('../models/Rating');

const currentActor = require('../middleware/currentActor');
const { clampStars, stripHtml } = require('../utils/sanitize');
const { recalcProductRating } = require('../utils/ratingUtils');

const router = express.Router();

// console.log('✅ LOADED productRatings.js from:', __filename);

router.use((req, _res, next) => {
  console.log(
    '➡️ productRatings router saw:',
    req.method,
    req.originalUrl,
    'baseUrl=',
    req.baseUrl,
  );
  next();
});

/* ---------------------------------------------
 * Helpers
 * ------------------------------------------- */
function redirect303(res, url) {
  return res.redirect(303, url);
}
function backOr(req, fallback = '/') {
  return req.get('referer') || fallback;
}
async function getProductByCustomId(customId) {
  if (!customId) return null;
  return await Product.findOne({ customId: String(customId).trim() })
    .select('_id customId name avgRating ratingsCount')
    .lean();
}
async function productViewUrlByObjectId(productId) {
  if (!productId) return null;
  const p = await Product.findById(productId).select('customId').lean();
  return p?.customId ? `/products/view/${p.customId}` : null;
}

// Guest identity (cookie-based)
function getOrSetGuestKey(req, res) {
  try {
    const fromCookies = req.cookies && req.cookies.guestKey ? String(req.cookies.guestKey) : null;

    const rawCookie = req.headers.cookie || '';
    const match = rawCookie.match(/(?:^|;\s*)guestKey=([^;]+)/);
    const fromHeader = match ? decodeURIComponent(match[1]) : null;

    const existing = fromCookies || fromHeader;
    if (existing && existing.length >= 16) return existing;

    const newKey = crypto.randomBytes(16).toString('hex');

    // Set cookie without needing cookie-parser
    const parts = [
      `guestKey=${encodeURIComponent(newKey)}`,
      'Path=/',
      'Max-Age=31536000', // 1 year
      'SameSite=Lax',
      'HttpOnly',
    ];
    if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
      parts.push('Secure');
    }
    res.setHeader('Set-Cookie', parts.join('; '));
    return newKey;
  } catch {
    return null;
  }
}

/* ---------------------------------------------
 * Rate limiter for writes
 * ------------------------------------------- */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// ======================================================
// ✅ TEST ROUTES (remove after debugging)
// ======================================================

/* -----------------------------------------------------------
 * GET /api/products/:customId/ratings?page=&limit=&fresh=1
 * Public list (published only) + returns product avg/count
 * --------------------------------------------------------- */
router.get('/api/products/:customId/ratings', async (req, res) => {
  try {
    const product = await getProductByCustomId(req.params.customId);
    if (!product) return res.status(404).json({ ok: false, error: 'Product not found' });

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || '10', 10)));

    const q = { productId: product._id, status: 'published' };
    const [items, total] = await Promise.all([
      Rating.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Rating.countDocuments(q),
    ]);

    // Optional live aggregate if client asks for ?fresh=1
    let avgRating = product.avgRating || 0;
    let ratingsCount = product.ratingsCount || 0;

    if (String(req.query.fresh) === '1') {
      const [agg] = await Rating.aggregate([
        { $match: { productId: product._id, status: 'published' } },
        { $group: { _id: '$productId', avg: { $avg: '$stars' }, cnt: { $sum: 1 } } },
      ]);
      avgRating = agg ? Number(Number(agg.avg || 0).toFixed(2)) : 0;
      ratingsCount = agg ? Number(agg.cnt || 0) : 0;
    }

    return res.json({
      ok: true,
      product: { id: product.customId, avgRating, ratingsCount },
      page,
      limit,
      total,
      items,
    });
  } catch (err) {
    console.error('ratings list error', err);
    return res.status(400).json({ ok: false, error: 'Invalid request' });
  }
});

/* -----------------------------------------------------------
 * POST /ratings/submit/:customId
 * Create/Update rating (1 per actor per product)
 * - user/business -> currentActor
 * - guest -> cookie guestKey (MUST be present)
 * --------------------------------------------------------- */
router.post('/ratings/submit/:customId', writeLimiter, currentActor(false), async (req, res) => {
  try {
    const product = await getProductByCustomId(req.params.customId);
    if (!product) {
      req.flash('error', 'Product not found.');
      return redirect303(res, '/products/sales');
    }

    const fallbackUrl = String(req.body.redirect || `/products/view/${product.customId}`);

    const stars = clampStars(req.body.stars);
    if (!stars) {
      req.flash('error', 'Please choose a rating between 1 and 5 stars.');
      return redirect303(res, fallbackUrl);
    }

    // Decide actor type
    const isAuthedActor = !!(req.actor && req.actor.type && req.actor.id);
    const raterType = isAuthedActor ? req.actor.type : 'guest';

    // ✅ Ensure guestKey is ALWAYS valid (prevents overwriting "one" doc forever)
    let guestKey = null;
    if (!isAuthedActor) {
      guestKey = getOrSetGuestKey(req, res);
      if (!guestKey || String(guestKey).length < 16) {
        req.flash(
          'error',
          'Your browser did not accept the review cookie. Please enable cookies and try again.',
        );
        return redirect303(res, fallbackUrl);
      }
    }

    // ✅ Strict identity query (never allow undefined keys)
    const query =
      raterType === 'user'
        ? { productId: product._id, raterType, raterUser: req.actor.id }
        : raterType === 'business'
          ? { productId: product._id, raterType, raterBusiness: req.actor.id }
          : { productId: product._id, raterType, guestKey };

    const payload = {
      productId: product._id,
      raterType,
      raterUser: raterType === 'user' ? req.actor.id : null,
      raterBusiness: raterType === 'business' ? req.actor.id : null,
      guestKey: raterType === 'guest' ? guestKey : null,
      stars,
      title: stripHtml(req.body.title || '').slice(0, 120),
      body: stripHtml(req.body.body || '').slice(0, 2000),
      status: 'published',
    };

    await Rating.updateOne(query, { $set: payload }, { upsert: true });
    await recalcProductRating(product._id);

    req.flash('success', 'Thanks! Your rating has been saved.');
    return redirect303(res, fallbackUrl);
  } catch (err) {
    console.error('rating upsert error', err);
    const safeUrl = `/products/view/${encodeURIComponent(req.params.customId)}`;
    req.flash('error', 'Could not save your rating. Please try again.');
    return redirect303(res, safeUrl);
  }
});

/* -----------------------------------------------------------
 * POST /ratings/:ratingId/flag  (any logged-in actor)
 * --------------------------------------------------------- */
router.post('/ratings/:ratingId/flag', writeLimiter, currentActor(true), async (req, res) => {
  try {
    const id = req.params.ratingId;
    if (!isValidObjectId(id)) {
      req.flash('error', 'Invalid rating id.');
      return redirect303(res, backOr(req, '/products/sales'));
    }

    const rating = await Rating.findById(id).select('productId');
    if (!rating) {
      req.flash('error', 'Rating not found.');
      return redirect303(res, backOr(req, '/products/sales'));
    }

    await Rating.updateOne({ _id: rating._id }, { $set: { status: 'flagged' } });

    const productUrl = await productViewUrlByObjectId(rating.productId);
    req.flash('success', 'Thanks for reporting. We’ll review this rating.');
    return redirect303(res, backOr(req, productUrl || '/products/sales'));
  } catch (err) {
    console.error('flag rating error', err);
    req.flash('error', 'Could not flag rating.');
    return redirect303(res, backOr(req, '/products/sales'));
  }
});

/* -----------------------------------------------------------
 * POST /ratings/:ratingId/delete (owner only)
 * --------------------------------------------------------- */
router.post('/ratings/:ratingId/delete', writeLimiter, currentActor(true), async (req, res) => {
  try {
    const id = req.params.ratingId;
    if (!isValidObjectId(id)) {
      req.flash('error', 'Invalid rating id.');
      return redirect303(res, backOr(req, '/products/sales'));
    }

    const rating = await Rating.findById(id);
    if (!rating) {
      req.flash('error', 'Rating not found.');
      return redirect303(res, backOr(req, '/products/sales'));
    }

    const isOwner =
      (req.actor.type === 'user' && String(rating.raterUser) === String(req.actor.id)) ||
      (req.actor.type === 'business' && String(rating.raterBusiness) === String(req.actor.id));

    if (!isOwner) {
      req.flash('error', 'You can only delete your own rating.');
      return redirect303(
        res,
        backOr(req, (await productViewUrlByObjectId(rating.productId)) || '/products/sales'),
      );
    }

    const productId = rating.productId;
    await rating.deleteOne();
    await recalcProductRating(productId);

    const productUrl = await productViewUrlByObjectId(productId);
    req.flash('success', 'Your rating was deleted.');
    return redirect303(res, backOr(req, productUrl || '/products/sales'));
  } catch (err) {
    console.error('delete rating error', err);
    req.flash('error', 'Could not delete the rating.');
    return redirect303(res, backOr(req, '/products/sales'));
  }
});

// ======================================================
// ✅ TEST ROUTES (safe to remove later)
// ======================================================

// GET /productRatings/_ping  -> confirms router is mounted + reachable
router.get('/_ping', (req, res) => {
  return res.status(200).json({
    ok: true,
    hit: 'productRatings router',
    method: req.method,
    baseUrl: req.baseUrl,
    path: req.originalUrl,
    time: new Date().toISOString(),
  });
});

// POST /productRatings/_echo -> confirms POST hits + body is parsed
router.post('/_echo', (req, res) => {
  return res.status(200).json({
    ok: true,
    hit: 'productRatings router',
    method: req.method,
    baseUrl: req.baseUrl,
    path: req.originalUrl,
    body: req.body,
    headers: {
      'content-type': req.headers['content-type'],
      referer: req.headers.referer,
    },
  });
});

module.exports = router;
