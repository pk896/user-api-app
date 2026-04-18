// routes/admin.js
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const Admin = require('../models/Admin');
const { ADMIN_ROLES, getPermissionsForRole } = require('../utils/adminRoles');
const { logAdminAction } = require('../utils/logAdminAction');

/* -------------------------------------------
   Helpers
------------------------------------------- */
function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function normalizeIdentifier(v) {
  return String(v || '').trim().toLowerCase();
}

/* -------------------------------------------
   Admin-only login attempt limiter (in-memory)
   Good basic protection. For multi-instance, use Redis later.
------------------------------------------- */
const ATTEMPT_WINDOW_MS = 10 * 60 * 1000; // 10 min
const MAX_ATTEMPTS = 8;

const attemptsByKey = new Map();

function adminLoginThrottle(req, res, next) {
  try {
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    const identifier = normalizeIdentifier(req.body?.username || req.body?.identifier || '');
    const key = `${ip}:${identifier}`;

    const now = Date.now();
    const rec = attemptsByKey.get(key) || { count: 0, firstAt: now };

    if (now - rec.firstAt > ATTEMPT_WINDOW_MS) {
      attemptsByKey.set(key, { count: 0, firstAt: now });
      req._adminAttemptKey = key;
      req._adminAttemptRec = { count: 0, firstAt: now };
      return next();
    }

    if (rec.count >= MAX_ATTEMPTS) {
      req.flash('error', 'Too many login attempts. Please try again later.');
      return res.redirect('/admin/login');
    }

    req._adminAttemptKey = key;
    req._adminAttemptRec = rec;
    return next();
  } catch {
    return next();
  }
}

function bumpAttempt(req) {
  const key = req._adminAttemptKey;
  const rec = req._adminAttemptRec;
  if (!key || !rec) return;
  rec.count += 1;
  attemptsByKey.set(key, rec);
}

function clearAttempt(req) {
  const key = req._adminAttemptKey;
  if (!key) return;
  attemptsByKey.delete(key);
}

/* -------------------------------------------
   /admin -> /admin/dashboard
------------------------------------------- */
router.get('/', requireAdmin, (req, res) => res.redirect('/admin/dashboard'));

/* -------------------------------------------
   GET /admin/login
------------------------------------------- */
router.get('/login', (req, res) => {
  const themeCss = themeCssFromSession(req);

  if (req.session?.admin) return res.redirect('/admin/dashboard');

  return res.render('admin-login', {
    title: '🔐 Admin Login',
    formAction: '/admin/login',
    themeCss,
    nonce: res.locals.nonce,
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
    warning: req.flash('warning'),
  });
});

/* -------------------------------------------
   POST /admin/login
   - DB-backed admin account
   - individual admin identity
   - session regeneration
   - audit logging
------------------------------------------- */
router.post('/login', adminLoginThrottle, async (req, res) => {
  const identifierInput = normalizeIdentifier(req.body?.username || req.body?.identifier || '');
  const passwordInput = String(req.body?.password || '').trim();

  try {
    if (!identifierInput || !passwordInput) {
      bumpAttempt(req);
      req.flash('error', '❌ Invalid credentials. Please try again.');
      return res.redirect('/admin/login');
    }

    const admin = await Admin.findOne({
      $or: [
        { username: identifierInput },
        { email: identifierInput },
      ],
    });

    if (!admin || admin.isActive !== true) {
      bumpAttempt(req);

      await logAdminAction(req, {
        adminIdentifier: identifierInput,
        action: 'admin.login',
        entityType: 'admin_auth',
        status: 'failure',
        meta: { reason: 'invalid_credentials_or_inactive' },
      });

      req.flash('error', '❌ Invalid credentials. Please try again.');
      return res.redirect('/admin/login');
    }

    const passOk = await bcrypt.compare(passwordInput, admin.passwordHash);

    if (!passOk) {
      bumpAttempt(req);

      await logAdminAction(req, {
        adminId: admin._id,
        adminIdentifier: admin.username,
        adminName: admin.fullName,
        adminEmail: admin.email,
        adminRole: admin.role,
        action: 'admin.login',
        entityType: 'admin_auth',
        status: 'failure',
        meta: { reason: 'wrong_password' },
      });

      req.flash('error', '❌ Invalid credentials. Please try again.');
      return res.redirect('/admin/login');
    }

    clearAttempt(req);

    admin.lastLoginAt = new Date();
    admin.lastLoginIp = String(req.ip || '').trim();
    await admin.save();

    req.session.regenerate(async (err) => {
      if (err) {
        console.error('Session regenerate error:', err);
        req.flash('error', 'Session error. Please try again.');
        return res.redirect('/admin/login');
      }

      req.session.admin = {
        _id: String(admin._id),
        fullName: String(admin.fullName || '').trim(),
        name: String(admin.fullName || '').trim(),
        email: String(admin.email || '').trim().toLowerCase(),
        username: String(admin.username || '').trim().toLowerCase(),
        role: String(admin.role || '').trim(),
        permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
        at: Date.now(),
      };

      await logAdminAction(req, {
        adminId: admin._id,
        adminIdentifier: admin.username,
        adminName: admin.fullName,
        adminEmail: admin.email,
        adminRole: admin.role,
        action: 'admin.login',
        entityType: 'admin_auth',
        status: 'success',
      });

      req.flash('success', `Welcome back, ${admin.fullName}!`);

      req.session.save((err2) => {
        if (err2) console.error('Session save error:', err2);
        return res.redirect('/admin/dashboard');
      });
    });
  } catch (e) {
    console.error('Admin login error:', e);
    bumpAttempt(req);

    await logAdminAction(req, {
      adminIdentifier: identifierInput,
      action: 'admin.login',
      entityType: 'admin_auth',
      status: 'failure',
      meta: { reason: 'server_error' },
    });

    req.flash('error', 'Login failed. Please try again.');
    return res.redirect('/admin/login');
  }
});

