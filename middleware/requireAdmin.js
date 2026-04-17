// middleware/requireAdmin.js
'use strict';

const Admin = require('../models/Admin');

module.exports = async function requireAdmin(req, res, next) {
  function wantsJsonRequest() {
    return (
      req.path.startsWith('/api') ||
      req.originalUrl.startsWith('/api') ||
      req.xhr ||
      (req.headers.accept && req.headers.accept.includes('application/json'))
    );
  }

  function rejectUnauthorized() {
    if (wantsJsonRequest()) {
      return res.status(401).json({ ok: false, message: 'Unauthorized (admin only).' });
    }

    if (req.flash) req.flash('error', 'Please log in as admin.');
    return res.redirect('/admin/login');
  }

  try {
    const sessionAdmin = req.session?.admin;
    if (!sessionAdmin || !sessionAdmin._id) {
      return rejectUnauthorized();
    }

    const admin = await Admin.findById(sessionAdmin._id)
      .select('fullName email username role permissions isActive')
      .lean();

    if (!admin || admin.isActive !== true) {
      if (req.session) {
        delete req.session.admin;
      }
      return rejectUnauthorized();
    }

    req.admin = {
      _id: String(admin._id),
      fullName: String(admin.fullName || '').trim(),
      name: String(admin.fullName || '').trim(),
      email: String(admin.email || '').trim().toLowerCase(),
      username: String(admin.username || '').trim().toLowerCase(),
      role: String(admin.role || '').trim(),
      permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
    };

    req.session.admin = {
      _id: req.admin._id,
      fullName: req.admin.fullName,
      name: req.admin.fullName,
      email: req.admin.email,
      username: req.admin.username,
      role: req.admin.role,
      permissions: req.admin.permissions,
      at: req.session.admin?.at || Date.now(),
    };

    return next();
  } catch (err) {
    console.error('❌ requireAdmin middleware error:', err);
    return rejectUnauthorized();
  }
};