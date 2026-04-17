// middleware/requireAdminPermission.js
'use strict';

const { hasPermission } = require('../utils/adminRoles');

module.exports = function requireAdminPermission(permission) {
  return function (req, res, next) {
    const admin = req.admin || req.session?.admin || null;

    if (hasPermission(admin, permission)) {
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
        message: `Forbidden (missing permission: ${permission}).`,
      });
    }

    if (req.flash) req.flash('error', 'You do not have permission to do that action.');
    return res.redirect('/admin/dashboard');
  };
};
