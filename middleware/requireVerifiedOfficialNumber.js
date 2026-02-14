// middleware/requireVerifiedOfficialNumber.js
'use strict';

const mongoose = require('mongoose');
const Business = require('../models/Business');

function normStatus(v) {
  return String(v || '').trim().toLowerCase();
}

module.exports = async function requireVerifiedOfficialNumber(req, res, next) {
  try {
    const s = req.session || {};

    // ✅ Fast path: requireBusiness already attached DB-trusted business (lean)
    if (req.business && req.business._id) {
      const st = normStatus(req.business?.verification?.status);
      if (st === 'verified') return next();

      req.flash(
        'warning',
        'Your business registration number is not verified yet. Please wait for admin verification to access this feature.'
      );
      return res.redirect('/business/verify-pending');
    }

    // ------------------------------------------------------------
    // Fallback path: in case someone used this middleware alone
    // ------------------------------------------------------------
    const rawId = s.businessId || s.business?._id || s.business?.id || '';
    const businessId = String(rawId || '').trim();

    if (!businessId) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    if (!mongoose.isValidObjectId(businessId)) {
      try { delete s.business; delete s.businessId; } catch {
        // placeholding
      }
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ Trust DB over session
    const b = await Business.findById(businessId)
      .select('verification.status name email role payouts isVerified')
      .lean();

    if (!b) {
      try { delete s.business; delete s.businessId; } catch {
        // placeholding
      }
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ Attach for downstream routes (consistent with other middlewares)
    req.business = b;

    // keep session in sync (older code expects req.session.business)
    s.businessId = String(b._id);
    s.business = {
      ...(s.business || {}),
      _id: String(b._id),
      name: b.name || s.business?.name || 'Business',
      email: b.email || s.business?.email || '',
      role: b.role || s.business?.role || '',
      isVerified: b.isVerified === true,
      payouts: {
        enabled: b.payouts?.enabled === true,
        paypalEmail: b.payouts?.paypalEmail || '',
      },
    };
    res.locals.business = s.business;

    const st = normStatus(b?.verification?.status);
    if (st !== 'verified') {
      req.flash(
        'warning',
        'Your business registration number is not verified yet. Please wait for admin verification to access this feature.'
      );
      return res.redirect('/business/verify-pending');
    }

    return next();
  } catch (err) {
    console.error('❌ requireVerifiedOfficialNumber error:', err);
    req.flash('error', 'Unable to verify your business number right now.');
    return res.redirect('/business/dashboard');
  }
};
