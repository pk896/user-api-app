// routes/adminPlatformFeesMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';

const DEFAULT_PLATFORM_FEE_BPS = (() => {
  const n = Number(process.env.PLATFORM_FEE_BPS || 1000);
  if (!Number.isFinite(n)) return 1000;
  return Math.max(0, Math.min(5000, Math.round(n)));
})();

const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const REFUND_STATES = ['REFUNDED', 'PARTIALLY_REFUNDED'];
const CANCEL_STATES = ['CANCELLED', 'CANCELED', 'VOIDED'];

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

// GET /api/admin/platform-fees-metric
router.get('/platform-fees-metric', requireAdmin, async (req, res) => {
  try {
    const start = new Date();
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);

    const result = await Order.aggregate([
      {
        $match: {
          createdAt: { $gte: start },
        },
      },
      {
        $project: {
          orderKey: {
            $ifNull: ['$orderId', { $toString: '$_id' }],
          },

          statusU: {
            $toUpper: {
              $ifNull: ['$status', ''],
            },
          },

          paymentStatusU: {
            $toUpper: {
              $ifNull: ['$paymentStatus', ''],
            },
          },

          amountNum: {
            $convert: {
              input: { $ifNull: ['$amount.value', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          refundedTotalNum: {
            $convert: {
              input: { $ifNull: ['$refundedTotal', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          shippingBreakdownNum: {
            $convert: {
              input: { $ifNull: ['$breakdown.shipping.value', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          deliveryAmountNum: {
            $convert: {
              input: { $ifNull: ['$delivery.amount', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          platformFeeBpsNum: {
            $convert: {
              input: {
                $ifNull: ['$platformFeeBps', DEFAULT_PLATFORM_FEE_BPS],
              },
              to: 'double',
              onError: DEFAULT_PLATFORM_FEE_BPS,
              onNull: DEFAULT_PLATFORM_FEE_BPS,
            },
          },

          items: {
            $ifNull: ['$items', []],
          },
        },
      },
      {
        $addFields: {
          isPaidLike: {
            $or: [
              { $in: ['$statusU', PAID_STATES] },
              { $in: ['$paymentStatusU', PAID_STATES] },
              { $in: ['$statusU', REFUND_STATES] },
              { $in: ['$paymentStatusU', REFUND_STATES] },
            ],
          },

          isCancelledLike: {
            $or: [
              { $in: ['$statusU', CANCEL_STATES] },
              { $in: ['$paymentStatusU', CANCEL_STATES] },
            ],
          },

          safePlatformFeeBps: {
            $min: [
              5000,
              {
                $max: [0, '$platformFeeBpsNum'],
              },
            ],
          },

          shippingNum: {
            $cond: [
              { $gt: ['$shippingBreakdownNum', 0] },
              '$shippingBreakdownNum',
              '$deliveryAmountNum',
            ],
          },
        },
      },
      {
        $unwind: {
          path: '$items',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $project: {
          orderKey: 1,
          amountNum: 1,
          refundedTotalNum: 1,
          shippingNum: 1,
          isPaidLike: 1,
          isCancelledLike: 1,
          safePlatformFeeBps: 1,

          itemQty: {
            $convert: {
              input: { $ifNull: ['$items.quantity', 0] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          itemUnitGross: {
            $convert: {
              input: {
                $ifNull: [
                  '$items.priceGross.value',
                  {
                    $ifNull: ['$items.price.value', 0],
                  },
                ],
              },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },
        },
      },
      {
        $group: {
          _id: '$orderKey',

          amountNum: { $first: '$amountNum' },
          refundedTotalNum: { $first: '$refundedTotalNum' },
          shippingNum: { $first: '$shippingNum' },
          isPaidLike: { $first: '$isPaidLike' },
          isCancelledLike: { $first: '$isCancelledLike' },
          safePlatformFeeBps: { $first: '$safePlatformFeeBps' },

          itemGrossSubtotal: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $gt: ['$itemQty', 0] },
                    { $gte: ['$itemUnitGross', 0] },
                  ],
                },
                { $multiply: ['$itemQty', '$itemUnitGross'] },
                0,
              ],
            },
          },
        },
      },
      {
        $addFields: {
          shouldCount: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isCancelledLike', false] },
            ],
          },

          fallbackProductSales: {
            $cond: [
              { $gt: [{ $subtract: ['$amountNum', '$shippingNum'] }, 0] },
              { $subtract: ['$amountNum', '$shippingNum'] },
              0,
            ],
          },
        },
      },
      {
        $addFields: {
          grossSalesOrderValue: {
            $cond: [
              { $gt: ['$itemGrossSubtotal', 0] },
              '$itemGrossSubtotal',
              '$fallbackProductSales',
            ],
          },
        },
      },
      {
        $addFields: {
          safeRefundForOrder: {
            $cond: [
              { $gt: ['$refundedTotalNum', '$grossSalesOrderValue'] },
              '$grossSalesOrderValue',
              '$refundedTotalNum',
            ],
          },
        },
      },
      {
        $addFields: {
          netFeeBase: {
            $cond: [
              '$shouldCount',
              {
                $max: [
                  0,
                  { $subtract: ['$grossSalesOrderValue', '$safeRefundForOrder'] },
                ],
              },
              0,
            ],
          },

          platformFeeAmount: {
            $cond: [
              '$shouldCount',
              {
                $multiply: [
                  {
                    $max: [
                      0,
                      { $subtract: ['$grossSalesOrderValue', '$safeRefundForOrder'] },
                    ],
                  },
                  { $divide: ['$safePlatformFeeBps', 10000] },
                ],
              },
              0,
            ],
          },
        },
      },
      {
        $group: {
          _id: null,

          platformFeesEarned: {
            $sum: '$platformFeeAmount',
          },

          feeBaseSales: {
            $sum: '$netFeeBase',
          },

          grossSales: {
            $sum: {
              $cond: ['$shouldCount', '$grossSalesOrderValue', 0],
            },
          },

          refundedTotal: {
            $sum: {
              $cond: ['$shouldCount', '$safeRefundForOrder', 0],
            },
          },

          ordersCounted: {
            $sum: {
              $cond: ['$shouldCount', 1, 0],
            },
          },

          feeBpsTotal: {
            $sum: {
              $cond: ['$shouldCount', '$safePlatformFeeBps', 0],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      platformFeesEarned: 0,
      feeBaseSales: 0,
      grossSales: 0,
      refundedTotal: 0,
      ordersCounted: 0,
      feeBpsTotal: 0,
    };

    const ordersCounted = Number(row.ordersCounted || 0);
    const averagePlatformFeeBps =
      ordersCounted > 0 ? Number(row.feeBpsTotal || 0) / ordersCounted : DEFAULT_PLATFORM_FEE_BPS;

    return res.json({
      ok: true,
      currency: BASE_CURRENCY,
      windowDays: 30,
      label: 'Platform Fees Earned',
      description: 'Your marketplace commission after refunds are removed.',
      platformFeesEarned: roundMoney(row.platformFeesEarned),
      feeBaseSales: roundMoney(row.feeBaseSales),
      grossSales: roundMoney(row.grossSales),
      refundedTotal: roundMoney(row.refundedTotal),
      ordersCounted,
      averagePlatformFeeBps: Math.round(averagePlatformFeeBps),
      averagePlatformFeePercent: roundMoney(averagePlatformFeeBps / 100),
    });
  } catch (err) {
    console.error('❌ admin platform fees metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Platform Fees Earned metric',
    });
  }
});

module.exports = router;