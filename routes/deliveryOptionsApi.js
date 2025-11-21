// routes/deliveryOptionsApi.js
const express = require('express');
const DeliveryOption = require('../models/DeliveryOption');

const router = express.Router();

/**
 * GET /api/delivery-options
 * Public, read-only list of ACTIVE options for checkout.
 *
 * Query params (all optional):
 *  - q:         text search on name (case-insensitive)
 *  - region:    exact match on region (case-insensitive)
 *  - minDays:   minimum deliveryDays (int)
 *  - maxDays:   maximum deliveryDays (int)
 *  - sort:      "price" | "days" | "name"  (default "price")
 *  - order:     "asc" | "desc"             (default "asc")
 *  - limit:     number of items (1..100)   (default 50)
 *
 * Response items include both priceCents and price (float).
 */
router.get('/api/delivery-options', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const region = String(req.query.region || '').trim();
    const minDays = Number.isFinite(Number(req.query.minDays))
      ? Number(req.query.minDays)
      : undefined;
    const maxDays = Number.isFinite(Number(req.query.maxDays))
      ? Number(req.query.maxDays)
      : undefined;

    const sortKey = (req.query.sort || 'price').toLowerCase();
    const order = (req.query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

    const where = { active: true };
    if (q) {where.name = new RegExp(q, 'i');}
    if (region) {where.region = new RegExp(`^${escapeRegExp(region)}$`, 'i');}
    if (typeof minDays === 'number' && !Number.isNaN(minDays)) {
      where.deliveryDays = { ...(where.deliveryDays || {}), $gte: minDays };
    }
    if (typeof maxDays === 'number' && !Number.isNaN(maxDays)) {
      where.deliveryDays = { ...(where.deliveryDays || {}), $lte: maxDays };
    }

    const sortMap = {
      price: { priceCents: order, deliveryDays: order, name: 1 },
      days: { deliveryDays: order, priceCents: order, name: 1 },
      name: { name: order },
    };
    const sort = sortMap[sortKey] || sortMap.price;

    const docs = await DeliveryOption.find(where)
      .select('name deliveryDays priceCents region description active') // only public-safe fields
      .sort(sort)
      .limit(limit)
      .lean();

    const items = docs.map((d) => ({
      id: String(d._id),
      name: d.name,
      deliveryDays: Number(d.deliveryDays || 0),
      priceCents: Number(d.priceCents || 0),
      price: Number(((d.priceCents || 0) / 100).toFixed(2)),
      region: d.region || '',
      description: d.description || '',
    }));

    // small cache (optional): 30s
    res.setHeader('Cache-Control', 'public, max-age=30');
    return res.json({ options: items });
  } catch (err) {
    console.error('[api:delivery-options] error:', err);
    return res.status(500).json({ message: 'Failed to fetch delivery options' });
  }
});

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
