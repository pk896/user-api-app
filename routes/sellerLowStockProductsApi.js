// routes/sellerLowStockProductsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
}

// GET /api/seller/low-stock-products
router.get('/low-stock-products', requireBusiness, async (req, res) => {
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

    const LOW_STOCK_THRESHOLD = 20;

    const lowStockProducts = await Product.find({
      business: business._id,
      stock: { $gt: 0, $lte: LOW_STOCK_THRESHOLD },
    })
      .select('customId name imageUrl stock category price')
      .sort({ stock: 1, updatedAt: -1 })
      .lean();

    return res.json({
      ok: true,
      stats: {
        lowStockCount: lowStockProducts.length,
        lowStockThreshold: LOW_STOCK_THRESHOLD,
      },
      products: lowStockProducts,
    });
  } catch (error) {
    console.error('❌ seller low stock products api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load low stock products',
    });
  }
});

module.exports = router;