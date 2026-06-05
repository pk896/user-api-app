// routes/adminFailedPayoutsMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Payout = require('../models/Payout');

const router = express.Router();

function getBaseCurrency() {
  return (
    String(process.env.BASE_CURRENCY || '')
      .trim()
      .toUpperCase() || 'USD'
  );
}

function centsToAmount(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

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

// GET /api/admin/failed-payouts-metric
router.get('/failed-payouts-metric', requireAdmin, async (req, res) => {
  try {
    const currency = getBaseCurrency();

    const start = new Date();
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);

    /**
     * FAILED payout items are seller/supplier payout attempts that failed.
     *
     * Some payout items may not have a failedAt field,
     * so we fallback to updatedAt, meta.lastSyncAt, then createdAt.
     */
    const failedRows = await Payout.aggregate([
      {
        $match: {
          $or: [
            { status: 'FAILED' },
            { 'items.status': 'FAILED' },
          ],
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.status': 'FAILED',
          $expr: {
            $eq: [
              {
                $toUpper: {
                  $ifNull: ['$items.currency', '$currency'],
                },
              },
              currency,
            ],
          },
        },
      },
      {
        $addFields: {
          effectiveFailedAt: {
            $ifNull: [
              '$items.failedAt',
              {
                $ifNull: [
                  '$updatedAt',
                  {
                    $ifNull: ['$meta.lastSyncAt', '$createdAt'],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $match: {
          effectiveFailedAt: { $gte: start },
        },
      },
      {
        $group: {
          _id: null,

          failedPayoutCents: {
            $sum: {
              $max: [
                0,
                {
                  $toInt: {
                    $ifNull: ['$items.amountCents', 0],
                  },
                },
              ],
            },
          },

          failedItems: { $sum: 1 },
          failedBatches: { $addToSet: '$_id' },
          latestFailedAt: { $max: '$effectiveFailedAt' },
        },
      },
      {
        $project: {
          _id: 0,
          failedPayoutCents: 1,
          failedItems: 1,
          failedBatchesCount: { $size: '$failedBatches' },
          latestFailedAt: 1,
        },
      },
    ]).allowDiskUse(true);

    const row = failedRows[0] || {
      failedPayoutCents: 0,
      failedItems: 0,
      failedBatchesCount: 0,
      latestFailedAt: null,
    };

    /**
     * Last 7 calendar days chart data.
     * This is included so the card can become a small trend chart later.
     */
    const todayEnd = endOfDay(new Date());
    const chartStart = startOfDay(
      new Date(
        todayEnd.getFullYear(),
        todayEnd.getMonth(),
        todayEnd.getDate() - 6
      )
    );

    const chartRows = await Payout.aggregate([
      {
        $match: {
          $or: [
            { status: 'FAILED' },
            { 'items.status': 'FAILED' },
          ],
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.status': 'FAILED',
          $expr: {
            $eq: [
              {
                $toUpper: {
                  $ifNull: ['$items.currency', '$currency'],
                },
              },
              currency,
            ],
          },
        },
      },
      {
        $addFields: {
          effectiveFailedAt: {
            $ifNull: [
              '$items.failedAt',
              {
                $ifNull: [
                  '$updatedAt',
                  {
                    $ifNull: ['$meta.lastSyncAt', '$createdAt'],
                  },
                ],
              },
            ],
          },
        },
      },
      {
        $match: {
          effectiveFailedAt: {
            $gte: chartStart,
            $lte: todayEnd,
          },
        },
      },
      {
        $project: {
          amountCents: {
            $max: [
              0,
              {
                $toInt: {
                  $ifNull: ['$items.amountCents', 0],
                },
              },
            ],
          },
          dayKey: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$effectiveFailedAt',
            },
          },
        },
      },
      {
        $group: {
          _id: '$dayKey',
          totalCents: { $sum: '$amountCents' },
          failedItems: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true);

    const chartMap = new Map(
      chartRows.map((r) => [
        String(r._id),
        {
          totalCents: Number(r.totalCents || 0),
          failedItems: Number(r.failedItems || 0),
        },
      ])
    );

    const chartLabels = [];
    const chartData = [];
    const chartFailedItems = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(chartStart);
      day.setDate(chartStart.getDate() + i);

      const key = day.toISOString().slice(0, 10);
      const chartRow = chartMap.get(key) || {
        totalCents: 0,
        failedItems: 0,
      };

      chartLabels.push(
        day.toLocaleDateString('en-US', { weekday: 'short' })
      );

      chartData.push(centsToAmount(chartRow.totalCents || 0));
      chartFailedItems.push(Number(chartRow.failedItems || 0));
    }

    return res.json({
      ok: true,
      currency,
      windowDays: 30,
      label: 'Failed Payouts',
      description: 'Payout attempts that failed and may need admin action.',

      failedPayouts: centsToAmount(row.failedPayoutCents),
      failedItems: Number(row.failedItems || 0),
      failedBatchesCount: Number(row.failedBatchesCount || 0),
      latestFailedAt: row.latestFailedAt || null,

      chart: {
        labels: chartLabels,
        data: chartData,
        failedItems: chartFailedItems,
      },
    });
  } catch (err) {
    console.error('❌ admin failed payouts metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Failed Payouts metric',
    });
  }
});

module.exports = router;