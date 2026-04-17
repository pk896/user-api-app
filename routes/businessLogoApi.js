// routes/businessLogoApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Business = require('../models/Business');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

/* ----------------------------------------------------------
 * 👤 Business Logo API
 * Standalone route for seller/admin frontend avatar usage
 * URL: /business/api/logo
 * -------------------------------------------------------- */
router.get('/logo', requireBusiness, async (req, res) => {
  try {
    const bizId = String(req.business?._id || '').trim();

    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      return res.status(401).json({
        success: false,
        message: 'Business session not found.',
      });
    }

    const business = await Business.findById(bizId)
      .select('name logoUrl')
      .lean();

    if (!business) {
      return res.status(404).json({
        success: false,
        message: 'Business not found.',
      });
    }

    return res.json({
      success: true,
      business: {
        name: String(business.name || '').trim(),
        logoUrl: String(business.logoUrl || '').trim(),
      },
    });
  } catch (err) {
    console.error('❌ businessLogoApi error:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to load business logo.',
    });
  }
});

module.exports = router;
