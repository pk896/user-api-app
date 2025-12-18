// middleware/requireOfficialNumberVerified.js
const mongoose = require('mongoose');

let Business = null;
try {
  Business = require('../models/Business');
} catch {
  // optional model
}

function normalizeStatus(v) {
  return String(v || '').trim().toLowerCase();
}

module.exports = async function requireOfficialNumberVerified(req, res, next) {
  try {
    // ✅ Allow these routes even if NOT verified (so user can proceed)
    const allowPaths = [
      '/business/verify-pending',
      '/business/resend-official-number-email', // change to your real path if different
      '/business/logout',
    ];

    // allow subpaths too (optional)
    if (allowPaths.some((p) => req.path === p || req.originalUrl.startsWith(p + '?'))) {
      return next();
    }

    // Must be logged in as business first
    const sessionBiz = req.session?.business;
    const bizId = sessionBiz?._id || sessionBiz?.id;

    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    if (!Business) {
      req.flash('error', 'Verification check is unavailable. Please try again.');
      return res.redirect('/business/dashboard');
    }

    // Always re-check from DB (do NOT trust session)
    const business = await Business.findById(bizId)
      .select('name email verification officialNumber officialNumberType')
      .lean();

    if (!business) {
      req.session.business = null;
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const status = normalizeStatus(business?.verification?.status);

    if (status !== 'verified') {
      req.flash(
        'warning',
        'Your official number is not verified yet. Please wait for admin approval.',
      );

      // ✅ Prevent redirect loop
      if (req.originalUrl.startsWith('/business/verify-pending')) {
        return next();
      }

      return res.redirect('/business/verify-pending');
    }

    // Optional: attach fresh business data for downstream handlers
    req.business = business;

    return next();
  } catch (err) {
    return next(err);
  }
};
