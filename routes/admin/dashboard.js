// routes/admin/dashboard.js
'use strict';

const express = require('express');
const router = express.Router();

// Use your existing admin middleware
let requireAdmin = null;
try {
  requireAdmin = require('../../middleware/requireAdmin');
} catch {
  // DEV fallback only (same style as your payment.js)
  requireAdmin = (req, res, next) => {
    if (req.session?.admin) return next();
    return res.status(401).json({ ok: false, message: 'Unauthorized (admin only).' });
  };
}

// Load Order model
let Order = null;
try {
  Order = require('../../models/Order');
} catch (e) {
  console.error('[admin/dashboard] Failed to load Order model:', e?.stack || e);
  Order = null;
}

// Load Product model
let Product = null;
try {
  Product = require('../../models/Product');
} catch (e) {
  console.error('[admin/dashboard] Failed to load Product model:', e?.stack || e);
  Product = null;
}

// Load Business model
let Business = null;
try {
  Business = require('../../models/Business');
} catch (e) {
  console.error('[admin/dashboard] Failed to load Business model:', e?.stack || e);
  Business = null;
}

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

// Monday-start week (Mon 00:00 to Sun 23:59)
function startOfWeekMonday(now = new Date()) {
  const d = startOfDay(now);
  const day = d.getDay(); // 0=Sun,1=Mon,...6=Sat
  const diff = (day === 0 ? -6 : 1 - day); // move back to Monday
  d.setDate(d.getDate() + diff);
  return d;
}

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

// paid-like filter (match your Order.js PAID_STATES + your stored paymentStatus values)
function paidLikeMatch() {
  const paidStates = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];
  return {
    $or: [
      { status: { $in: paidStates } },
      { paymentStatus: { $in: ['paid', 'captured'] } }, // you use captured in places
    ],
  };
}

// Build a stable customer key:
// - prefer payer.email
// - else userId
// - else businessBuyer
// - else fallback "unknown"
function customerKeyExpr() {
  return {
    $ifNull: [
      { $toLower: '$payer.email' },
      {
        $ifNull: [
          { $cond: [{ $ifNull: ['$userId', false] }, { $toString: '$userId' }, null] },
          {
            $ifNull: [
              {
                $cond: [
                  { $ifNull: ['$businessBuyer', false] },
                  { $toString: '$businessBuyer' },
                  null,
                ],
              },
              'unknown',
            ],
          },
        ],
      },
    ],
  };
}

// Counts (unique customers) for a specific day:
// newClients = firstPaidAt within day AND hasPaidThatDay
// recurringClients = firstPaidAt before day AND hasPaidThatDay
async function cohortCountsForDay(dayStart, dayEnd) {
  if (!Order) return { newClients: 0, recurringClients: 0 };

  const pipeline = [
    { $match: paidLikeMatch() },

    {
      $project: {
        createdAt: 1,
        customerKey: customerKeyExpr(),
      },
    },

    // group per customer across ALL time (paid-like only)
    {
      $group: {
        _id: '$customerKey',
        firstPaidAt: { $min: '$createdAt' },
        hasPaidThatDay: {
          $max: {
            $cond: [
              { $and: [{ $gte: ['$createdAt', dayStart] }, { $lte: ['$createdAt', dayEnd] }] },
              1,
              0,
            ],
          },
        },
      },
    },

    // classify customers who paid that day
    {
      $project: {
        isNewThatDay: {
          $cond: [
            {
              $and: [
                { $eq: ['$hasPaidThatDay', 1] },
                { $gte: ['$firstPaidAt', dayStart] },
                { $lte: ['$firstPaidAt', dayEnd] },
              ],
            },
            1,
            0,
          ],
        },
        isRecurringThatDay: {
          $cond: [
            {
              $and: [{ $eq: ['$hasPaidThatDay', 1] }, { $lt: ['$firstPaidAt', dayStart] }],
            },
            1,
            0,
          ],
        },
      },
    },

    {
      $group: {
        _id: null,
        newClients: { $sum: '$isNewThatDay' },
        recurringClients: { $sum: '$isRecurringThatDay' },
      },
    },
  ];

  const r = await Order.aggregate(pipeline).allowDiskUse(true);
  const row = r?.[0] || {};
  return {
    newClients: Number(row.newClients || 0),
    recurringClients: Number(row.recurringClients || 0),
  };
}

