// routes/adminPayoutsPendingMetricApi.js
'use strict';

const express = require('express');

const requireAdmin = require('../middleware/requireAdmin');
const Business = require('../models/Business');
const Payout = require('../models/Payout');
const { getSellerAvailableCents } = require('../utils/payouts/getSellerAvailableCents');

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

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// GET /api/admin/payouts-pending-metric
router.get('/payouts-pending-metric', requireAdmin, async (req, res) => {
  try {
    const currency = getBaseCurrency();

    /**
     * PART 1:
     * Money sellers/suppliers have earned and are eligible to receive,
     * but no payout batch has been created yet.
     */
    const payoutBusinesses = await Business.find({
      role: { $in: ['seller', 'supplier'] },
      'payouts.enabled': true,
      'payouts.paypalEmail': { $exists: true, $ne: '' },
    })
      .select('_id name role payouts.enabled payouts.paypalEmail')
      .lean();

    let availablePendingCents = 0;
    let eligibleBusinesses = 0;

    for (const business of payoutBusinesses) {
      const paypalEmail = normEmail(business?.payouts?.paypalEmail);

      if (!paypalEmail) {
        continue;
      }

      const availableCents = await getSellerAvailableCents(business._id, currency);
      const safeAvailableCents = Math.max(0, Number(availableCents || 0));

      if (safeAvailableCents > 0) {
        eligibleBusinesses += 1;
        availablePendingCents += safeAvailableCents;
      }
    }

    /**
     * PART 2:
     * Money already placed inside payout batches,
     * but the payout item is still not SENT.
     *
     * We count only PENDING items inside CREATED / PROCESSING batches.
     * We do NOT count FAILED here because that will be its own metric later.
     */
    const processingRows = await Payout.aggregate([
      {
        $match: {
          status: { $in: ['CREATED', 'PROCESSING'] },
          currency,
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.status': 'PENDING',
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
        $group: {
          _id: null,
          processingPendingCents: {
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
          processingPendingItems: { $sum: 1 },
          processingBatches: { $addToSet: '$_id' },
        },
      },
      {
        $project: {
          _id: 0,
          processingPendingCents: 1,
          processingPendingItems: 1,
          processingBatchesCount: { $size: '$processingBatches' },
        },
      },
    ]).allowDiskUse(true);

    const processingRow = processingRows[0] || {
      processingPendingCents: 0,
      processingPendingItems: 0,
      processingBatchesCount: 0,
    };

    const processingPendingCents = Math.max(
      0,
      Number(processingRow.processingPendingCents || 0)
    );

    const totalPendingCents = availablePendingCents + processingPendingCents;

    return res.json({
      ok: true,
      currency,
      label: 'Payouts Pending',
      description: 'Money owed to sellers and suppliers but not fully paid yet.',

      payoutsPending: centsToAmount(totalPendingCents),

      availablePending: centsToAmount(availablePendingCents),
      processingPending: centsToAmount(processingPendingCents),

      eligibleBusinesses,
      payoutEnabledBusinesses: payoutBusinesses.length,

      processingPendingItems: Number(processingRow.processingPendingItems || 0),
      processingBatchesCount: Number(processingRow.processingBatchesCount || 0),
    });
  } catch (err) {
    console.error('❌ admin payouts pending metric error:', err);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load Payouts Pending metric',
    });
  }
});

module.exports = router;