/* -------------------------------------------
   GET /admin/dashboard
------------------------------------------- */
router.get('/dashboard', requireAdmin, (req, res) => {
  try {
    const themeCss = themeCssFromSession(req);

    return res.render('admin/go-to-admin-dashboard', {
      title: 'Admin Dashboard',
      nonce: res.locals.nonce,
      themeCss,
      admin: req.admin || req.session.admin,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ Error loading admin dashboard entry page:', err);
    req.flash('error', '❌ Could not load admin dashboard entry page.');
    return res.redirect('/admin/login');
  }
});

/* -------------------------------------------
   Super Admin: Admin Management
------------------------------------------- */
router.get(
  '/admins',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const admins = await Admin.find({})
        .select('fullName email username role isActive lastLoginAt createdAt')
        .sort({ createdAt: -1 })
        .lean();

      const currentAdminId = String(req.admin?._id || req.session?.admin?._id || '').trim();

      return res.render('admin/admins-index', {
        title: 'Admin Management',
        nonce: res.locals.nonce,
        themeCss: themeCssFromSession(req),
        admins,
        currentAdminId,
        admin: req.admin || req.session.admin,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Failed to load admin list:', err);
      req.flash('error', 'Could not load admin list.');
      return res.redirect('/admin/dashboard');
    }
  }
);

router.get(
  '/admins/new',
  requireAdmin,
  requireAdminRole(['super_admin']),
  (req, res) => {
    return res.render('admin/admins-new', {
      title: 'Create Admin',
      nonce: res.locals.nonce,
      themeCss: themeCssFromSession(req),
      roles: ADMIN_ROLES.filter((r) => r !== 'super_admin'),
      admin: req.admin || req.session.admin,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  }
);

router.post(
  '/admins/new',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const fullName = String(req.body?.fullName || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const username = String(req.body?.username || '').trim().toLowerCase();
      const password = String(req.body?.password || '').trim();
      const role = String(req.body?.role || '').trim();

      if (!fullName || !email || !username || !password || !role) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/admin/admins/new');
      }

      if (!ADMIN_ROLES.includes(role) || role === 'super_admin') {
        req.flash('error', 'Invalid admin role.');
        return res.redirect('/admin/admins/new');
      }

      const existing = await Admin.findOne({
        $or: [{ email }, { username }],
      }).lean();

      if (existing) {
        req.flash('error', 'Admin with that email or username already exists.');
        return res.redirect('/admin/admins/new');
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const adminDoc = await Admin.create({
        fullName,
        email,
        username,
        passwordHash,
        role,
        permissions: getPermissionsForRole(role),
        isActive: true,
        mustChangePassword: false,
        createdBy: req.admin?._id || null,
        updatedBy: req.admin?._id || null,
      });

      await logAdminAction(req, {
        action: 'admin.create',
        entityType: 'admin',
        entityId: String(adminDoc._id),
        status: 'success',
        after: {
          fullName: adminDoc.fullName,
          email: adminDoc.email,
          username: adminDoc.username,
          role: adminDoc.role,
          isActive: adminDoc.isActive,
        },
      });

      req.flash('success', `Admin ${adminDoc.fullName} created successfully.`);
      return res.redirect('/admin/admins');
    } catch (err) {
      console.error('❌ Failed to create admin:', err);
      req.flash('error', 'Could not create admin.');
      return res.redirect('/admin/admins/new');
    }
  }
);

router.post(
  '/admins/:id/toggle-active',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();

      const adminDoc = await Admin.findById(targetId);
      if (!adminDoc) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      if (String(adminDoc.role) === 'super_admin') {
        req.flash('error', 'Super admin cannot be disabled here.');
        return res.redirect('/admin/admins');
      }

      const before = {
        isActive: adminDoc.isActive,
      };

      adminDoc.isActive = !adminDoc.isActive;
      adminDoc.updatedBy = req.admin?._id || null;
      await adminDoc.save();

      await logAdminAction(req, {
        action: 'admin.toggle_active',
        entityType: 'admin',
        entityId: String(adminDoc._id),
        status: 'success',
        before,
        after: {
          isActive: adminDoc.isActive,
        },
        meta: {
          targetEmail: adminDoc.email,
          targetUsername: adminDoc.username,
        },
      });

      req.flash(
        'success',
        `Admin ${adminDoc.fullName} is now ${adminDoc.isActive ? 'active' : 'disabled'}.`
      );
      return res.redirect('/admin/admins');
    } catch (err) {
      console.error('❌ Failed to toggle admin active status:', err);
      req.flash('error', 'Could not update admin status.');
      return res.redirect('/admin/admins');
    }
  }
);

router.get(
  '/admins/:id/edit',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const adminTarget = await Admin.findById(req.params.id)
        .select('fullName email username role isActive')
        .lean();

      if (!adminTarget) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      return res.render('admin/admins-edit', {
        title: 'Edit Admin',
        nonce: res.locals.nonce,
        themeCss: themeCssFromSession(req),
        adminTarget,
        admin: req.admin || req.session.admin,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Failed to load admin edit page:', err);
      req.flash('error', 'Could not load admin edit page.');
      return res.redirect('/admin/admins');
    }
  }
);

router.post(
  '/admins/:id/edit',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();
      const fullName = String(req.body?.fullName || '').trim();
      const email = String(req.body?.email || '').trim().toLowerCase();
      const username = String(req.body?.username || '').trim().toLowerCase();

      if (!fullName || !email || !username) {
        req.flash('error', 'Full name, email, and username are required.');
        return res.redirect(`/admin/admins/${targetId}/edit`);
      }

      const adminDoc = await Admin.findById(targetId);
      if (!adminDoc) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      const existing = await Admin.findOne({
        _id: { $ne: adminDoc._id },
        $or: [{ email }, { username }],
      }).lean();

      if (existing) {
        req.flash('error', 'Another admin already uses that email or username.');
        return res.redirect(`/admin/admins/${targetId}/edit`);
      }

      const before = {
        fullName: adminDoc.fullName,
        email: adminDoc.email,
        username: adminDoc.username,
      };

      adminDoc.fullName = fullName;
      adminDoc.email = email;
      adminDoc.username = username;
      adminDoc.updatedBy = req.admin?._id || null;
      await adminDoc.save();

      await logAdminAction(req, {
        action: 'admin.update_profile',
        entityType: 'admin',
        entityId: String(adminDoc._id),
        status: 'success',
        before,
        after: {
          fullName: adminDoc.fullName,
          email: adminDoc.email,
          username: adminDoc.username,
        },
        meta: {
          targetRole: adminDoc.role,
        },
      });

      const currentAdminId = String(req.admin?._id || req.session?.admin?._id || '').trim();

      if (String(adminDoc._id) === currentAdminId && req.session?.admin) {
        req.session.admin.fullName = String(adminDoc.fullName || '').trim();
        req.session.admin.name = String(adminDoc.fullName || '').trim();
        req.session.admin.email = String(adminDoc.email || '').trim().toLowerCase();
        req.session.admin.username = String(adminDoc.username || '').trim().toLowerCase();
      }

      req.flash('success', `Admin ${adminDoc.fullName} updated successfully.`);
      return res.redirect('/admin/admins');
    } catch (err) {
      console.error('❌ Failed to update admin profile:', err);
      req.flash('error', 'Could not update admin profile.');
      return res.redirect(`/admin/admins/${req.params.id}/edit`);
    }
  }
);

