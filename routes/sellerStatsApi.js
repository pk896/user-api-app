// routes/sellerStatsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Business = require('../models/Business');
const Product = require('../models/Product');
const ProductStockHistory = require('../models/ProductStockHistory');
const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

const router = express.Router();

/**
 * GET /api/seller/stats
 * Returns:
 * - totalProducts
 * - totalStock
 * - chart data using REAL stock movement from ProductStockHistory
 */
router.get('/stats', requireBusiness, requireVerifiedBusiness, async (req, res) => {
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

    const products = await Product.find({ business: business._id })
      .select('_id stock')
      .lean();

    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);

    // Last 7 days stock movement
    const today = new Date();
    today.setHours(23, 59, 59, 999);

    const start = new Date();
    start.setDate(start.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    const historyRows = await ProductStockHistory.find({
      business: business._id,
      createdAt: { $gte: start, $lte: today },
    })
      .select('delta createdAt')
      .sort({ createdAt: 1 })
      .lean();

    const chartLabels = [];
    const chartData = [];

    for (let i = 0; i < 7; i++) {
      const dayStart = new Date(start);
      dayStart.setDate(start.getDate() + i);
      dayStart.setHours(0, 0, 0, 0);

      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);

      const dayDelta = historyRows
        .filter((row) => {
          const t = new Date(row.createdAt).getTime();
          return t >= dayStart.getTime() && t <= dayEnd.getTime();
        })
        .reduce((sum, row) => sum + (Number(row.delta) || 0), 0);

      chartLabels.push(
        dayStart.toLocaleDateString('en-US', { weekday: 'short' })
      );
      chartData.push(dayDelta);
    }

    return res.json({
      ok: true,
      stats: {
        totalProducts,
        totalStock,
      },
      chart: {
        labels: chartLabels,
        data: chartData,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('❌ seller stats api error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load seller stats',
    });
  }
});

module.exports = router;