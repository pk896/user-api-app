// routes/adminPendingOrdersMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';

const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const REFUND_STATES = ['REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_SUBMITTED'];
const CANCEL_STATES = ['CANCELLED', 'CANCELED', 'VOIDED'];

const PENDING_FULFILLMENT_STATES = [
  '',
  'PENDING',
  'PAID',
  'PROCESSING',
  'PACKING',
  'LABEL_CREATED',
];

const FINISHED_FULFILLMENT_STATES = [
  'SHIPPED',
  'IN_TRANSIT',
  'DELIVERED',
  'CANCELLED',
  'CANCELED',
];

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

// GET /api/admin/pending-orders-metric
router.get('/pending-orders-metric', requireAdmin, async (req, res) => {
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

          fulfillmentStatusU: {
            $toUpper: {
              $ifNull: ['$fulfillmentStatus', ''],
            },
          },

          trackingStatusU: {
            $toUpper: {
              $ifNull: ['$shippingTracking.status', ''],
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

          itemsArr: {
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
            ],
          },

          isRefundedLike: {
            $or: [
              { $in: ['$statusU', REFUND_STATES] },
              { $in: ['$paymentStatusU', REFUND_STATES] },
            ],
          },

          isCancelledLike: {
            $or: [
              { $in: ['$statusU', CANCEL_STATES] },
              { $in: ['$paymentStatusU', CANCEL_STATES] },
              { $in: ['$fulfillmentStatusU', CANCEL_STATES] },
              { $in: ['$trackingStatusU', CANCEL_STATES] },
            ],
          },

          isFinishedFulfillment: {
            $or: [
              { $in: ['$fulfillmentStatusU', FINISHED_FULFILLMENT_STATES] },
              { $in: ['$trackingStatusU', FINISHED_FULFILLMENT_STATES] },
            ],
          },

          isPendingFulfillment: {
            $or: [
              { $in: ['$fulfillmentStatusU', PENDING_FULFILLMENT_STATES] },
              { $eq: ['$fulfillmentStatusU', ''] },
            ],
          },

          itemCount: {
            $sum: {
              $map: {
                input: '$itemsArr',
                as: 'item',
                in: {
                  $convert: {
                    input: { $ifNull: ['$$item.quantity', 0] },
                    to: 'double',
                    onError: 0,
                    onNull: 0,
                  },
                },
              },
            },
          },
        },
      },
      {
        $addFields: {
          shouldCountAsPendingOrder: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isRefundedLike', false] },
              { $eq: ['$isCancelledLike', false] },
              { $eq: ['$isFinishedFulfillment', false] },
              { $eq: ['$isPendingFulfillment', true] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,

          pendingOrders: {
            $sum: {
              $cond: ['$shouldCountAsPendingOrder', 1, 0],
            },
          },

          pendingOrdersValue: {
            $sum: {
              $cond: ['$shouldCountAsPendingOrder', '$amountNum', 0],
            },
          },

          pendingItems: {
            $sum: {
              $cond: ['$shouldCountAsPendingOrder', '$itemCount', 0],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      pendingOrders: 0,
      pendingOrdersValue: 0,
      pendingItems: 0,
    };

    return res.json({
      ok: true,
      currency: BASE_CURRENCY,
      windowDays: 30,
      label: 'Pending Orders',
      description: 'Paid orders that still need fulfillment work.',

      pendingOrders: Number(row.pendingOrders || 0),
      pendingOrdersValue: roundMoney(row.pendingOrdersValue),
      pendingItems: Number(row.pendingItems || 0),
    });
  } catch (err) {
    console.error('❌ admin pending orders metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Pending Orders metric',
    });
  }
});

module.exports = router;