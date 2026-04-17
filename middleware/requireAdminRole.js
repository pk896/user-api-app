// middleware/requireAdminRole.js
'use strict';

module.exports = function requireAdminRole(allowedRoles = []) {
  return function (req, res, next) {
    const role = String(req.admin?.role || req.session?.admin?.role || '').trim();

    if (allowedRoles.includes(role)) {
      return next();
    }

    const wantsJson =
      req.path.startsWith('/api') ||
      req.originalUrl.startsWith('/api') ||
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json'));

    if (wantsJson) {
      return res.status(403).json({
        ok: false,
        message: 'Forbidden (admin role not allowed).',
      });
    }

    if (req.flash) req.flash('error', 'You do not have access to that admin area.');
    return res.redirect('/admin/dashboard');
  };
};
