// routes/sellerFastestGrowingProductsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const SellerProductDailyStat = require('../models/SellerProductDailyStat');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
}

function buildUtcDayKey(offsetDays = 0) {
  const base = new Date();

  const d = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())
  );

  d.setUTCDate(d.getUTCDate() + offsetDays);

  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function buildDayKeyRange(startOffset, endOffset) {
  const keys = [];

  for (let i = startOffset; i <= endOffset; i += 1) {
    keys.push(buildUtcDayKey(i));
  }

  return keys;
}

function calculateGrowthPercent(currentQty, previousQty) {
  const current = Number(currentQty || 0);
  const previous = Number(previousQty || 0);

  if (previous > 0) {
    return Number((((current - previous) / previous) * 100).toFixed(1));
  }

  if (previous === 0 && current > 0) {
    return 100;
  }

  return 0;
}

// GET /api/seller/fastest-growing-products
router.get('/fastest-growing-products', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business?._id || !mongoose.isValidObjectId(business._id)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      });
    }

    if (String(business.role || '').trim() !== 'seller') {
      return res.status(403).json({
        ok: false,
        message: 'Sellers only',
      });
    }

    const businessId = new mongoose.Types.ObjectId(business._id);

    // ✅ Weekly comparison
    // current week: last 7 days including today
    // previous week: 7 days before that
    const current7DayKeys = buildDayKeyRange(-6, 0);
    const previous7DayKeys = buildDayKeyRange(-13, -7);

    // ✅ Monthly comparison
    // current month window: last 30 days including today
    // previous month window: 30 days before that
    const current30DayKeys = buildDayKeyRange(-29, 0);
    const previous30DayKeys = buildDayKeyRange(-59, -30);

    const allNeededDayKeys = [
      ...new Set([
        ...current7DayKeys,
        ...previous7DayKeys,
        ...current30DayKeys,
        ...previous30DayKeys,
      ]),
    ];

    const stats = await SellerProductDailyStat.aggregate([
      {
        $match: {
          business: businessId,
          dayKey: { $in: allNeededDayKeys },
        },
      },
      {
        $group: {
          _id: '$productCustomId',

          currentWeeklySold: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current7DayKeys] }, '$soldCount', 0],
            },
          },
          previousWeeklySold: {
            $sum: {
              $cond: [{ $in: ['$dayKey', previous7DayKeys] }, '$soldCount', 0],
            },
          },

          currentMonthlySold: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current30DayKeys] }, '$soldCount', 0],
            },
          },
          previousMonthlySold: {
            $sum: {
              $cond: [{ $in: ['$dayKey', previous30DayKeys] }, '$soldCount', 0],
            },
          },

          currentWeeklyRevenue: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current7DayKeys] }, '$revenue', 0],
            },
          },
          previousWeeklyRevenue: {
            $sum: {
              $cond: [{ $in: ['$dayKey', previous7DayKeys] }, '$revenue', 0],
            },
          },

          currentMonthlyRevenue: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current30DayKeys] }, '$revenue', 0],
            },
          },
          previousMonthlyRevenue: {
            $sum: {
              $cond: [{ $in: ['$dayKey', previous30DayKeys] }, '$revenue', 0],
            },
          },

          currentWeeklyOrders: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current7DayKeys] }, '$soldOrders', 0],
            },
          },
          currentMonthlyOrders: {
            $sum: {
              $cond: [{ $in: ['$dayKey', current30DayKeys] }, '$soldOrders', 0],
            },
          },

          productName: { $last: '$productName' },
        },
      },
    ]);

    const merged = stats
      .map((row) => {
        const customId = String(row._id || '').trim();

        const currentWeeklySold = Number(row.currentWeeklySold || 0);
        const previousWeeklySold = Number(row.previousWeeklySold || 0);

        const currentMonthlySold = Number(row.currentMonthlySold || 0);
        const previousMonthlySold = Number(row.previousMonthlySold || 0);

        const weeklyGrowthCount = currentWeeklySold - previousWeeklySold;
        const monthlyGrowthCount = currentMonthlySold - previousMonthlySold;

        const weeklyGrowthPercent = calculateGrowthPercent(
          currentWeeklySold,
          previousWeeklySold
        );

        const monthlyGrowthPercent = calculateGrowthPercent(
          currentMonthlySold,
          previousMonthlySold
        );

        const currentWeeklyRevenue = Number(row.currentWeeklyRevenue || 0);
        const previousWeeklyRevenue = Number(row.previousWeeklyRevenue || 0);

        const currentMonthlyRevenue = Number(row.currentMonthlyRevenue || 0);
        const previousMonthlyRevenue = Number(row.previousMonthlyRevenue || 0);

        return {
          customId,
          name: row.productName || 'Unnamed product',

          currentWeeklySold,
          previousWeeklySold,
          weeklyGrowthCount,
          weeklyGrowthPercent,

          currentMonthlySold,
          previousMonthlySold,
          monthlyGrowthCount,
          monthlyGrowthPercent,

          currentWeeklyRevenue: Number(currentWeeklyRevenue.toFixed(2)),
          previousWeeklyRevenue: Number(previousWeeklyRevenue.toFixed(2)),
          weeklyRevenueGrowth: Number(
            (currentWeeklyRevenue - previousWeeklyRevenue).toFixed(2)
          ),

          currentMonthlyRevenue: Number(currentMonthlyRevenue.toFixed(2)),
          previousMonthlyRevenue: Number(previousMonthlyRevenue.toFixed(2)),
          monthlyRevenueGrowth: Number(
            (currentMonthlyRevenue - previousMonthlyRevenue).toFixed(2)
          ),

          currentWeeklyOrders: Number(row.currentWeeklyOrders || 0),
          currentMonthlyOrders: Number(row.currentMonthlyOrders || 0),

          // ✅ Backward-safe old names
          currentSoldCount: currentWeeklySold,
          previousSoldCount: previousWeeklySold,
          growthCount: weeklyGrowthCount,
          growthPercent: weeklyGrowthPercent,
          growthRevenue: Number((currentWeeklyRevenue - previousWeeklyRevenue).toFixed(2)),
        };
      })
      .filter((item) => {
        if (!item.customId) return false;

        // ✅ Only show products that have real current activity and positive growth.
        return (
          (item.currentWeeklySold > 0 && item.weeklyGrowthCount > 0) ||
          (item.currentMonthlySold > 0 && item.monthlyGrowthCount > 0)
        );
      })
      .sort((a, b) => {
        if (b.weeklyGrowthPercent !== a.weeklyGrowthPercent) {
          return b.weeklyGrowthPercent - a.weeklyGrowthPercent;
        }

        if (b.monthlyGrowthPercent !== a.monthlyGrowthPercent) {
          return b.monthlyGrowthPercent - a.monthlyGrowthPercent;
        }

        if (b.weeklyGrowthCount !== a.weeklyGrowthCount) {
          return b.weeklyGrowthCount - a.weeklyGrowthCount;
        }

        if (b.monthlyGrowthCount !== a.monthlyGrowthCount) {
          return b.monthlyGrowthCount - a.monthlyGrowthCount;
        }

        return a.name.localeCompare(b.name);
      })
      .slice(0, 10);

    const customIds = merged.map((item) => item.customId).filter(Boolean);

    const products = await Product.find({
      business: businessId,
      customId: { $in: customIds },
    })
      .select('customId name imageUrl category price')
      .lean();

    const productsByCustomId = new Map(
      products.map((product) => [String(product.customId), product])
    );

    const normalizedProducts = merged.map((item) => {
      const product = productsByCustomId.get(item.customId);

      return {
        customId: item.customId,
        name: product?.name || item.name || 'Unnamed product',
        imageUrl: product?.imageUrl || '',
        category: product?.category || 'General',
        price: Number(product?.price || 0),

        currentWeeklySold: item.currentWeeklySold,
        previousWeeklySold: item.previousWeeklySold,
        weeklyGrowthCount: item.weeklyGrowthCount,
        weeklyGrowthPercent: item.weeklyGrowthPercent,

        currentMonthlySold: item.currentMonthlySold,
        previousMonthlySold: item.previousMonthlySold,
        monthlyGrowthCount: item.monthlyGrowthCount,
        monthlyGrowthPercent: item.monthlyGrowthPercent,

        currentWeeklyRevenue: item.currentWeeklyRevenue,
        previousWeeklyRevenue: item.previousWeeklyRevenue,
        weeklyRevenueGrowth: item.weeklyRevenueGrowth,

        currentMonthlyRevenue: item.currentMonthlyRevenue,
        previousMonthlyRevenue: item.previousMonthlyRevenue,
        monthlyRevenueGrowth: item.monthlyRevenueGrowth,

        currentWeeklyOrders: item.currentWeeklyOrders,
        currentMonthlyOrders: item.currentMonthlyOrders,

        // ✅ Backward-safe old names
        currentSoldCount: item.currentSoldCount,
        previousSoldCount: item.previousSoldCount,
        growthCount: item.growthCount,
        growthRevenue: item.growthRevenue,
        growthPercent: item.growthPercent,
      };
    });

    return res.json({
      ok: true,
      currency:
        String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD',
      stats: {
        total: normalizedProducts.length,
        weeklyRangeLabel: 'Last 7 days vs previous 7 days',
        monthlyRangeLabel: 'Last 30 days vs previous 30 days',
      },
      products: normalizedProducts,
    });
  } catch (error) {
    console.error('❌ seller fastest growing products api error:', error);

    return res.status(500).json({
      ok: false,
      message: 'Failed to load fastest growing products',
    });
  }
});

module.exports = router;