router.get(
  '/admins/:id/reset-password',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const adminTarget = await Admin.findById(req.params.id)
        .select('fullName email username role')
        .lean();

      if (!adminTarget) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      return res.render('admin/admins-reset-password', {
        title: 'Reset Admin Password',
        nonce: res.locals.nonce,
        themeCss: themeCssFromSession(req),
        adminTarget,
        admin: req.admin || req.session.admin,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Failed to load admin reset-password page:', err);
      req.flash('error', 'Could not load reset-password page.');
      return res.redirect('/admin/admins');
    }
  }
);

router.post(
  '/admins/:id/reset-password',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();
      const password = String(req.body?.password || '').trim();

      if (!password || password.length < 8) {
        req.flash('error', 'Password must be at least 8 characters.');
        return res.redirect(`/admin/admins/${targetId}/reset-password`);
      }

      const adminDoc = await Admin.findById(targetId);
      if (!adminDoc) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      adminDoc.passwordHash = await bcrypt.hash(password, 12);
      adminDoc.mustChangePassword = false;
      adminDoc.updatedBy = req.admin?._id || null;
      await adminDoc.save();

      await logAdminAction(req, {
        action: 'admin.reset_password',
        entityType: 'admin',
        entityId: String(adminDoc._id),
        status: 'success',
        meta: {
          targetEmail: adminDoc.email,
          targetUsername: adminDoc.username,
        },
      });

      req.flash('success', `Password updated for ${adminDoc.fullName}.`);
      return res.redirect('/admin/admins');
    } catch (err) {
      console.error('❌ Failed to reset admin password:', err);
      req.flash('error', 'Could not reset admin password.');
      return res.redirect('/admin/admins');
    }
  }
);

