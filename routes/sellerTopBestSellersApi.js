// routes/sellerTopBestSellersApi.js
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

function buildLast30DayKeys() {
  const keys = [];
  const now = new Date();

  for (let i = 0; i < 30; i += 1) {
    const d = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate()
    ));

    d.setUTCDate(d.getUTCDate() - i);

    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');

    keys.push(`${year}-${month}-${day}`);
  }

  return keys;
}

// GET /api/seller/top-best-sellers
router.get('/top-best-sellers', requireBusiness, async (req, res) => {
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

    const dayKeys = buildLast30DayKeys();

    const stats = await SellerProductDailyStat.aggregate([
      {
        $match: {
          business: new mongoose.Types.ObjectId(business._id),
          dayKey: { $in: dayKeys },
        }
      },
      {
        $group: {
          _id: '$productCustomId',
          soldCount: { $sum: '$soldCount' },
          soldOrders: { $sum: '$soldOrders' },
          revenue: { $sum: '$revenue' },
          productName: { $last: '$productName' },
          productId: { $last: '$product' },
        }
      },
      {
        $match: {
          soldCount: { $gt: 0 },
        }
      },
      {
        $sort: {
          soldCount: -1,
          soldOrders: -1,
          revenue: -1,
          productName: 1,
        }
      },
      {
        $limit: 10,
      }
    ]);

    const customIds = stats.map((item) => item._id).filter(Boolean);

    const products = await Product.find({
      business: business._id,
      customId: { $in: customIds },
    })
      .select('customId name imageUrl category price')
      .lean();

    const productsByCustomId = new Map(
      products.map((product) => [String(product.customId), product])
    );

    const normalizedProducts = stats.map((stat) => {
      const product = productsByCustomId.get(String(stat._id));

      return {
        customId: String(stat._id || ''),
        name: product?.name || stat?.productName || 'Unnamed product',
        imageUrl: product?.imageUrl || '',
        category: product?.category || 'General',
        price: Number(product?.price || 0),
        soldCount: Number(stat?.soldCount || 0),
        soldOrders: Number(stat?.soldOrders || 0),
        estRevenue: Number(Number(stat?.revenue || 0).toFixed(2)),
      };
    });

    return res.json({
      ok: true,
      stats: {
        total: normalizedProducts.length,
        rangeLabel: 'Last 30 days',
      },
      products: normalizedProducts,
    });
  } catch (error) {
    console.error('❌ seller top best sellers api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load top best sellers',
    });
  }
});

module.exports = router;