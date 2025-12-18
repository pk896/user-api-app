// middleware/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();

  if (req.flash) req.flash('error', 'Please log in as admin.');
  return res.redirect('/admin/login');
};