// ------------------------------------------------------
// GET /admin/api/dashboard/traffic-sales
// (mounted in server.js as: app.use('/admin/api/dashboard', adminDashboardRouter);)
// so this router path is just "/traffic-sales"
// ------------------------------------------------------
router.get('/traffic-sales', requireAdmin, async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({ ok: false, message: 'Order model not available.' });
    }

    const now = new Date();

    // Today
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const today = await cohortCountsForDay(todayStart, todayEnd);

    // Week Mon..Sun (current week)
    const weekStart = startOfWeekMonday(now);
    const week = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(d.getDate() + i);

      const dStart = startOfDay(d);
      const dEnd = endOfDay(d);

      const counts = await cohortCountsForDay(dStart, dEnd);

      week.push({
        day: DAY_NAMES[i],
        date: dStart.toISOString().slice(0, 10),
        newClients: counts.newClients,
        recurringClients: counts.recurringClients,
      });
    }

    // Percentages for progress bars (scale each series by its max in the week)
    const maxNew = Math.max(1, ...week.map((x) => x.newClients));
    const maxRec = Math.max(1, ...week.map((x) => x.recurringClients));

    const weekWithPct = week.map((x) => ({
      ...x,
      newPct: Math.round((x.newClients / maxNew) * 100),
      recurringPct: Math.round((x.recurringClients / maxRec) * 100),
    }));

    return res.json({
      ok: true,
      today: {
        newClients: today.newClients,
        recurringClients: today.recurringClients,
      },
      week: {
        start: weekStart.toISOString(),
        days: weekWithPct,
      },
    });
  } catch (e) {
    console.error('[admin/dashboard] traffic-sales error:', e?.stack || e);
    return res.status(500).json({ ok: false, message: 'Server error building traffic-sales.' });
  }
});

