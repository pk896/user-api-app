// routes/adminStatsApi.js
'use strict';

const express = require('express');
const Business = require('../models/Business');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// GET /api/admin/stats/businesses
router.get('/stats/businesses', requireAdmin, async (req, res) => {
  try {
    // total businesses
    const totalBusinesses = await Business.countDocuments({});

    // by role
    const [sellers, suppliers, buyers] = await Promise.all([
      Business.countDocuments({ role: 'seller' }),
      Business.countDocuments({ role: 'supplier' }),
      Business.countDocuments({ role: 'buyer' }),
    ]);

    return res.json({
      ok: true,
      totalBusinesses,
      sellers,
      suppliers,
      buyers,
    });
  } catch (err) {
    console.error('❌ admin stats error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load stats' });
  }
});

module.exports = router;