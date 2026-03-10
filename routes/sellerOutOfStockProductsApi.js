// routes/sellerOutOfStockProductsApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
}

// GET /api/seller/out-of-stock-products
router.get('/out-of-stock-products', requireBusiness, async (req, res) => {
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

    const outOfStockProducts = await Product.find({
      business: business._id,
      stock: { $lte: 0 },
    })
      .select('customId name imageUrl stock category price')
      .sort({ updatedAt: -1, name: 1 })
      .lean();

    return res.json({
      ok: true,
      stats: {
        outOfStockCount: outOfStockProducts.length,
      },
      products: outOfStockProducts,
    });
  } catch (error) {
    console.error('❌ seller out of stock products api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load out of stock products',
    });
  }
});

module.exports = router;