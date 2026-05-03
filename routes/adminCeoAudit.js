// routes/adminCeoAudit.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const AdminAuditLog = require('../models/AdminAuditLog');

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildDateFilter(from, to) {
  const createdAt = {};

  const fromValue = clean(from, 40);
  const toValue = clean(to, 40);

  if (fromValue) {
    const fromDate = new Date(`${fromValue}T00:00:00.000Z`);
    if (!Number.isNaN(fromDate.getTime())) {
      createdAt.$gte = fromDate;
    }
  }

  if (toValue) {
    const toDate = new Date(`${toValue}T23:59:59.999Z`);
    if (!Number.isNaN(toDate.getTime())) {
      createdAt.$lte = toDate;
    }
  }

  return Object.keys(createdAt).length ? createdAt : null;
}

router.get(
  '/ceo-audit',
  requireAdmin,
  requireAdminRole(['super_admin']),
  async (req, res) => {
    try {
      const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
      const limit = 50;
      const skip = (page - 1) * limit;

      const filters = {
        q: clean(req.query.q, 120),
        adminRole: clean(req.query.adminRole, 80),
        status: clean(req.query.status, 20),
        action: clean(req.query.action, 120),
        entityType: clean(req.query.entityType, 120),
        from: clean(req.query.from, 40),
        to: clean(req.query.to, 40),
      };

      const query = {};

      if (filters.adminRole) {
        query.adminRole = filters.adminRole;
      }

      if (filters.status === 'success' || filters.status === 'failure') {
        query.status = filters.status;
      }

      if (filters.action) {
        query.action = filters.action;
      }

      if (filters.entityType) {
        query.entityType = filters.entityType;
      }

      const createdAtFilter = buildDateFilter(filters.from, filters.to);
      if (createdAtFilter) {
        query.createdAt = createdAtFilter;
      }

      if (filters.q) {
        const rx = new RegExp(escapeRegex(filters.q), 'i');

        query.$or = [
          { adminIdentifier: rx },
          { adminName: rx },
          { adminEmail: rx },
          { adminRole: rx },
          { action: rx },
          { entityType: rx },
          { entityId: rx },
          { ipAddress: rx },
        ];
      }

      const [logs, total, roleOptions, actionOptions, entityTypeOptions] = await Promise.all([
        AdminAuditLog.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),

        AdminAuditLog.countDocuments(query),

        AdminAuditLog.distinct('adminRole'),

        AdminAuditLog.distinct('action'),

        AdminAuditLog.distinct('entityType'),
      ]);

      const totalPages = Math.max(1, Math.ceil(total / limit));

      return res.render('admin/ceo-audit', {
        layout: 'layout',
        title: 'CEO Admin Audit Log',
        nonce: res.locals.nonce,
        themeCss: res.locals.themeCss,
        admin: req.admin || req.session.admin,
        logs,
        total,
        page,
        totalPages,
        limit,
        filters,
        roleOptions: roleOptions.filter(Boolean).sort(),
        actionOptions: actionOptions.filter(Boolean).sort(),
        entityTypeOptions: entityTypeOptions.filter(Boolean).sort(),
        success: req.flash('success') || [],
        error: req.flash('error') || [],
        info: req.flash('info') || [],
        warning: req.flash('warning') || [],
      });
    } catch (err) {
      console.error('❌ CEO audit log page error:', err);
      req.flash('error', 'Could not load CEO audit log.');
      return res.redirect('/admin/dashboard');
    }
  }
);

module.exports = router;
