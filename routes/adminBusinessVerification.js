// routes/adminBusinessVerification.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Business = require('../models/Business');
const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const {
  sendOfficialNumberVerifiedEmail,
} = require('../utils/emails/officialNumberVerifiedEmail');

const {
  sendOfficialNumberRejectedEmail,
} = require('../utils/emails/officialNumberRejectedEmail');

const router = express.Router();

/**
 * ✅ Render.com safe base URL
 * Prefer PUBLIC_BASE_URL (recommended on Render), else fall back to x-forwarded-*.
 */
function getBaseUrl(req) {
  const envBase = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (envBase) return envBase;

  const protoRaw =
    req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const proto = String(protoRaw).split(',')[0].trim();

  const hostRaw = req.headers['x-forwarded-host'] || req.get('host') || '';
  const host = String(hostRaw).split(',')[0].trim();

  return `${proto}://${host}`.replace(/\/+$/, '');
}

// Helpers
const safeInt = (v, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
};

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function verificationSnapshot(business) {
  if (!business) return null;

  return {
    businessName: business.name || '',
    businessEmail: business.email || '',
    role: business.role || '',
    country: business.country || '',
    officialNumber: business.officialNumber || '',
    officialNumberType: business.officialNumberType || '',
    internalBusinessId: business.internalBusinessId || '',
    verification: {
      status: business.verification?.status || '',
      method: business.verification?.method || '',
      provider: business.verification?.provider || '',
      checkedAt: business.verification?.checkedAt || null,
      verifiedAt: business.verification?.verifiedAt || null,
      reason: business.verification?.reason || '',
    },
  };
}

// -------------------------------
// GET: List businesses for review
// /admin/business-verifications?status=pending&q=unic&country=South%20Africa&page=1
// -------------------------------
router.get(
  '/business-verifications',
  requireAdmin,
  requireAdminRole(['super_admin', 'verification_admin']),
  requireAdminPermission('verification.read'),
  async (req, res, next) => {
    try {
      const rawStatus = String(req.query.status || 'pending').trim();
      const q = String(req.query.q || '').trim();
      const country = String(req.query.country || '').trim();
      const page = Math.max(safeInt(req.query.page, 1), 1);
      const limit = 20;
      const skip = (page - 1) * limit;

      const status = rawStatus.toLowerCase();
      const filter = {};

      if (status && status !== 'all') {
        filter['verification.status'] = new RegExp(`^${escapeRegex(status)}$`, 'i');
      }

      if (country) {
        filter.country = new RegExp(`^${escapeRegex(country)}$`, 'i');
      }

      if (q) {
        const qRe = new RegExp(escapeRegex(q), 'i');
        filter.$or = [
          { name: qRe },
          { email: qRe },
          { officialNumber: qRe },
          { internalBusinessId: qRe },
        ];
      }

      const [items, total] = await Promise.all([
        Business.find(filter)
          .select(
            'name email role country officialNumber officialNumberType verification createdAt internalBusinessId ' +
              'bankDetails.accountHolderName bankDetails.bankName bankDetails.accountNumber',
          )
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Business.countDocuments(filter),
      ]);

      const maskedItems = (items || []).map((b) => {
        const acc = String(b?.bankDetails?.accountNumber || '');
        const last4 = acc ? acc.slice(-4) : '';
        return {
          ...b,
          bankDetails: {
            ...(b.bankDetails || {}),
            accountNumberLast4: last4 ? `****${last4}` : '—',
            accountNumber: undefined,
          },
        };
      });

      const totalPages = Math.max(Math.ceil(total / limit), 1);

      return res.render('admin-business-verifications', {
        title: '✅ Business Number Verifications',
        active: 'admin-business-verifications',
        items: maskedItems,
        filters: { status, q, country, page, totalPages, total },
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      return next(err);
    }
  }
);

// -------------------------------
// GET: Single business review page
// /admin/business-verifications/:id
// -------------------------------
router.get(
  '/business-verifications/:id',
  requireAdmin,
  requireAdminRole(['super_admin', 'verification_admin']),
  requireAdminPermission('verification.read'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid business id.');
        return res.redirect('/admin/business-verifications');
      }

      const business = await Business.findById(id)
        .select(
          'name email role country officialNumber officialNumberType verification createdAt updatedAt internalBusinessId ' +
          'bankDetails.accountHolderName bankDetails.bankName bankDetails.accountNumber bankDetails.branchCode bankDetails.updatedAt ' +
          'bankDetails.payoutMethod bankDetails.currency'
        )
        .lean();

      if (!business) {
        req.flash('error', 'Business not found.');
        return res.redirect('/admin/business-verifications');
      }

      const bd = business.bankDetails || {};
      const acc = String(bd.accountNumber || '').replace(/\s+/g, '');
      const last4 = acc ? acc.slice(-4) : '';

      const bankAdmin = {
        accountHolderName: bd.accountHolderName || '—',
        bankName: bd.bankName || '—',
        branchCode: bd.branchCode || '—',
        accountNumberMasked: last4 ? `****${last4}` : '—',
        updatedAt: bd.updatedAt || null,
        payoutMethod: bd.payoutMethod || 'bank',
        currency: bd.currency || '—',
      };

      return res.render('admin-business-verification-show', {
        title: `Review: ${business.name}`,
        active: 'admin-business-verifications',
        business,
        bankAdmin,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      return next(err);
    }
  }
);

// -------------------------------
// POST: Approve verification
// -------------------------------
router.post(
  '/business-verifications/:id/approve',
  requireAdmin,
  requireAdminRole(['super_admin', 'verification_admin']),
  requireAdminPermission('verification.review'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid business id.');
        return res.redirect('/admin/business-verifications');
      }

      const beforeDoc = await Business.findById(id)
        .select('name email role country officialNumber officialNumberType verification internalBusinessId')
        .lean();

      if (!beforeDoc) {
        req.flash('error', 'Business not found.');
        return res.redirect('/admin/business-verifications');
      }

      const now = new Date();
      const reason = String(req.body.reason || '').trim() || 'Approved by admin';

      const updated = await Business.findByIdAndUpdate(
        id,
        {
          $set: {
            'verification.status': 'verified',
            'verification.method': 'manual',
            'verification.provider': 'manual',
            'verification.checkedAt': now,
            'verification.verifiedAt': now,
            'verification.reason': reason,
          },
        },
        { new: true },
      )
        .select('name email officialNumber officialNumberType verification internalBusinessId role country')
        .lean();

      if (!updated) {
        req.flash('error', 'Business not found.');
        return res.redirect('/admin/business-verifications');
      }

      const baseUrl = getBaseUrl(req);
      let emailSent = false;
      let emailError = '';

      try {
        await sendOfficialNumberVerifiedEmail(updated, baseUrl);
        emailSent = true;
      } catch (mailErr) {
        emailError = String(mailErr?.response?.body || mailErr?.message || mailErr || '').slice(0, 500);
        console.error(
          '❌ OfficialNumber verified email failed:',
          mailErr?.response?.body || mailErr?.message || mailErr,
        );
        req.flash('warning', 'Approved, but email could not be sent (check SendGrid/SMTP env).');
      }

      await logAdminAction(req, {
        action: 'verification.business.approve',
        entityType: 'business',
        entityId: String(updated._id),
        status: 'success',
        before: verificationSnapshot(beforeDoc),
        after: verificationSnapshot(updated),
        meta: {
          section: 'business_verifications',
          reason,
          emailSent,
          emailError,
          businessName: updated.name || '',
          businessEmail: updated.email || '',
          officialNumberType: updated.officialNumberType || '',
          internalBusinessId: updated.internalBusinessId || '',
        },
      });

      req.flash('success', `✅ Approved verification for ${updated.name}.`);
      return res.redirect(`/admin/business-verifications/${updated._id}`);
    } catch (err) {
      return next(err);
    }
  }
);

