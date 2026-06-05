// routes/adminPayoutsCompletedMetricApi.js
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

// GET /api/admin/payouts-completed-metric
router.get('/payouts-completed-metric', requireAdmin, async (req, res) => {
  try {
    const currency = getBaseCurrency();

    const start = new Date();
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);

    /**
     * SENT payout items are completed seller/supplier payments.
     *
     * Some older payout items may not have items.paidAt,
     * so we fallback to updatedAt, meta.lastSyncAt, then createdAt.
     */
    const completedRows = await Payout.aggregate([
      {
        $match: {
          'items.status': 'SENT',
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.status': 'SENT',
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
          effectivePaidAt: {
            $ifNull: [
              '$items.paidAt',
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
          effectivePaidAt: { $gte: start },
        },
      },
      {
        $group: {
          _id: null,

          completedPayoutCents: {
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

          completedItems: { $sum: 1 },
          completedBatches: { $addToSet: '$_id' },
          latestCompletedAt: { $max: '$effectivePaidAt' },
        },
      },
      {
        $project: {
          _id: 0,
          completedPayoutCents: 1,
          completedItems: 1,
          completedBatchesCount: { $size: '$completedBatches' },
          latestCompletedAt: 1,
        },
      },
    ]).allowDiskUse(true);

    const row = completedRows[0] || {
      completedPayoutCents: 0,
      completedItems: 0,
      completedBatchesCount: 0,
      latestCompletedAt: null,
    };

    /**
     * Last 7 calendar days chart data.
     * We keep it in the API now so later you can easily turn this card
     * into a small trend chart without changing the backend again.
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
          'items.status': 'SENT',
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.status': 'SENT',
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
          effectivePaidAt: {
            $ifNull: [
              '$items.paidAt',
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
          effectivePaidAt: {
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
              date: '$effectivePaidAt',
            },
          },
        },
      },
      {
        $group: {
          _id: '$dayKey',
          totalCents: { $sum: '$amountCents' },
        },
      },
      { $sort: { _id: 1 } },
    ]).allowDiskUse(true);

    const chartMap = new Map(
      chartRows.map((r) => [String(r._id), Number(r.totalCents || 0)])
    );

    const chartLabels = [];
    const chartData = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(chartStart);
      day.setDate(chartStart.getDate() + i);

      const key = day.toISOString().slice(0, 10);

      chartLabels.push(
        day.toLocaleDateString('en-US', { weekday: 'short' })
      );

      chartData.push(centsToAmount(chartMap.get(key) || 0));
    }

    return res.json({
      ok: true,
      currency,
      windowDays: 30,
      label: 'Payouts Completed',
      description: 'Money already paid to sellers and suppliers.',

      payoutsCompleted: centsToAmount(row.completedPayoutCents),
      completedItems: Number(row.completedItems || 0),
      completedBatchesCount: Number(row.completedBatchesCount || 0),
      latestCompletedAt: row.latestCompletedAt || null,

      chart: {
        labels: chartLabels,
        data: chartData,
      },
    });
  } catch (err) {
    console.error('❌ admin payouts completed metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Payouts Completed metric',
    });
  }
});

module.exports = router;