// routes/adminUiApi.js
'use strict';

const express = require('express');
const Business = require('../models/Business');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// ✅ Everything in here requires admin session
router.use(requireAdmin);

// GET /api/admin-ui/summary
router.get('/summary', async (req, res) => {
  try {
    const totalBusinesses = await Business.countDocuments({});

    const byRoleAgg = await Business.aggregate([
      { $group: { _id: '$role', count: { $sum: 1 } } },
    ]);

    const byRole = byRoleAgg.reduce((acc, r) => {
      acc[r._id || 'unknown'] = Number(r.count || 0);
      return acc;
    }, {});

    const verified = await Business.countDocuments({ isVerified: true });
    const unverified = totalBusinesses - verified;

    const recentBusinesses = await Business.find({})
      .select('name email role isVerified createdAt internalBusinessId')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    return res.json({
      ok: true,
      totals: { totalBusinesses, verified, unverified, byRole },
      recentBusinesses,
    });
  } catch (err) {
    console.error('❌ /api/admin-ui/summary error:', err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

module.exports = router;