// -------------------------------
// POST: Reject verification
// -------------------------------
router.post(
  '/business-verifications/:id/reject',
  requireAdmin,
  requireAdminRole(['super_admin', 'verification_admin']),
  requireAdminPermission('verification.review'),
  async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid business id.');
        return res.redirect('/admin/business-verifications');
      }

      const reason = String(req.body.reason || '').trim();
      if (!reason) {
        req.flash('error', 'Please provide a reason for rejection.');
        return res.redirect(`/admin/business-verifications/${id}`);
      }

      const beforeDoc = await Business.findById(id)
        .select('name email role country officialNumber officialNumberType verification internalBusinessId')
        .lean();

      if (!beforeDoc) {
        req.flash('error', 'Business not found.');
        return res.redirect('/admin/business-verifications');
      }

      const now = new Date();

      const updated = await Business.findByIdAndUpdate(
        id,
        {
          $set: {
            'verification.status': 'rejected',
            'verification.method': 'manual',
            'verification.provider': 'manual',
            'verification.checkedAt': now,
            'verification.verifiedAt': null,
            'verification.reason': reason,
          },
        },
        { new: true },
      )
        .select('name email officialNumber officialNumberType verification internalBusinessId role country')
        .lean();

      if (!updated) {
        req.flash('error', 'Business not found.');
        return res.redirect('/admin/business-verifications');
      }

      const baseUrl = getBaseUrl(req);
      let emailSent = false;
      let emailError = '';

      try {
        await sendOfficialNumberRejectedEmail(updated, baseUrl, reason);
        emailSent = true;
      } catch (mailErr) {
        emailError = String(mailErr?.response?.body || mailErr?.message || mailErr || '').slice(0, 500);
        console.error(
          '❌ OfficialNumber rejected email failed:',
          mailErr?.response?.body || mailErr?.message || mailErr,
        );
        req.flash('warning', 'Rejected, but email could not be sent (check SendGrid/SMTP env).');
      }

      await logAdminAction(req, {
        action: 'verification.business.reject',
        entityType: 'business',
        entityId: String(updated._id),
        status: 'success',
        before: verificationSnapshot(beforeDoc),
        after: verificationSnapshot(updated),
        meta: {
          section: 'business_verifications',
          reason,
          emailSent,
          emailError,
          businessName: updated.name || '',
          businessEmail: updated.email || '',
          officialNumberType: updated.officialNumberType || '',
          internalBusinessId: updated.internalBusinessId || '',
        },
      });

      req.flash('success', `❌ Rejected verification for ${updated.name}.`);
      return res.redirect(`/admin/business-verifications/${updated._id}`);
    } catch (err) {
      return next(err);
    }
  }
);

module.exports = router;