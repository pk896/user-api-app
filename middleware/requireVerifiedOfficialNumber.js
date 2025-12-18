// middleware/requireVerifiedOfficialNumber.js
const Business = require('../models/Business');

module.exports = async function requireVerifiedOfficialNumber(req, res, next) {
  try {
    const sess = req.session?.business;
    if (!sess?._id) {
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    // Always trust DB over session
    const b = await Business.findById(sess._id).select('verification.status').lean();
    if (!b) {
      req.session.business = null;
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (b?.verification?.status !== 'verified') {
      req.flash(
        'warning',
        'Your business registration number is not verified yet. Please wait for admin verification to access this feature.',
      );
      return res.redirect('/business/verify-pending');
    }

    return next();
  } catch (err) {
    return next(err);
  }
};