router.post(
  '/admins/:id/delete',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();
      const currentAdminId = String(req.admin?._id || req.session?.admin?._id || '').trim();

      const adminDoc = await Admin.findById(targetId);
      if (!adminDoc) {
        req.flash('error', 'Admin not found.');
        return res.redirect('/admin/admins');
      }

      if (String(adminDoc.role || '').trim() === 'super_admin') {
        req.flash('error', 'Super admin cannot be deleted.');
        return res.redirect('/admin/admins');
      }

      if (String(adminDoc._id) === currentAdminId) {
        req.flash('error', 'You cannot delete your own admin account.');
        return res.redirect('/admin/admins');
      }

      if (adminDoc.isActive === true) {
        req.flash('error', 'Only disabled admins can be permanently deleted. Disable this admin first.');
        return res.redirect('/admin/admins');
      }

      const before = {
        fullName: adminDoc.fullName,
        email: adminDoc.email,
        username: adminDoc.username,
        role: adminDoc.role,
        isActive: adminDoc.isActive,
        lastLoginAt: adminDoc.lastLoginAt,
        createdAt: adminDoc.createdAt,
        updatedAt: adminDoc.updatedAt,
      };

      await logAdminAction(req, {
        action: 'admin.delete',
        entityType: 'admin',
        entityId: String(adminDoc._id),
        status: 'success',
        before,
        meta: {
          targetEmail: adminDoc.email,
          targetUsername: adminDoc.username,
        },
      });

      await Admin.deleteOne({ _id: adminDoc._id });

      req.flash('success', `Admin ${adminDoc.fullName} was permanently deleted.`);
      return res.redirect('/admin/admins');
    } catch (err) {
      console.error('❌ Failed to delete admin:', err);
      req.flash('error', 'Could not delete admin.');
      return res.redirect('/admin/admins');
    }
  }
);

/* -------------------------------------------
   GET /admin/me
   - current authenticated admin (safe JSON for admin-ui)
------------------------------------------- */
router.get('/me', requireAdmin, (req, res) => {
  const admin = req.admin || req.session?.admin || null;

  return res.json({
    ok: true,
    admin: admin
      ? {
          _id: String(admin._id || ''),
          fullName: String(admin.fullName || admin.name || '').trim(),
          name: String(admin.name || admin.fullName || '').trim(),
          email: String(admin.email || '').trim().toLowerCase(),
          username: String(admin.username || '').trim().toLowerCase(),
          role: String(admin.role || '').trim(),
          permissions: Array.isArray(admin.permissions) ? admin.permissions : [],
        }
      : null,
  });
});

/* -------------------------------------------
   Logout
------------------------------------------- */
router.post('/logout', requireAdmin, async (req, res) => {
  try {
    await logAdminAction(req, {
      action: 'admin.logout',
      entityType: 'admin_auth',
      status: 'success',
    });
  } catch {
    // ignore audit failure on logout
  }

  req.flash('info', '👋 You have been logged out successfully.');

  req.session.destroy(() => {
    res.clearCookie('sid');
    return res.redirect('/admin/login');
  });
});

router.get('/logout', requireAdmin, async (req, res) => {
  try {
    await logAdminAction(req, {
      action: 'admin.logout',
      entityType: 'admin_auth',
      status: 'success',
    });
  } catch {
    // ignore audit failure on logout
  }

  req.flash('info', '👋 You have been logged out successfully.');

  req.session.destroy(() => {
    res.clearCookie('sid');
    return res.redirect('/admin/login');
  });
});

module.exports = router;
