// routes/adminOrdersNeedingLabelsMetricApi.js
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

// GET /api/admin/orders-needing-labels-metric
router.get('/orders-needing-labels-metric', requireAdmin, async (req, res) => {
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

          shippoTransactionId: {
            $trim: {
              input: {
                $ifNull: ['$shippo.transactionId', ''],
              },
            },
          },

          shippoLabelUrl: {
            $trim: {
              input: {
                $ifNull: ['$shippo.labelUrl', ''],
              },
            },
          },

          trackingLabelUrl: {
            $trim: {
              input: {
                $ifNull: ['$shippingTracking.labelUrl', ''],
              },
            },
          },

          trackingNumber: {
            $trim: {
              input: {
                $ifNull: ['$shippingTracking.trackingNumber', ''],
              },
            },
          },

          trackingUrl: {
            $trim: {
              input: {
                $ifNull: ['$shippingTracking.trackingUrl', ''],
              },
            },
          },

          payerRateId: {
            $trim: {
              input: {
                $ifNull: ['$shippo.payerRateId', ''],
              },
            },
          },

          payerShipmentId: {
            $trim: {
              input: {
                $ifNull: ['$shippo.payerShipmentId', ''],
              },
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

          hasShippoLabel: {
            $or: [
              { $gt: [{ $strLenCP: '$shippoTransactionId' }, 0] },
              { $gt: [{ $strLenCP: '$shippoLabelUrl' }, 0] },
              { $gt: [{ $strLenCP: '$trackingLabelUrl' }, 0] },
              { $gt: [{ $strLenCP: '$trackingNumber' }, 0] },
              { $gt: [{ $strLenCP: '$trackingUrl' }, 0] },
            ],
          },

          hasPayerShippoChoice: {
            $and: [
              { $gt: [{ $strLenCP: '$payerRateId' }, 0] },
              { $gt: [{ $strLenCP: '$payerShipmentId' }, 0] },
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
          shouldNeedLabel: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isRefundedLike', false] },
              { $eq: ['$isCancelledLike', false] },
              { $eq: ['$isFinishedFulfillment', false] },
              { $eq: ['$hasShippoLabel', false] },
            ],
          },

          shouldBeReadyForLabel: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isRefundedLike', false] },
              { $eq: ['$isCancelledLike', false] },
              { $eq: ['$isFinishedFulfillment', false] },
              { $eq: ['$hasShippoLabel', false] },
              { $eq: ['$hasPayerShippoChoice', true] },
            ],
          },

          shouldBeMissingPayerChoice: {
            $and: [
              { $eq: ['$isPaidLike', true] },
              { $eq: ['$isRefundedLike', false] },
              { $eq: ['$isCancelledLike', false] },
              { $eq: ['$isFinishedFulfillment', false] },
              { $eq: ['$hasShippoLabel', false] },
              { $eq: ['$hasPayerShippoChoice', false] },
            ],
          },
        },
      },
      {
        $group: {
          _id: null,

          ordersNeedingLabels: {
            $sum: {
              $cond: ['$shouldNeedLabel', 1, 0],
            },
          },

          readyForLabel: {
            $sum: {
              $cond: ['$shouldBeReadyForLabel', 1, 0],
            },
          },

          missingPayerChoice: {
            $sum: {
              $cond: ['$shouldBeMissingPayerChoice', 1, 0],
            },
          },

          ordersNeedingLabelsValue: {
            $sum: {
              $cond: ['$shouldNeedLabel', '$amountNum', 0],
            },
          },

          itemsNeedingLabels: {
            $sum: {
              $cond: ['$shouldNeedLabel', '$itemCount', 0],
            },
          },
        },
      },
    ]).allowDiskUse(true);

    const row = result[0] || {
      ordersNeedingLabels: 0,
      readyForLabel: 0,
      missingPayerChoice: 0,
      ordersNeedingLabelsValue: 0,
      itemsNeedingLabels: 0,
    };

    return res.json({
      ok: true,
      currency: BASE_CURRENCY,
      windowDays: 30,
      label: 'Orders Needing Labels',
      description: 'Paid orders that still need Shippo labels.',

      ordersNeedingLabels: Number(row.ordersNeedingLabels || 0),
      readyForLabel: Number(row.readyForLabel || 0),
      missingPayerChoice: Number(row.missingPayerChoice || 0),
      ordersNeedingLabelsValue: roundMoney(row.ordersNeedingLabelsValue),
      itemsNeedingLabels: Number(row.itemsNeedingLabels || 0),
    });
  } catch (err) {
    console.error('❌ admin orders needing labels metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Orders Needing Labels metric',
    });
  }
});

module.exports = router;

