// middleware/requireVerifiedBusiness.js
'use strict';

const mongoose = require('mongoose');
const Business = require('../models/Business');

module.exports = async function requireVerifiedBusiness(req, res, next) {
  try {
    const s = req.session || {};

    // ✅ Prefer req.business (from requireBusiness), fallback to session
    const rawId =
      req.business?._id ||
      s.businessId ||
      s.business?._id ||
      s.business?.id;

    if (!rawId) {
      req.flash('error', 'Please log in to access this page.');
      return res.redirect('/business/login');
    }

    const businessId = String(rawId).trim();

    if (!mongoose.isValidObjectId(businessId)) {
      try { req.session.destroy(() => {}); } catch {
        // placeholding
      }
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ Always trust DB for verification status
    const business = await Business.findById(businessId).select([
      'isVerified',
      'name email role',
      'payouts',
    ].join(' '));

    if (!business) {
      try { req.session.destroy(() => {}); } catch {
        // placeholding
      }
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified !== true) {
      req.flash('warning', 'Please verify your email to unlock these features.');
      return res.redirect('/business/verify-pending');
    }

    // ✅ Attach to req for downstream routes (strongest + consistent)
    req.business = business;

    // ✅ Keep session in sync (so older code keeps working)
    s.businessId = String(business._id);
    s.business = {
      ...(s.business || {}),
      _id: String(business._id),
      name: business.name,
      email: business.email,
      role: business.role,
      isVerified: true,
      payouts: {
        enabled: business.payouts?.enabled === true,
        paypalEmail: business.payouts?.paypalEmail || '',
      },
    };

    // ✅ Optional locals for EJS (safe: no bank details here)
    res.locals.business = s.business;

    return next();
  } catch (err) {
    console.error('❌ requireVerifiedBusiness error:', err);
    req.flash('error', 'Unable to verify your account right now.');
    return res.redirect('/business/dashboard');
  }
};
