// middleware/requireBusiness.js
const chalk = require('chalk');

module.exports = function requireBusiness(req, res, next) {
  try {
    if (!req.session || !req.session.business) {
      if (chalk?.yellow) {
        console.log(chalk.yellow('🚫 No active business session'));
      } else {
        console.log('🚫 No active business session');
      }
      req.flash('error', 'Please log in to continue.');
      return res.redirect('/business/login');
    }

    if (chalk?.cyan) {
      console.log(chalk.cyan(`✅ Authenticated business: ${req.session.business.name}`));
    } else {
      console.log(`✅ Authenticated business: ${req.session.business.name}`);
    }

    next();
  } catch (err) {
    console.error('❌ requireBusiness middleware error:', err);
    req.flash('error', 'Authentication check failed.');
    return res.redirect('/business/login');
  }
};
