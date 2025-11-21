// utils/ratingUtils.js
const Rating = require('../models/Rating');
const Product = require('../models/Product');

async function recalcProductRating(productId) {
  const [res] = await Rating.aggregate([
    { $match: { productId, status: 'published' } },
    { $group: { _id: '$productId', avg: { $avg: '$stars' }, cnt: { $sum: 1 } } },
  ]);
  const avg = res ? Number(res.avg.toFixed(2)) : 0;
  const cnt = res ? res.cnt : 0;
  await Product.updateOne({ _id: productId }, { $set: { avgRating: avg, ratingsCount: cnt } });
  return { avg, cnt };
}

module.exports = { recalcProductRating };
