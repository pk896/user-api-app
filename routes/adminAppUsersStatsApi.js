// routes/adminAppUsersStatsApi.js
'use strict';

const express = require('express');
const requireAdmin = require('../middleware/requireAdmin');

const Business = require('../models/Business');
const User = require('../models/User');

const router = express.Router();

/**
 * GET /api/admin/stats/app-users
 * Returns total businesses + total non-business users (users collection)
 */
router.get('/stats/app-users', requireAdmin, async (req, res) => {
  try {
    const [totalBusinesses, nonBusinessUsers] = await Promise.all([
      Business.countDocuments({}),
      User.countDocuments({}), // treating all User docs as "non-business users"
    ]);

    const totalAppUsers = Number(totalBusinesses || 0) + Number(nonBusinessUsers || 0);

    return res.json({
      ok: true,
      totalBusinesses,
      nonBusinessUsers,
      totalAppUsers,
    });
  } catch (err) {
    console.error('❌ admin app-users stats error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load app users stats' });
  }
});

module.exports = router;