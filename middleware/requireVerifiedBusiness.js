// middleware/requireVerifiedBusiness.js
const Business = require('../models/Business');

module.exports = async function requireVerifiedBusiness(req, res, next) {
  try {
    const sessionBiz = req.session.business;
    if (!sessionBiz || !sessionBiz._id) {
      req.flash('error', 'Please log in to access this page.');
      return res.redirect('/business/login');
    }

    // Always trust DB for verification status
    const business = await Business.findById(sessionBiz._id)
      .select('isVerified name email role')
      .lean();

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (!business.isVerified) {
      req.flash('error', 'Please verify your email to unlock these features.');
      return res.redirect('/business/verify-pending');
    }

    // keep session in sync
    req.session.business.isVerified = true;
    res.locals.business = req.session.business;

    return next();
  } catch (err) {
    console.error('❌ requireVerifiedBusiness error:', err);
    req.flash('error', 'Unable to verify your account right now.');
    return res.redirect('/business/dashboard');
  }
};
