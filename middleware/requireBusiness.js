// middleware/requireBusiness.js
'use strict';

const chalk = require('chalk');
const mongoose = require('mongoose');
const Business = require('../models/Business');

module.exports = async function requireBusiness(req, res, next) {
  try {
    const s = req.session || {};

    // Accept either session.business object OR session.businessId
    const sessionBiz = s.business || null;
    const rawId = s.businessId || sessionBiz?._id || sessionBiz?.id || '';

    const bizId = String(rawId || '').trim();

    if (!bizId) {
      console.log(
        chalk?.yellow
          ? chalk.yellow('🚫 No active business session (missing id)')
          : '🚫 No active business session (missing id)'
      );
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    // Hard validate ObjectId early (blocks weird values)
    if (!mongoose.isValidObjectId(bizId)) {
      console.log(
        chalk?.yellow
          ? chalk.yellow(`🚫 Invalid business id in session: ${bizId}`)
          : `🚫 Invalid business id in session: ${bizId}`
      );

      // Destroy session data safely
      try {
        delete s.business;
        delete s.businessId;
      } catch {
        // placeholding
      }

      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ Always trust DB for ownership + identity
    // Keep select minimal: add more fields only when needed globally
    const business = await Business.findById(bizId)
      .select('_id name email role isVerified verification officialNumber officialNumberType payouts')
      .lean();

    if (!business) {
      console.log(
        chalk?.yellow
          ? chalk.yellow(`🚫 Business not found for id: ${bizId}`)
          : `🚫 Business not found for id: ${bizId}`
      );

      try {
        delete s.business;
        delete s.businessId;
      } catch {
        // placeholding
      }

      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ Attach DB-loaded business for routes/controllers
    req.business = business;

    // ✅ Keep session normalized + synced (small + safe)
    s.businessId = String(business._id);
    s.business = {
      _id: String(business._id),
      name: business.name || 'Business',
      email: business.email || '',
      role: business.role || '',
      isVerified: business.isVerified === true,
      payouts: {
        enabled: business.payouts?.enabled === true,
        paypalEmail: business.payouts?.paypalEmail || '',
      },
    };

    // Avoid logging email; just id/name
    console.log(
      chalk?.cyan
        ? chalk.cyan(`✅ Authenticated business: ${s.business.name} (${s.businessId})`)
        : `✅ Authenticated business: ${s.business.name} (${s.businessId})`
    );

    return next();
  } catch (err) {
    console.error('❌ requireBusiness middleware error:', err);
    req.flash('error', 'Authentication check failed.');
    return res.redirect('/business/login');
  }
};
