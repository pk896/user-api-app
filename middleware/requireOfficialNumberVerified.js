// middleware/requireOfficialNumberVerified.js
'use strict';

const mongoose = require('mongoose');
const Business = require('../models/Business');

const VERIFIED_STATUS = 'verified';

function normalizeStatus(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function wantsJson(req) {
  const acceptedType = String(req.get('accept') || '').toLowerCase();

  return (
    req.xhr === true ||
    acceptedType.includes('application/json') ||
    req.is('application/json')
  );
}

function sendJsonOrRedirect(
  req,
  res,
  {
    statusCode,
    flashType,
    message,
    redirectTo,
  },
) {
  if (wantsJson(req)) {
    return res.status(statusCode).json({
      success: false,
      message,
      redirectTo,
    });
  }

  if (typeof req.flash === 'function') {
    req.flash(flashType, message);
  }

  return res.redirect(redirectTo);
}

function getBusinessIdFromRequest(req) {
  const candidates = [
    req.business?._id,
    req.business?.id,
    req.session?.businessId,
    req.session?.business?._id,
    req.session?.business?.id,
  ];

  for (const candidate of candidates) {
    const id = String(candidate || '').trim();

    if (id) {
      return id;
    }
  }

  return '';
}

function clearBusinessSession(req) {
  if (!req.session) return;

  delete req.session.business;
  delete req.session.businessId;
}

function buildSafeSessionBusiness(business, currentSessionBusiness = {}) {
  return {
    ...currentSessionBusiness,

    _id: String(business._id),
    id: String(business._id),

    name: String(business.name || '').trim(),
    email: String(business.email || '').trim(),
    role: String(business.role || '').trim(),

    officialNumber: String(
      business.officialNumber || '',
    ).trim(),

    officialNumberType: String(
      business.officialNumberType || 'OTHER',
    ).trim(),

    isVerified: business.isVerified === true,

    verification: {
      ...(currentSessionBusiness.verification || {}),

      status:
        normalizeStatus(business.verification?.status) ||
        'unverified',

      method: String(
        business.verification?.method || 'manual',
      ).trim(),

      provider: String(
        business.verification?.provider || 'manual',
      ).trim(),

      checkedAt:
        business.verification?.checkedAt || null,

      verifiedAt:
        business.verification?.verifiedAt || null,

      reason: String(
        business.verification?.reason || '',
      ).trim(),

      updatedAt:
        business.verification?.updatedAt || null,
    },
  };
}

module.exports = async function requireOfficialNumberVerified(
  req,
  res,
  next,
) {
  try {
    const businessId = getBusinessIdFromRequest(req);

    if (!businessId) {
      return sendJsonOrRedirect(req, res, {
        statusCode: 401,
        flashType: 'error',
        message: 'Please log in to continue.',
        redirectTo: '/business/login',
      });
    }

    if (!mongoose.isValidObjectId(businessId)) {
      clearBusinessSession(req);

      return sendJsonOrRedirect(req, res, {
        statusCode: 401,
        flashType: 'error',
        message: 'Your business session is invalid. Please log in again.',
        redirectTo: '/business/login',
      });
    }

    /*
     * Verification must always come from MongoDB.
     *
     * Do not trust req.business or req.session.business as the
     * authority because session information can become stale after
     * an administrator verifies or rejects a business.
     */
    const business = await Business.findById(businessId)
      .select([
        '_id',
        'name',
        'email',
        'role',
        'officialNumber',
        'officialNumberType',
        'verification',
        'isVerified',
      ])
      .lean()
      .exec();

    if (!business) {
      clearBusinessSession(req);

      return sendJsonOrRedirect(req, res, {
        statusCode: 401,
        flashType: 'error',
        message: 'Business account not found. Please log in again.',
        redirectTo: '/business/login',
      });
    }

    /*
     * Refresh the current request and session with the latest
     * database-backed business information.
     *
     * Downstream middleware such as requireRole('supplier') will
     * continue to receive the correct role.
     */
    req.business = business;

    if (req.session) {
      req.session.businessId = String(business._id);

      req.session.business = buildSafeSessionBusiness(
        business,
        req.session.business || {},
      );
    }

    res.locals.business =
      req.session?.business || business;

    const verificationStatus = normalizeStatus(
      business.verification?.status,
    );

    if (verificationStatus !== VERIFIED_STATUS) {
      let message =
        'Your business registration number has not been verified yet.';

      if (verificationStatus === 'pending') {
        message =
          'Your business registration number is still pending verification. Please wait for admin approval.';
      }

      if (verificationStatus === 'rejected') {
        message =
          business.verification?.reason
            ? `Your business registration number was rejected: ${String(
                business.verification.reason,
              ).trim()}`
            : 'Your business registration number was rejected. Please review your verification details.';
      }

      return sendJsonOrRedirect(req, res, {
        statusCode: 403,
        flashType:
          verificationStatus === 'rejected'
            ? 'error'
            : 'warning',
        message,
        redirectTo: '/business/verify-pending',
      });
    }

    return next();
  } catch (err) {
    console.error(
      '❌ requireOfficialNumberVerified middleware error:',
      {
        message: err?.message || String(err),
        businessId: getBusinessIdFromRequest(req) || null,
        method: req.method,
        path: req.originalUrl,
      },
    );

    return sendJsonOrRedirect(req, res, {
      statusCode: 503,
      flashType: 'error',
      message:
        'We could not confirm your business-number verification right now. Please try again.',
      redirectTo: '/business/verify-pending',
    });
  }
};
