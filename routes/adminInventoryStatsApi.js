// routes/adminInventoryStatsApi.js
'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');

const Business = require('../models/Business');
const Product = require('../models/Product');

const router = express.Router();

// GET /api/admin/stats/inventory
router.get('/stats/inventory', requireAdmin, async (req, res) => {
  try {
    // 1) Get seller business IDs
    const sellers = await Business.find({ role: 'seller' }).select('_id').lean();
    const sellerIds = sellers.map((b) => b._id);

    // 2) Aggregate seller inventory from products
    const sellerAgg = await Product.aggregate([
      { $match: { business: { $in: sellerIds } } },
      {
        $group: {
          _id: null,
          totalProducts: { $sum: 1 },
          totalStock: { $sum: { $ifNull: ['$stock', 0] } },
          inventoryValue: {
            $sum: {
              $multiply: [{ $ifNull: ['$price', 0] }, { $ifNull: ['$stock', 0] }],
            },
          },
        },
      },
    ]);

    const sellerStats = sellerAgg[0] || { totalProducts: 0, totalStock: 0, inventoryValue: 0 };

    return res.json({
      ok: true,
      sellers: {
        totalProducts: Number(sellerStats.totalProducts || 0),
        totalStock: Number(sellerStats.totalStock || 0),
        inventoryValue: Number(Number(sellerStats.inventoryValue || 0).toFixed(2)),
      },
    });
  } catch (err) {
    console.error('❌ admin inventory stats error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load inventory stats' });
  }
});

module.exports = router;