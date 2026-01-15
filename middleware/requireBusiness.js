// middleware/requireBusiness.js
const chalk = require('chalk');

module.exports = function requireBusiness(req, res, next) {
  try {
    const s = req.session || {};

    // ✅ accept either "business" object OR "businessId"
    const businessObj = s.business;
    const businessId = s.businessId || businessObj?._id || businessObj?.id;

    if (!businessObj && !businessId) {
      console.log(
        chalk?.yellow ? chalk.yellow('🚫 No active business session') : '🚫 No active business session',
      );
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    // ✅ normalize (so other code can always rely on these)
    s.businessId = String(businessId || businessObj?._id || businessObj?.id);

    if (!s.business) {
      s.business = { _id: s.businessId, name: 'Business' };
    }

    console.log(
      chalk?.cyan
        ? chalk.cyan(`✅ Authenticated business: ${s.business?.name || s.businessId}`)
        : `✅ Authenticated business: ${s.business?.name || s.businessId}`,
    );

    return next();
  } catch (err) {
    console.error('❌ requireBusiness middleware error:', err);
    req.flash('error', 'Authentication check failed.');
    return res.redirect('/business/login');
  }
};
