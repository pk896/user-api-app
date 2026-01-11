// routes/productRatingsApi.js
'use strict';

const express = require('express');
const Product = require('../models/Product');
const Rating = require('../models/Rating');

const router = express.Router();

async function getProductByCustomId(customId) {
  if (!customId) return null;
  return await Product.findOne({ customId: String(customId).trim() })
    .select('_id customId avgRating ratingsCount')
    .lean();
}

/**
 * GET /api/products/:customId/ratings?page=&limit=&fresh=1
 * Public list (published only) + returns avg/count
 */
router.get('/products/:customId/ratings', async (req, res) => {
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

router.get('/_ping', (req, res) => {
  res.json({ ok: true, hit: 'productRatingsApi', path: req.originalUrl });
});

module.exports = router;
