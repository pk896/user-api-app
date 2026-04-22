// routes/sellerPendingStatsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

const Business = require('../models/Business');
const Payout = require('../models/Payout');
const SellerBalanceLedger = require('../models/SellerBalanceLedger');

const router = express.Router();

function getBaseCurrency() {
  return (
    String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
    'USD'
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

router.get('/pending-stats', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const sessionBusiness = req.business || req.session?.business || null;

    if (!sessionBusiness?._id) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      });
    }

    if (sessionBusiness.role !== 'seller') {
      return res.status(403).json({
        ok: false,
        message: 'Sellers only',
      });
    }

    if (!mongoose.isValidObjectId(sessionBusiness._id)) {
      return res.status(400).json({
        ok: false,
        message: 'Invalid business id',
      });
    }

    const business = await Business.findById(sessionBusiness._id)
      .select('_id role isVerified')
      .lean();

    if (!business) {
      return res.status(404).json({
        ok: false,
        message: 'Business not found',
      });
    }

    if (business.role !== 'seller') {
      return res.status(403).json({
        ok: false,
        message: 'Sellers only',
      });
    }

    if (!business.isVerified) {
      return res.status(403).json({
        ok: false,
        message: 'Business must be verified',
      });
    }

    const currency = String(getBaseCurrency()).toUpperCase();
    const businessObjectId = new mongoose.Types.ObjectId(String(business._id));

    /**
     * 1) Current pending payout items for this seller
     *    This is what your admin payouts page is showing.
     */
    const pendingItems = await Payout.aggregate([
      {
        $match: {
          'items.businessId': businessObjectId,
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.businessId': businessObjectId,
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
        $project: {
          _id: 0,
          payoutId: '$_id',
          amountCents: {
            $max: [0, { $toInt: { $ifNull: ['$items.amountCents', 0] } }],
          },
          effectivePendingAt: {
            $ifNull: ['$createdAt', '$updatedAt'],
          },
        },
      },
      {
        $match: {
          effectivePendingAt: { $type: 'date' },
        },
      },
      { $sort: { effectivePendingAt: -1, payoutId: -1 } },
    ]);

    const pendingEarningsCents = pendingItems.reduce((sum, row) => {
      return sum + Math.max(0, Number(row.amountCents || 0));
    }, 0);

    /**
     * 2) Refunded amount = latest REFUND_DEBIT only
     *    Do NOT sum all historical refunds.
     */
    const latestRefundRow = await SellerBalanceLedger.findOne({
      businessId: businessObjectId,
      currency: currency,
      type: 'REFUND_DEBIT',
    })
      .sort({ createdAt: -1, _id: -1 })
      .select('amountCents createdAt')
      .lean();

    const refundedCents = latestRefundRow
      ? Math.max(0, Math.abs(Number(latestRefundRow.amountCents || 0)))
      : 0;

    /**
     * 3) Chart = last 7 calendar days ending today
     *    Show only movement of pending payout items.
     */
    const todayEnd = endOfDay(new Date());
    const chartStart = startOfDay(
      new Date(
        todayEnd.getFullYear(),
        todayEnd.getMonth(),
        todayEnd.getDate() - 6
      )
    );

    const chartLabels = [];
    const chartDataCents = [];

    for (let i = 0; i < 7; i += 1) {
      const day = new Date(chartStart);
      day.setDate(chartStart.getDate() + i);

      const dayStart = startOfDay(day);
      const dayEnd = endOfDay(day);

      const dayPendingCents = pendingItems.reduce((sum, row) => {
        const t = new Date(row.effectivePendingAt).getTime();

        if (t >= dayStart.getTime() && t <= dayEnd.getTime()) {
          return sum + Math.max(0, Number(row.amountCents || 0));
        }

        return sum;
      }, 0);

      chartLabels.push(
        dayStart.toLocaleDateString('en-US', { weekday: 'short' })
      );
      chartDataCents.push(dayPendingCents);
    }

    return res.json({
      ok: true,
      stats: {
        pendingEarnings: centsToAmount(pendingEarningsCents),
        refundedAmount: centsToAmount(refundedCents),
        currency: currency,
      },
      chart: {
        labels: chartLabels,
        data: chartDataCents.map(centsToAmount),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ seller pending stats api error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load seller pending stats',
    });
  }
});

module.exports = router;