// ------------------------------------------------------
// GET /admin/api/dashboard/top-sellers-locations
// - Top 6 seller businesses by revenue (from orders/items)
// - Top 5 business locations by count
// ------------------------------------------------------
router.get('/top-sellers-locations', requireAdmin, async (req, res) => {
  try {
    if (!Order || !Product || !Business) {
      return res.status(500).json({
        ok: false,
        message: 'Models not available (Order/Product/Business).',
      });
    }

    // Optional window: last N days (default 30)
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    // Paid-like + exclude refunded/cancelled (conservative)
    const paidStates = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];
    const cancelStates = ['CANCELLED', 'CANCELED', 'VOIDED'];
    const refundStates = ['REFUNDED', 'PARTIALLY_REFUNDED'];

    const match = {
      createdAt: { $gte: since },
      $and: [
        {
          $or: [
            { status: { $in: paidStates } },
            { paymentStatus: { $in: ['paid', 'captured'] } },
          ],
        },
        { status: { $nin: [...cancelStates, ...refundStates] } },
        { paymentStatus: { $nin: ['refunded', 'partially_refunded', 'refund_submitted', 'refund_pending'] } },
        { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] },
      ],
    };

    // ---------- Top 6 sellers ----------
    // Orders -> unwind items -> lookup Product by items.productId (Product.customId)
    // -> group by product.business -> sum revenue + qty, count unique orders, last order date
    const topSellersAgg = await Order.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $match: {
          'items.productId': { $type: 'string', $ne: '' },
          'items.quantity': { $gt: 0 },
        },
      },
      {
        $lookup: {
          from: 'products',
          localField: 'items.productId',   // OrderItemSchema.productId = Product.customId
          foreignField: 'customId',
          as: 'prod',
        },
      },
      { $unwind: '$prod' },
      {
        $group: {
          _id: '$prod.business', // business ObjectId
          revenue: {
            $sum: {
              $multiply: [
                {
                  $toDecimal: {
                    $ifNull: [
                      '$items.price.value',
                      { $ifNull: ['$items.priceGross.value', '0'] },
                    ],
                  },
                },
                { $toDecimal: { $toString: '$items.quantity' } },
              ],
            },
          },
          itemsSold: { $sum: '$items.quantity' },
          orderIds: { $addToSet: { $ifNull: ['$orderId', { $toString: '$_id' }] } },
          lastOrderAt: { $max: '$createdAt' },
        },
      },
      {
        $project: {
          businessId: '$_id',
          revenue: 1,
          itemsSold: 1,
          ordersCount: { $size: '$orderIds' },
          lastOrderAt: 1,
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 6 },
      {
        $lookup: {
          from: 'businesses',
          localField: 'businessId',
          foreignField: '_id',
          as: 'biz',
        },
      },
      { $unwind: '$biz' },
      {
        $project: {
          businessId: 1,
          businessName: '$biz.name',
          country: '$biz.country',
          city: '$biz.city',
          revenue: { $toDouble: '$revenue' }, // return as number
          itemsSold: 1,
          ordersCount: 1,
          lastOrderAt: 1,
        },
      },
    ]).allowDiskUse(true);

    // ---------- Top 5 locations by business count ----------
    const topLocationsAgg = await Business.aggregate([
      {
        $project: {
          country: { $ifNull: ['$country', 'Unknown'] },
          city: { $ifNull: ['$city', 'Unknown'] },
        },
      },
      {
        $group: {
          _id: { country: '$country', city: '$city' },
          count: { $sum: 1 },
        },
      },
      { $sort: { count: -1 } },
      { $limit: 5 },
      {
        $project: {
          _id: 0,
          country: '$_id.country',
          city: '$_id.city',
          count: 1,
        },
      },
    ]);

    return res.json({
      ok: true,
      windowDays: days,
      since: since.toISOString(),
      topSellers: topSellersAgg.map((x) => ({
        businessId: String(x.businessId),
        businessName: x.businessName || '(unknown)',
        country: x.country || '—',
        city: x.city || '—',
        revenue: Number(x.revenue || 0),
        itemsSold: Number(x.itemsSold || 0),
        ordersCount: Number(x.ordersCount || 0),
        lastOrderAt: x.lastOrderAt || null,
      })),
      topLocations: topLocationsAgg,
    });
  } catch (e) {
    console.error('[admin/dashboard] top-sellers-locations error:', e?.stack || e);
    return res.status(500).json({ ok: false, message: 'Server error building top sellers.' });
  }
});


