// routes/adminAverageOrderValueMetricApi.js
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

// GET /api/admin/average-order-value-metric
router.get('/average-order-value-metric', requireAdmin, async (req, res) => {
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

          itemCount: {
            $sum: {
              $cond: [{ $gt: ['$itemQty', 0] }, '$itemQty', 0],
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
          orderProductValue: {
            $cond: [
              { $gt: ['$itemGrossSubtotal', 0] },
              '$itemGrossSubtotal',
              '$fallbackProductSales',
            ],
          },
        },
      },
      {
        $group: {
          _id: null,

          totalPaidProductSales: {
            $sum: {
              $cond: ['$shouldCount', '$orderProductValue', 0],
            },
          },

          paidOrders: {
            $sum: {
              $cond: ['$shouldCount', 1, 0],
            },
          },

          totalItemsSold: {
            $sum: {
              $cond: ['$shouldCount', '$itemCount', 0],
            },
          },

          highestOrderValue: {
            $max: {
              $cond: ['$shouldCount', '$orderProductValue', 0],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      totalPaidProductSales: 0,
      paidOrders: 0,
      totalItemsSold: 0,
      highestOrderValue: 0,
    };

    const totalPaidProductSales = roundMoney(row.totalPaidProductSales);
    const paidOrders = Number(row.paidOrders || 0);

    const averageOrderValue =
      paidOrders > 0 ? roundMoney(totalPaidProductSales / paidOrders) : 0;

    return res.json({
      ok: true,
      currency: BASE_CURRENCY,
      windowDays: 30,
      label: 'Average Order Value',
      description: 'Total paid product sales divided by paid orders.',

      averageOrderValue,
      totalPaidProductSales,
      paidOrders,
      totalItemsSold: Number(row.totalItemsSold || 0),
      highestOrderValue: roundMoney(row.highestOrderValue),
    });
  } catch (err) {
    console.error('❌ admin average order value metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Average Order Value metric',
    });
  }
});

module.exports = router;