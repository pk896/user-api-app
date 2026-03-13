// routes/admin/dashboard.js
'use strict';

const express = require('express');
const router = express.Router();

// Use your existing admin middleware
let requireAdmin = null;
try {
  requireAdmin = require('../../middleware/requireAdmin');
} catch {
  // DEV fallback only
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

// paid-like filter
function paidLikeMatch() {
  const paidStates = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];
  return {
    $and: [
      {
        $or: [
          { status: { $in: paidStates } },
          { paymentStatus: { $in: ['paid', 'captured'] } },
        ],
      },
      { status: { $nin: ['REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'CANCELED', 'VOIDED'] } },
      { paymentStatus: { $nin: ['refunded', 'partially_refunded', 'refund_submitted', 'refund_pending'] } },
      { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] },
    ],
  };
}

/*
Build a stable payer identity.

Priority:
1. payer.email
2. payer.payerId
3. userId
4. businessBuyer
5. shipping.email
6. shipping.phone
7. fallback order:_id
*/
function customerKeyExpr() {
  return {
    $let: {
      vars: {
        payerEmail: {
          $trim: {
            input: { $toLower: { $ifNull: ['$payer.email', ''] } },
          },
        },
        payerId: {
          $trim: {
            input: { $ifNull: ['$payer.payerId', '' ] },
          },
        },
        userKey: {
          $cond: [
            { $ifNull: ['$userId', false] },
            { $concat: ['user:', { $toString: '$userId' }] },
            '',
          ],
        },
        businessKey: {
          $cond: [
            { $ifNull: ['$businessBuyer', false] },
            { $concat: ['business:', { $toString: '$businessBuyer' }] },
            '',
          ],
        },
        shippingEmail: {
          $trim: {
            input: { $toLower: { $ifNull: ['$shipping.email', ''] } },
          },
        },
        shippingPhone: {
          $trim: {
            input: { $ifNull: ['$shipping.phone', ''] },
          },
        },
      },
      in: {
        $switch: {
          branches: [
            {
              case: { $gt: [{ $strLenCP: '$$payerEmail' }, 0] },
              then: { $concat: ['email:', '$$payerEmail'] },
            },
            {
              case: { $gt: [{ $strLenCP: '$$payerId' }, 0] },
              then: { $concat: ['payerId:', '$$payerId'] },
            },
            {
              case: { $gt: [{ $strLenCP: '$$userKey' }, 0] },
              then: '$$userKey',
            },
            {
              case: { $gt: [{ $strLenCP: '$$businessKey' }, 0] },
              then: '$$businessKey',
            },
            {
              case: { $gt: [{ $strLenCP: '$$shippingEmail' }, 0] },
              then: { $concat: ['shippingEmail:', '$$shippingEmail'] },
            },
            {
              case: { $gt: [{ $strLenCP: '$$shippingPhone' }, 0] },
              then: { $concat: ['shippingPhone:', '$$shippingPhone'] },
            },
          ],
          default: { $concat: ['order:', { $toString: '$_id' }] },
        },
      },
    },
  };
}

// Counts unique payers for a day:
// - newClients = first-ever paid order was on that day
// - recurringClients = paid on that day, but first-ever paid order was before that day
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

    {
      $group: {
        _id: '$customerKey',
        firstPaidAt: { $min: '$createdAt' },
        paidThatDay: {
          $max: {
            $cond: [
              {
                $and: [
                  { $gte: ['$createdAt', dayStart] },
                  { $lte: ['$createdAt', dayEnd] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },

    {
      $project: {
        isNewThatDay: {
          $cond: [
            {
              $and: [
                { $eq: ['$paidThatDay', 1] },
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
              $and: [
                { $eq: ['$paidThatDay', 1] },
                { $lt: ['$firstPaidAt', dayStart] },
              ],
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

    // Last 7 rolling days (oldest -> newest)
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);

      const dStart = startOfDay(d);
      const dEnd = endOfDay(d);

      const counts = await cohortCountsForDay(dStart, dEnd);
      const dayName = d.toLocaleDateString('en-US', { weekday: 'long' });

      week.push({
        day: dayName,
        date: dStart.toISOString().slice(0, 10),
        newClients: counts.newClients,
        recurringClients: counts.recurringClients,
      });
    }

    // Percentages for progress bars
    const maxNew = Math.max(1, ...week.map((x) => Number(x.newClients || 0)));
    const maxRec = Math.max(1, ...week.map((x) => Number(x.recurringClients || 0)));

    const weekWithPct = week.map((x) => ({
      ...x,
      newPct: Math.round((Number(x.newClients || 0) / maxNew) * 100),
      recurringPct: Math.round((Number(x.recurringClients || 0) / maxRec) * 100),
    }));

    return res.json({
      ok: true,
      today: {
        newClients: today.newClients,
        recurringClients: today.recurringClients,
      },
      week: {
        start: weekWithPct[0]?.date || null,
        end: weekWithPct[weekWithPct.length - 1]?.date || null,
        days: weekWithPct,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[admin/dashboard] traffic-sales error:', e?.stack || e);
    return res.status(500).json({ ok: false, message: 'Server error building traffic-sales.' });
  }
});

// ------------------------------------------------------
// GET /admin/api/dashboard/top-sellers-locations
// ------------------------------------------------------
router.get('/top-sellers-locations', requireAdmin, async (req, res) => {
  try {
    if (!Order || !Product || !Business) {
      return res.status(500).json({
        ok: false,
        message: 'Models not available (Order/Product/Business).',
      });
    }

    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

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
          localField: 'items.productId',
          foreignField: 'customId',
          as: 'prod',
        },
      },
      { $unwind: '$prod' },
      {
        $group: {
          _id: '$prod.business',
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
          revenue: { $toDouble: '$revenue' },
          itemsSold: 1,
          ordersCount: 1,
          lastOrderAt: 1,
        },
      },
    ]).allowDiskUse(true);

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
// ------------------------------------------------------
router.get('/sales-series', requireAdmin, async (req, res) => {
  try {
    if (!Order) {
      return res.status(500).json({ ok: false, message: 'Order model not available.' });
    }

    const now = new Date();

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

    const safeItemValueDecimal = {
      $toDecimal: {
        $ifNull: [
          '$items.price.value',
          { $ifNull: ['$items.priceGross.value', '0'] },
        ],
      },
    };

    const safeQtyDecimal = { $toDecimal: { $toString: '$items.quantity' } };

    // DAY
    const daySince = new Date(now);
    daySince.setDate(daySince.getDate() - 6);
    daySince.setHours(0, 0, 0, 0);

    const dayAgg = await Order.aggregate([
      { $match: { ...baseMatch, createdAt: { $gte: daySince } } },
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

    const dayMap = new Map(dayAgg.map((x) => [x.key, x]));
    const daySeries = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      daySeries.push(dayMap.get(key) || { key, sales: 0, orders: 0 });
    }

    // MONTH
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
      monthSeries.push(monthMap.get(key) || { key, sales: 0, orders: 0 });
    }

    // YEAR
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

    const yearMap = new Map(yearAgg.map((x) => [x.key, x]));
    const yearSeries = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toISOString().slice(0, 7);
      yearSeries.push(yearMap.get(key) || { key, sales: 0, orders: 0 });
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