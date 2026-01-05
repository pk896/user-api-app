// routes/debugDanger.js
'use strict';

const express = require('express');
const router = express.Router();

let requireAdmin = null;
try {
  requireAdmin = require('../middleware/requireAdmin');
} catch (e) {
  // Fallback (ONLY if your requireAdmin file is missing for some reason)
  requireAdmin = (req, res, next) => {
    if (req.session?.admin) return next();
    return res.status(401).json({ ok: false, message: 'Unauthorized (admin only).' });
  };
}

let Order = null;
try {
  Order = require('../models/Order');
} catch (e) {
  Order = null;
}

function safeInt(v, def) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : def;
}

// GET /_danger/ping
router.get('/ping', requireAdmin, (req, res) => {
  res.json({ ok: true, route: '/_danger', now: new Date().toISOString() });
});

// GET /_danger/orders/stats
router.get('/orders/stats', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const count = await Order.countDocuments({});
    const latest = await Order.find({}, { _id: 1, orderId: 1, status: 1, paymentStatus: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const newest = latest?.[0]?.createdAt ? new Date(latest[0].createdAt).toISOString() : null;

    res.json({ ok: true, count, newest, latest });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load stats.' });
  }
});

// GET /_danger/orders
router.get('/orders', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const page = Math.max(1, safeInt(req.query.page, 1));
    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 20)));
    const skip = (page - 1) * limit;

    const sortStr = String(req.query.sort || '-createdAt');
    const sort = sortStr.startsWith('-') ? { [sortStr.slice(1)]: -1 } : { [sortStr]: 1 };

    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const paymentStatus = String(req.query.paymentStatus || '').trim();

    const filter = {};
    if (q) {
      filter.$or = [
        { orderId: { $regex: q, $options: 'i' } },
        { status: { $regex: q, $options: 'i' } },
        { paymentStatus: { $regex: q, $options: 'i' } },
      ];
    }
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const projection = {
      orderId: 1,
      status: 1,
      paymentStatus: 1,
      amount: 1,
      refundedTotal: 1,
      refundedAt: 1,
      refundsCount: 1,
      createdAt: 1,
      updatedAt: 1,
      paypal: 1,
      capture0: 1,
      refunds: 1,
      itemsCount: 1,
      items: 1,
    };

    const [count, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter, projection).sort(sort).skip(skip).limit(limit).lean(),
    ]);

    res.json({
      ok: true,
      page,
      limit,
      count,
      pages: Math.ceil(count / limit),
      orders,
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to list orders.' });
  }
});

/**
 * GET /_danger/orders/debug-shape
 * Returns exactly: { ok, count, sampleKeys, orders }
 *
 * Query:
 * - limit (default 10, max 200)
 * - sort (default -createdAt)
 * - full=1 (optional: include full docs)
 */
router.get('/orders/debug-shape', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const limit = Math.min(200, Math.max(1, safeInt(req.query.limit, 10)));

    const sortStr = String(req.query.sort || '-createdAt');
    const sort = sortStr.startsWith('-') ? { [sortStr.slice(1)]: -1 } : { [sortStr]: 1 };

    const full = String(req.query.full || '').trim() === '1';

    const projection = full
      ? undefined
      : {
          orderId: 1,
          status: 1,
          paymentStatus: 1,
          createdAt: 1,
          updatedAt: 1,
          amount: 1,
          refundedTotal: 1,
          refundedAt: 1,
          paypal: 1,
          capture0: 1,
          refundsCount: 1,
          refunds: 1,
          itemsCount: 1,
          items: 1,
        };

    const [count, orders] = await Promise.all([
      Order.countDocuments({}),
      Order.find({}, projection).sort(sort).limit(limit).lean(),
    ]);

    const sampleKeys = (orders && orders.length) ? Object.keys(orders[0]) : [];

    res.json({ ok: true, count, sampleKeys, orders });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load debug shape.' });
  }
});

// GET /_danger/orders/:id  (Mongo _id OR orderId)
router.get('/orders/:id', requireAdmin, async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'Missing id.' });

    let doc = null;
    try {
      doc = await Order.findById(id).lean();
    } catch (e) {
      doc = null;
    }

    if (!doc) doc = await Order.findOne({ orderId: id }).lean();
    if (!doc) return res.status(404).json({ ok: false, message: 'Order not found.' });

    res.json({ ok: true, order: doc });
  } catch (err) {
    res.status(500).json({ ok: false, message: err?.message || 'Failed to load order.' });
  }
});

module.exports = router;
