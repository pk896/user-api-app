// routes/deliveryOptionsApi.js
'use strict';

const express = require('express');
const DeliveryOption = require('../models/DeliveryOption');

const router = express.Router();

/**
 * GET /api/delivery-options
 * Public read-only list (checkout uses this).
 *
 * Query params (optional):
 *  - q, region, minDays, maxDays, sort=price|days|name, order=asc|desc, limit
 *  - active=1|0 (default: 1)
 */
router.get('/delivery-options', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const region = String(req.query.region || '').trim();

    const minDays = Number.isFinite(Number(req.query.minDays))
      ? Number(req.query.minDays)
      : undefined;
    const maxDays = Number.isFinite(Number(req.query.maxDays))
      ? Number(req.query.maxDays)
      : undefined;

    const sortKey = String(req.query.sort || 'price').toLowerCase();
    const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? -1 : 1;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));

    // ✅ default to active=1 for checkout
    const activeParam = String(req.query.active ?? '1').trim();
    const active =
      activeParam === '0' || activeParam.toLowerCase() === 'false'
        ? false
        : true;

    const where = { active };

    if (q) where.name = new RegExp(escapeRegExp(q), 'i');
    if (region) where.region = new RegExp(`^${escapeRegExp(region)}$`, 'i');

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
      .select('name deliveryDays priceCents region description active')
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
      active: !!d.active,
    }));

    res.setHeader('Cache-Control', 'no-store');
    return res.json({ options: items });
  } catch (err) {
    console.error('[api:delivery-options] error:', err);
    return res.status(500).json({ message: 'Failed to fetch delivery options' });
  }
});

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = router;
