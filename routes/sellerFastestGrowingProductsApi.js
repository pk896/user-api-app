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
  const d = new Date(Date.UTC(
    base.getUTCFullYear(),
    base.getUTCMonth(),
    base.getUTCDate()
  ));

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

    const current7DayKeys = buildDayKeyRange(-6, 0);
    const previous7DayKeys = buildDayKeyRange(-13, -7);

    const currentStats = await SellerProductDailyStat.aggregate([
      {
        $match: {
          business: businessId,
          dayKey: { $in: current7DayKeys },
        }
      },
      {
        $group: {
          _id: '$productCustomId',
          currentSoldCount: { $sum: '$soldCount' },
          currentRevenue: { $sum: '$revenue' },
          currentSoldOrders: { $sum: '$soldOrders' },
          productName: { $last: '$productName' },
        }
      }
    ]);

    const previousStats = await SellerProductDailyStat.aggregate([
      {
        $match: {
          business: businessId,
          dayKey: { $in: previous7DayKeys },
        }
      },
      {
        $group: {
          _id: '$productCustomId',
          previousSoldCount: { $sum: '$soldCount' },
          previousRevenue: { $sum: '$revenue' },
          previousSoldOrders: { $sum: '$soldOrders' },
        }
      }
    ]);

    const previousByCustomId = new Map(
      previousStats.map((item) => [String(item._id), item])
    );

    const merged = currentStats
      .map((currentItem) => {
        const customId = String(currentItem._id || '');
        const previousItem = previousByCustomId.get(customId);

        const currentSoldCount = Number(currentItem?.currentSoldCount || 0);
        const previousSoldCount = Number(previousItem?.previousSoldCount || 0);
        const currentRevenue = Number(currentItem?.currentRevenue || 0);
        const previousRevenue = Number(previousItem?.previousRevenue || 0);

        const growthCount = currentSoldCount - previousSoldCount;
        const growthRevenue = Number((currentRevenue - previousRevenue).toFixed(2));

        let growthPercent = null;

        if (previousSoldCount > 0) {
        growthPercent = Number((((currentSoldCount - previousSoldCount) / previousSoldCount) * 100).toFixed(2));
        }

        return {
          customId,
          name: currentItem?.productName || 'Unnamed product',
          currentSoldCount,
          previousSoldCount,
          currentRevenue: Number(currentRevenue.toFixed(2)),
          previousRevenue: Number(previousRevenue.toFixed(2)),
          growthCount,
          growthRevenue,
          growthPercent,
          currentSoldOrders: Number(currentItem?.currentSoldOrders || 0),
          previousSoldOrders: Number(previousItem?.previousSoldOrders || 0),
        };
      })
      .filter((item) => item.currentSoldCount > 0 && item.growthCount > 0)
      .sort((a, b) => {
        if (b.growthCount !== a.growthCount) return b.growthCount - a.growthCount;
        if (b.growthRevenue !== a.growthRevenue) return b.growthRevenue - a.growthRevenue;
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

        currentSoldCount: item.currentSoldCount,
        previousSoldCount: item.previousSoldCount,
        currentRevenue: item.currentRevenue,
        previousRevenue: item.previousRevenue,
        growthCount: item.growthCount,
        growthRevenue: item.growthRevenue,
        growthPercent: item.growthPercent,
      };
    });

    return res.json({
      ok: true,
      currency:
        String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
        'USD',
      stats: {
        total: normalizedProducts.length,
        currentRangeLabel: 'Last 7 days',
        previousRangeLabel: 'Previous 7 days',
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