// ------------------------------------------------------
// GET /admin/api/dashboard/sales-series
// - Returns sales totals grouped by:
//   day (last 7 days), month (last 30 days), year (last 12 months)
// - Uses paid-like filter and excludes refunded/cancelled (same approach as your other routes)
// ------------------------------------------------------
router.get('/sales-series', requireAdmin, async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({ ok: false, message: 'Order model not available.' });
    }

    const now = new Date();

    // ---- filters (match your existing logic style) ----
    const paidStates = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];
    const cancelStates = ['CANCELLED', 'CANCELED', 'VOIDED'];
    const refundStates = ['REFUNDED', 'PARTIALLY_REFUNDED'];

    const baseMatch = {
      $and: [
        {
          $or: [
            { status: { $in: paidStates } },
            { paymentStatus: { $in: ['paid', 'captured'] } },
          ],
        },
        { status: { $nin: [...cancelStates, ...refundStates] } },
        { paymentStatus: { $nin: ['refunded', 'partially_refunded', 'refund_submitted', 'refund_pending'] } },
        { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] },
      ],
    };

    // ---- helper expressions ----
    const safeItemValueDecimal = {
      $toDecimal: {
        $ifNull: [
          '$items.price.value',
          { $ifNull: ['$items.priceGross.value', '0'] },
        ],
      },
    };

    const safeQtyDecimal = { $toDecimal: { $toString: '$items.quantity' } };

    // ================
    // A) DAY: last 7 days (group by YYYY-MM-DD)
    // ================
    const daySince = new Date(now);
    daySince.setDate(daySince.getDate() - 6);
    daySince.setHours(0, 0, 0, 0);

    const dayAgg = await Order.aggregate([
      { $match: { ...baseMatch, createdAt: { $gte: daySince } } },
      { $unwind: '$items' },
      {
        $match: {
          'items.quantity': { $gt: 0 },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          sales: {
            $sum: { $multiply: [safeItemValueDecimal, safeQtyDecimal] },
          },
          orders: { $addToSet: { $ifNull: ['$orderId', { $toString: '$_id' }] } },
        },
      },
      {
        $project: {
          _id: 0,
          key: '$_id',
          sales: { $toDouble: '$sales' },
          orders: { $size: '$orders' },
        },
      },
      { $sort: { key: 1 } },
    ]).allowDiskUse(true);

    // Fill missing days with 0
    const dayMap = new Map(dayAgg.map((x) => [x.key, x]));
    const daySeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = dayMap.get(key) || { key, sales: 0, orders: 0 };
      daySeries.push(row);
    }

    // ================
    // B) MONTH: last 30 days (group by YYYY-MM-DD)
    // ================
    const monthSince = new Date(now);
    monthSince.setDate(monthSince.getDate() - 29);
    monthSince.setHours(0, 0, 0, 0);

    const monthAgg = await Order.aggregate([
      { $match: { ...baseMatch, createdAt: { $gte: monthSince } } },
      { $unwind: '$items' },
      { $match: { 'items.quantity': { $gt: 0 } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          sales: { $sum: { $multiply: [safeItemValueDecimal, safeQtyDecimal] } },
          orders: { $addToSet: { $ifNull: ['$orderId', { $toString: '$_id' }] } },
        },
      },
      {
        $project: {
          _id: 0,
          key: '$_id',
          sales: { $toDouble: '$sales' },
          orders: { $size: '$orders' },
        },
      },
      { $sort: { key: 1 } },
    ]).allowDiskUse(true);

    const monthMap = new Map(monthAgg.map((x) => [x.key, x]));
    const monthSeries = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const row = monthMap.get(key) || { key, sales: 0, orders: 0 };
      monthSeries.push(row);
    }

    // ================
    // C) YEAR: last 12 months (group by YYYY-MM)
    // ================
    const yearStart = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    yearStart.setHours(0, 0, 0, 0);

    const yearAgg = await Order.aggregate([
      { $match: { ...baseMatch, createdAt: { $gte: yearStart } } },
      { $unwind: '$items' },
      { $match: { 'items.quantity': { $gt: 0 } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          sales: { $sum: { $multiply: [safeItemValueDecimal, safeQtyDecimal] } },
          orders: { $addToSet: { $ifNull: ['$orderId', { $toString: '$_id' }] } },
        },
      },
      {
        $project: {
          _id: 0,
          key: '$_id',
          sales: { $toDouble: '$sales' },
          orders: { $size: '$orders' },
        },
      },
      { $sort: { key: 1 } },
    ]).allowDiskUse(true);

    // Fill missing months with 0
    const yearMap = new Map(yearAgg.map((x) => [x.key, x]));
    const yearSeries = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      const row = yearMap.get(key) || { key, sales: 0, orders: 0 };
      yearSeries.push(row);
    }

    return res.json({
      ok: true,
      day: daySeries,
      month: monthSeries,
      year: yearSeries,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin/dashboard] sales-series error:', e?.stack || e);
    return res.status(500).json({ ok: false, message: 'Server error building sales series.' });
  }
});

module.exports = router;

