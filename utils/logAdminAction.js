// utils/logAdminAction.js
'use strict';

const AdminAuditLog = require('../models/AdminAuditLog');

async function logAdminAction(req, payload = {}) {
  try {
    const sessionAdmin = req?.admin || req?.session?.admin || null;

    await AdminAuditLog.create({
      adminId: payload.adminId || sessionAdmin?._id || null,
      adminIdentifier:
        String(
          payload.adminIdentifier ||
            sessionAdmin?.username ||
            sessionAdmin?.email ||
            ''
        ).trim(),
      adminName: String(payload.adminName || sessionAdmin?.fullName || sessionAdmin?.name || '').trim(),
      adminEmail: String(payload.adminEmail || sessionAdmin?.email || '').trim().toLowerCase(),
      adminRole: String(payload.adminRole || sessionAdmin?.role || '').trim(),
      action: String(payload.action || '').trim(),
      entityType: String(payload.entityType || '').trim(),
      entityId: String(payload.entityId || '').trim(),
      status: payload.status === 'failure' ? 'failure' : 'success',
      before: payload.before ?? null,
      after: payload.after ?? null,
      meta: payload.meta ?? null,
      ipAddress: String(req?.ip || '').trim(),
      userAgent: String(req?.get?.('user-agent') || '').trim(),
    });
  } catch (err) {
    console.error('❌ Failed to write admin audit log:', err.message);
  }
}

module.exports = { logAdminAction };
