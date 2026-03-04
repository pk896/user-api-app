// routes/adminOrdersStatsApi.js
'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

const router = express.Router();

// Treat these as "paid-like" orders for revenue stats
const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'];

// Fulfillment states that are "pending work" (paid but not finished)
const PENDING_FULFILLMENT = ['PENDING', 'PAID', 'PACKING', 'LABEL_CREATED'];

/**
 * GET /api/admin/stats/orders
 * Returns:
 * - totalOrders
 * - pendingOrders (paid-like + fulfillmentStatus in pending)
 * - totalPaid (sum of amount.value for paid-like orders)
 * - refundedOrders (orders with status REFUNDED/PARTIALLY_REFUNDED or refunds array)
 * - refundsCount (total refund events across orders)
 * - refundedTotal (sum of refundedTotal field)
 * - chargebacksCount (best-effort by status/paymentStatus containing dispute/chargeback)
 */
router.get('/stats/orders', requireAdmin, async (req, res) => {
  try {
    // 1) Total orders (fast count)
    const totalOrdersPromise = Order.countDocuments({});

    // 2) Aggregate money + refunds + pending + chargebacks
    const agg = await Order.aggregate([
      {
        $project: {
          statusU: { $toUpper: { $ifNull: ['$status', ''] } },
          paymentStatusU: { $toUpper: { $ifNull: ['$paymentStatus', ''] } },
          fulfillmentU: { $toUpper: { $ifNull: ['$fulfillmentStatus', ''] } },

          // amount.value stored as string -> convert to double safely
          amountNum: {
            $convert: {
              input: { $ifNull: ['$amount.value', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          // refundedTotal stored as string -> convert to double safely
          refundedTotalNum: {
            $convert: {
              input: { $ifNull: ['$refundedTotal', '0'] },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },

          refundsArr: { $ifNull: ['$refunds', []] },
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
              { $in: ['$statusU', ['REFUNDED', 'PARTIALLY_REFUNDED']] },
              { $gt: [{ $size: '$refundsArr' }, 0] },
              { $gt: ['$refundedTotalNum', 0] },
            ],
          },
          isPendingFulfillment: {
            $and: [
              {
                $or: [
                  { $in: ['$statusU', PAID_STATES] },
                  { $in: ['$paymentStatusU', PAID_STATES] },
                ],
              },
              { $in: ['$fulfillmentU', PENDING_FULFILLMENT] },
            ],
          },
          isChargebackLike: {
            $or: [
              {
                $regexMatch: {
                  input: '$statusU',
                  regex: /(CHARGEBACK|DISPUTE|CLAIM)/,
                },
              },
              {
                $regexMatch: {
                  input: '$paymentStatusU',
                  regex: /(CHARGEBACK|DISPUTE|CLAIM)/,
                },
              },
            ],
          },
          refundsCountDoc: { $size: '$refundsArr' },
        },
      },
      {
        $group: {
          _id: null,
          totalPaid: {
            $sum: {
              $cond: ['$isPaidLike', '$amountNum', 0],
            },
          },
          pendingOrders: {
            $sum: { $cond: ['$isPendingFulfillment', 1, 0] },
          },
          refundedOrders: {
            $sum: { $cond: ['$isRefundedLike', 1, 0] },
          },
          refundsCount: { $sum: '$refundsCountDoc' },
          refundedTotal: { $sum: '$refundedTotalNum' },
          chargebacksCount: { $sum: { $cond: ['$isChargebackLike', 1, 0] } },
        },
      },
    ]);

    const totalOrders = await totalOrdersPromise;

    const row = agg[0] || {
      totalPaid: 0,
      pendingOrders: 0,
      refundedOrders: 0,
      refundsCount: 0,
      refundedTotal: 0,
      chargebacksCount: 0,
    };

    return res.json({
      ok: true,
      totalOrders: Number(totalOrders || 0),

      pendingOrders: Number(row.pendingOrders || 0),

      // “Revenue / total paid” (gross captured)
      totalPaid: Number(Number(row.totalPaid || 0).toFixed(2)),

      // Refund stats
      refundedOrders: Number(row.refundedOrders || 0),
      refundsCount: Number(row.refundsCount || 0),
      refundedTotal: Number(Number(row.refundedTotal || 0).toFixed(2)),

      // Best-effort dispute/chargeback detection
      chargebacksCount: Number(row.chargebacksCount || 0),
    });
  } catch (err) {
    console.error('❌ admin orders stats error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load orders stats' });
  }
});

module.exports = router;