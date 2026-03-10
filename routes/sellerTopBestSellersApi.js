// routes/sellerTopBestSellersApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
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

    const products = await Product.find({
      business: business._id,
      soldCount: { $gt: 0 },
    })
      .select('customId name imageUrl category price soldCount soldOrders')
      .sort({ soldCount: -1, soldOrders: -1, name: 1 })
      .limit(10)
      .lean();

    const normalizedProducts = products.map((product) => {
      const soldCount = Number(product?.soldCount || 0);
      const price = Number(product?.price || 0);

      return {
        _id: product?._id,
        customId: product?.customId || '',
        name: product?.name || 'Unnamed product',
        imageUrl: product?.imageUrl || '',
        category: product?.category || 'General',
        price,
        soldCount,
        soldOrders: Number(product?.soldOrders || 0),
        estRevenue: Number((soldCount * price).toFixed(2)),
      };
    });

    return res.json({
      ok: true,
      stats: {
        total: normalizedProducts.length,
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