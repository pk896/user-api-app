// routes/adminNetRevenueMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';

const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const REFUND_STATES = ['REFUNDED', 'PARTIALLY_REFUNDED'];
const CANCEL_STATES = ['CANCELLED', 'CANCELED', 'VOIDED'];

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

// GET /api/admin/net-revenue-metric
router.get('/net-revenue-metric', requireAdmin, async (req, res) => {
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
        $group: {
          _id: null,

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

          netRevenueOrders: {
            $sum: {
              $cond: ['$shouldCount', 1, 0],
            },
          },

          refundedOrders: {
            $sum: {
              $cond: [
                {
                  $and: [
                    '$shouldCount',
                    { $gt: ['$safeRefundForOrder', 0] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      grossSales: 0,
      refundedTotal: 0,
      netRevenueOrders: 0,
      refundedOrders: 0,
    };

    const grossSales = roundMoney(row.grossSales);
    const refundedTotal = roundMoney(row.refundedTotal);
    const netRevenue = roundMoney(Math.max(0, grossSales - refundedTotal));

    const refundImpactPercent =
      grossSales > 0 ? roundMoney((refundedTotal / grossSales) * 100) : 0;

    return res.json({
      ok: true,
      currency: BASE_CURRENCY,
      windowDays: 30,
      label: 'Net Revenue',
      description: 'Gross product sales minus refunds.',
      grossSales,
      refundedTotal,
      netRevenue,
      netRevenueOrders: Number(row.netRevenueOrders || 0),
      refundedOrders: Number(row.refundedOrders || 0),
      refundImpactPercent,
    });
  } catch (err) {
    console.error('❌ admin net revenue metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Net Revenue metric',
    });
  }
});

module.exports = router;

