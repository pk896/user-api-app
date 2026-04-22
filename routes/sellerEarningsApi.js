// routes/sellerEarningsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

const Business = require('../models/Business');
const Payout = require('../models/Payout');
const { getSellerAvailableCents } = require('../utils/payouts/getSellerAvailableCents');

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

router.get('/earnings', requireBusiness, requireVerifiedBusiness, async (req, res) => {
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
    const eligibilityCents = await getSellerAvailableCents(business._id, currency);

    // Latest actually paid-out items for this seller only.
    // IMPORTANT:
    // Some of your payout items do not persist items.paidAt,
    // so we fallback to updatedAt/meta.lastSyncAt/createdAt.
    const paidItems = await Payout.aggregate([
      {
        $match: {
          'items.businessId': businessObjectId,
        },
      },
      { $unwind: '$items' },
      {
        $match: {
          'items.businessId': businessObjectId,
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
        $project: {
          _id: 0,
          payoutId: '$_id',
          amountCents: {
            $max: [0, { $toInt: { $ifNull: ['$items.amountCents', 0] } }],
          },
          effectivePaidAt: 1,
        },
      },
      {
        $match: {
          effectivePaidAt: { $type: 'date' },
        },
      },
      { $sort: { effectivePaidAt: -1, payoutId: -1 } },
    ]);

    // Top number = latest SENT payout amount
    const latestPaidItem = paidItems[0] || null;
    const recentPaidAmountCents = latestPaidItem
      ? Math.max(0, Number(latestPaidItem.amountCents || 0))
      : 0;

    // Chart = last 7 calendar days ending today
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

      const dayPaidCents = paidItems.reduce((sum, row) => {
        const paidAt = new Date(row.effectivePaidAt);
        const t = paidAt.getTime();

        if (t >= dayStart.getTime() && t <= dayEnd.getTime()) {
          return sum + Math.max(0, Number(row.amountCents || 0));
        }

        return sum;
      }, 0);

      chartLabels.push(
        dayStart.toLocaleDateString('en-US', { weekday: 'short' })
      );
      chartDataCents.push(dayPaidCents);
    }

    return res.json({
      ok: true,
      stats: {
        paidEarnings: centsToAmount(recentPaidAmountCents),
        eligibility: centsToAmount(eligibilityCents),
        currency: currency,
      },
      chart: {
        labels: chartLabels,
        data: chartDataCents.map(centsToAmount),
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ seller earnings api error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load seller earnings',
    });
  }
});

module.exports = router;