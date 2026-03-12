// routes/businessSidebarApi.js
'use strict';

const express = require('express');
const Business = require('../models/Business');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
}

router.get('/session/sidebar-state', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business || !business._id) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      });
    }

    const freshBusiness = await Business.findById(business._id)
      .select('_id role isVerified name email')
      .lean();

    if (!freshBusiness) {
      return res.status(404).json({
        ok: false,
        message: 'Business not found',
      });
    }

    return res.json({
      ok: true,
      business: {
        _id: String(freshBusiness._id),
        role: freshBusiness.role || '',
        isVerified: freshBusiness.isVerified === true,
        name: freshBusiness.name || '',
        email: freshBusiness.email || '',
      },
    });
  } catch (err) {
    console.error('❌ /business/api/session/sidebar-state error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load sidebar state',
    });
  }
});

module.exports = router;