// routes/adminRefundRateMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

const router = express.Router();

const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];
const REFUND_STATES = ['REFUNDED', 'PARTIALLY_REFUNDED', 'REFUND_SUBMITTED'];
const CANCEL_STATES = ['CANCELLED', 'CANCELED', 'VOIDED'];

function roundPercent(value) {
  return Number(Number(value || 0).toFixed(2));
}

// GET /api/admin/refund-rate-metric
router.get('/refund-rate-metric', requireAdmin, async (req, res) => {
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

          refundedTotalNum: {
            $convert: {
              input: { $ifNull: ['$refundedTotal', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          refundsArr: {
            $ifNull: ['$refunds', []],
          },
        },
      },
      {
        $addFields: {
          isCancelledLike: {
            $or: [
              { $in: ['$statusU', CANCEL_STATES] },
              { $in: ['$paymentStatusU', CANCEL_STATES] },
            ],
          },

          isPaidLike: {
            $or: [
              { $in: ['$statusU', PAID_STATES] },
              { $in: ['$paymentStatusU', PAID_STATES] },
              { $in: ['$statusU', REFUND_STATES] },
              { $in: ['$paymentStatusU', REFUND_STATES] },
              { $gt: ['$refundedTotalNum', 0] },
              { $gt: [{ $size: '$refundsArr' }, 0] },
            ],
          },

          isRefundedLike: {
            $or: [
              { $in: ['$statusU', REFUND_STATES] },
              { $in: ['$paymentStatusU', REFUND_STATES] },
              { $gt: ['$refundedTotalNum', 0] },
              { $gt: [{ $size: '$refundsArr' }, 0] },
            ],
          },
        },
      },
      {
        $addFields: {
          shouldCountAsPaidOrder: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isCancelledLike', false] },
            ],
          },

          shouldCountAsRefundedOrder: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isCancelledLike', false] },
              { $eq: ['$isRefundedLike', true] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,

          paidOrders: {
            $sum: {
              $cond: ['$shouldCountAsPaidOrder', 1, 0],
            },
          },

          refundedOrders: {
            $sum: {
              $cond: ['$shouldCountAsRefundedOrder', 1, 0],
            },
          },

          refundEvents: {
            $sum: {
              $cond: [
                '$shouldCountAsRefundedOrder',
                { $size: '$refundsArr' },
                0,
              ],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      paidOrders: 0,
      refundedOrders: 0,
      refundEvents: 0,
    };

    const paidOrders = Number(row.paidOrders || 0);
    const refundedOrders = Number(row.refundedOrders || 0);
    const refundEvents = Number(row.refundEvents || 0);

    const refundRate =
      paidOrders > 0 ? roundPercent((refundedOrders / paidOrders) * 100) : 0;

    return res.json({
      ok: true,
      windowDays: 30,
      label: 'Refund Rate',
      description: 'Refunded orders divided by paid orders.',
      refundRate,
      paidOrders,
      refundedOrders,
      refundEvents,
    });
  } catch (err) {
    console.error('❌ admin refund rate metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Refund Rate metric',
    });
  }
});

module.exports = router;

