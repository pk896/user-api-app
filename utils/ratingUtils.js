'use strict';

const mongoose = require('mongoose');
const { isValidObjectId } = require('mongoose');
const Rating = require('../models/Rating');
const Product = require('../models/Product');

/**
 * Recalculate avg rating + ratings count for a product.
 * Only counts ratings with status === "published".
 *
 * Updates Product.avgRating and Product.ratingsCount.
 *
 * @param {string|mongoose.Types.ObjectId} productId
 * @returns {Promise<{ ok: boolean, avgRating: number, ratingsCount: number }>}
 */
async function recalcProductRating(productId) {
  try {
    if (!productId || !isValidObjectId(productId)) {
      return { ok: false, avgRating: 0, ratingsCount: 0 };
    }

    // ✅ Always cast once, then use consistently
    const pid = new mongoose.Types.ObjectId(String(productId));

    const [agg] = await Rating.aggregate([
      { $match: { productId: pid, status: 'published' } },
      { $group: { _id: '$productId', avg: { $avg: '$stars' }, cnt: { $sum: 1 } } },
    ]);

    const avgRating = agg ? Number(Number(agg.avg || 0).toFixed(2)) : 0;
    const ratingsCount = agg ? Number(agg.cnt || 0) : 0;

    await Product.updateOne(
      { _id: pid },
      { $set: { avgRating, ratingsCount } },
      { strict: false }, // ok even if fields aren't in schema yet
    );

    return { ok: true, avgRating, ratingsCount };
  } catch (err) {
    console.error('recalcProductRating error:', err);
    return { ok: false, avgRating: 0, ratingsCount: 0 };
  }
}

/**
 * Bulk refresh ratings for many products (one-time backfill helper).
 * @param {Array<string|mongoose.Types.ObjectId>} productIds
 */
async function bulkRecalcProductRatings(productIds = []) {
  for (const id of productIds) {
    // eslint-disable-next-line no-await-in-loop
    await recalcProductRating(id);
  }
}

module.exports = { recalcProductRating, bulkRecalcProductRatings };
