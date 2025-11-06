// routes/productRatings.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { Types, isValidObjectId } = mongoose;

const Product = require("../models/Product");
const Rating  = require("../models/Rating");
const currentActor = require("../middleware/currentActor");
const { clampStars, stripHtml } = require("../utils/sanitize");
const { recalcProductRating } = require("../utils/ratingUtils");

const router = express.Router();

/* ---------------------------------------------
 * Helpers
 * ------------------------------------------- */
function redirect303(res, url) {
  return res.redirect(303, url);
}
function backOr(req, fallback = "/") {
  return req.get("referer") || fallback;
}
async function getProductByCustomId(customId) {
  if (!customId) return null;
  return await Product.findOne({ customId: String(customId).trim() })
    .select("_id customId name avgRating ratingsCount")
    .lean();
}
async function productViewUrlByObjectId(productId) {
  if (!productId) return null;
  const p = await Product.findById(productId).select("customId").lean();
  return p?.customId ? `/products/view/${p.customId}` : null;
}

/* ---------------------------------------------
 * Rate limiter for writes
 * ------------------------------------------- */
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});

/* -----------------------------------------------------------
 * GET /api/products/:customId/ratings?page=&limit=&fresh=1
 * Public list (published only) + returns product avg/count
 * --------------------------------------------------------- */
router.get("/api/products/:customId/ratings", async (req, res) => {
  try {
    const product = await getProductByCustomId(req.params.customId);
    if (!product) return res.status(404).json({ ok: false, error: "Product not found" });

    const page  = Math.max(1, parseInt(req.query.page || "1", 10));
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit || "10", 10)));

    const q = { productId: product._id, status: "published" };
    const [items, total] = await Promise.all([
      Rating.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Rating.countDocuments(q)
    ]);

    // Optional live aggregate if client asks for ?fresh=1
    let avgRating = product.avgRating || 0;
    let ratingsCount = product.ratingsCount || 0;
    if (String(req.query.fresh) === "1") {
      const [agg] = await Rating.aggregate([
        { $match: { productId: product._id, status: "published" } },
        { $group: { _id: "$productId", avg: { $avg: "$stars" }, cnt: { $sum: 1 } } }
      ]);
      avgRating = agg ? Number(agg.avg.toFixed(2)) : 0;
      ratingsCount = agg ? agg.cnt : 0;
    }

    res.json({
      ok: true,
      product: { id: product.customId, avgRating, ratingsCount },
      page, limit, total,
      items
    });
  } catch (err) {
    console.error("ratings list error", err);
    res.status(400).json({ ok: false, error: "Invalid request" });
  }
});

/* -----------------------------------------------------------
 * POST /products/view/:customId/ratings
 * Create/Update my rating (1 per actor per product)
 * --------------------------------------------------------- */
router.post("/products/view/:customId/ratings", writeLimiter, currentActor(true), async (req, res) => {
  try {
    const product = await getProductByCustomId(req.params.customId);
    if (!product) {
      req.flash("error", "Product not found.");
      return redirect303(res, "/products/sales");
    }

    const fallbackUrl = String(req.body.redirect || `/products/view/${product.customId}`);

    const stars = clampStars(req.body.stars);
    if (!stars) {
      req.flash("error", "Please choose a rating between 1 and 5 stars.");
      return redirect303(res, fallbackUrl);
    }

    const payload = {
      productId: product._id,
      raterType: req.actor.type,
      raterUser:     req.actor.type === "user"     ? req.actor.id : null,
      raterBusiness: req.actor.type === "business" ? req.actor.id : null,
      stars,
      title: stripHtml(req.body.title || "").slice(0, 120),
      body:  stripHtml(req.body.body  || "").slice(0, 2000),
      status: "published"
    };

    const query = {
      productId: product._id,
      raterType: req.actor.type,
      ...(req.actor.type === "user"
        ? { raterUser: req.actor.id }
        : { raterBusiness: req.actor.id })
    };

    await Rating.updateOne(query, { $set: payload }, { upsert: true });
    await recalcProductRating(product._id);

    req.flash("success", "Thanks! Your rating has been saved.");
    return redirect303(res, fallbackUrl);
  } catch (err) {
    console.error("rating upsert error", err);
    const safeUrl = `/products/view/${encodeURIComponent(req.params.customId)}`;
    req.flash("error", "Could not save your rating. Please try again.");
    return redirect303(res, safeUrl);
  }
});

/* -----------------------------------------------------------
 * POST /ratings/:ratingId/flag  (any logged-in actor)
 * - Validates ObjectId
 * - Redirects safely to product page when possible
 * --------------------------------------------------------- */
router.post("/ratings/:ratingId/flag", writeLimiter, currentActor(true), async (req, res) => {
  try {
    const id = req.params.ratingId;
    if (!isValidObjectId(id)) {
      req.flash("error", "Invalid rating id.");
      return redirect303(res, backOr(req, "/products/sales"));
    }

    const rating = await Rating.findById(id).select("productId");
    if (!rating) {
      req.flash("error", "Rating not found.");
      return redirect303(res, backOr(req, "/products/sales"));
    }

    await Rating.updateOne({ _id: rating._id }, { $set: { status: "flagged" } });

    const productUrl = await productViewUrlByObjectId(rating.productId);
    req.flash("success", "Thanks for reporting. We’ll review this rating.");
    return redirect303(res, backOr(req, productUrl || "/products/sales"));
  } catch (err) {
    console.error("flag rating error", err);
    req.flash("error", "Could not flag rating.");
    return redirect303(res, backOr(req, "/products/sales"));
  }
});

/* -----------------------------------------------------------
 * POST /ratings/:ratingId/delete (owner only)
 * - Validates ObjectId
 * - Redirects safely to product page when possible
 * --------------------------------------------------------- */
router.post("/ratings/:ratingId/delete", writeLimiter, currentActor(true), async (req, res) => {
  try {
    const id = req.params.ratingId;
    if (!isValidObjectId(id)) {
      req.flash("error", "Invalid rating id.");
      return redirect303(res, backOr(req, "/products/sales"));
    }

    const rating = await Rating.findById(id);
    if (!rating) {
      req.flash("error", "Rating not found.");
      return redirect303(res, backOr(req, "/products/sales"));
    }

    const isOwner =
      (req.actor.type === "user"     && String(rating.raterUser)     === String(req.actor.id)) ||
      (req.actor.type === "business" && String(rating.raterBusiness) === String(req.actor.id));

    if (!isOwner) {
      req.flash("error", "You can only delete your own rating.");
      return redirect303(res, backOr(req, await productViewUrlByObjectId(rating.productId) || "/products/sales"));
    }

    const productId = rating.productId;
    await rating.deleteOne();
    await recalcProductRating(productId);

    const productUrl = await productViewUrlByObjectId(productId);
    req.flash("success", "Your rating was deleted.");
    return redirect303(res, backOr(req, productUrl || "/products/sales"));
  } catch (err) {
    console.error("delete rating error", err);
    req.flash("error", "Could not delete the rating.");
    return redirect303(res, backOr(req, "/products/sales"));
  }
});

module.exports = router;
