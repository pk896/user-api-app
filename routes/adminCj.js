// routes/adminCj.js
'use strict';

const express = require('express');

const CjApiCredential = require('../models/CjApiCredential');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const { logAdminAction } = require('../utils/logAdminAction');

const { CJ_API_ENABLED, CJ_API_KEY, CJ_API_BASE_URL, maskSecret } = require('../utils/cj/cjConfig');

const { requestNewAccessToken, forceRefreshAccessToken } = require('../utils/cj/cjTokenManager');

const { cjRequest } = require('../utils/cj/cjClient');

const router = express.Router();

/*
 * CJ API credentials are sensitive.
 *
 * Do not use router.use(requireAdmin...) globally in this file.
 * If this router is mounted globally in server.js, a global router.use()
 * can accidentally protect public pages like store pages.
 *
 * Apply this gate only to the exact CJ API/admin credential routes below.
 */
const requireCjApiAdmin = [
  requireAdmin,
  requireAdminRole(['super_admin']),
  requireAdminPermission('cj.manage'),
];

function safeError(error) {
  return {
    code: String(error?.code || 'CJ_ERROR')
      .trim()
      .slice(0, 100),
    message: String(error?.message || 'CJ request failed.')
      .trim()
      .slice(0, 1000),
    requestId: String(error?.requestId || '')
      .trim()
      .slice(0, 200),
  };
}

async function loadCredentialSummary() {
  const credential = await CjApiCredential.findOne({
    provider: 'CJ',
  }).lean();

  return credential || null;
}

router.get('/admin/cj', requireCjApiAdmin, async (req, res) => {
  try {
    const credential = await loadCredentialSummary();

    return res.render('admin/cj/health', {
      layout: 'layout',
      title: 'CJ Dropshipping',
      active: 'admin-cj',
      fullWidthPage: true,

      cjConfig: {
        enabled: CJ_API_ENABLED,
        apiKeyConfigured: Boolean(CJ_API_KEY),
        apiKeyMasked: maskSecret(CJ_API_KEY),
        baseUrl: CJ_API_BASE_URL,
      },

      credential,
    });
  } catch (error) {
    console.error('[CJ admin] Health page failed:', error?.stack || error);

    req.flash('error', 'CJ admin page could not be loaded.');

    return res.redirect('/admin/dashboard');
  }
});

router.post('/admin/cj/authenticate', requireCjApiAdmin, async (req, res) => {
  try {
    /*
     * Remove only the previously stored CJ token values.
     * This does not affect products, orders, users, sellers,
     * suppliers, Shippo, Courier Guy, or PayPal.
     */
    await CjApiCredential.findOneAndUpdate(
      { provider: 'CJ' },
      {
        $set: {
          accessToken: '',
          refreshToken: '',
          accessTokenExpiresAt: null,
          refreshTokenExpiresAt: null,
          openId: '',
          lastRefreshedAt: null,
          lastErrorCode: '',
          lastErrorMessage: '',
          lastRequestId: '',
        },
        $setOnInsert: {
          provider: 'CJ',
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    await requestNewAccessToken();

    await logAdminAction(req, {
      action: 'cj.api.authenticate',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'success',
      meta: {
        provider: 'CJ',
        staleCredentialCleared: true,
      },
    });

    req.flash('success', 'Fresh CJ API credentials obtained successfully.');

    return res.redirect('/admin/cj');
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.api.authenticate',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'failure',
      meta: safe,
    });

    req.flash('error', `CJ authentication failed: ${safe.message}`);

    return res.redirect('/admin/cj');
  }
});

router.post('/admin/cj/refresh-token', requireCjApiAdmin, async (req, res) => {
  try {
    let operation = 'REFRESH';

    try {
      await forceRefreshAccessToken();
    } catch (refreshError) {
      const refreshErrorCode = String(refreshError?.code || '').trim();

      const refreshTokenRejected =
        refreshErrorCode === '1600003' ||
        refreshErrorCode === 'CJ_REFRESH_TOKEN_MISSING' ||
        refreshErrorCode === 'CJ_REFRESH_TOKEN_UNAVAILABLE';

      if (!refreshTokenRejected) {
        throw refreshError;
      }

      console.warn('[CJ admin] Refresh token rejected. Reauthenticating with the API key.');

      await requestNewAccessToken();
      operation = 'REAUTHENTICATE';
    }

    await logAdminAction(req, {
      action: 'cj.api.refresh-token',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'success',
      meta: {
        operation,
      },
    });

    if (operation === 'REAUTHENTICATE') {
      req.flash(
        'success',
        'CJ rejected the old refresh token, so Kasyora safely obtained new credentials using the API key.',
      );
    } else {
      req.flash('success', 'CJ access token refreshed successfully.');
    }

    return res.redirect('/admin/cj');
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.api.refresh-token',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'failure',
      meta: safe,
    });

    req.flash('error', `CJ token refresh failed: ${safe.message}`);

    return res.redirect('/admin/cj');
  }
});

router.post('/admin/cj/health-test', requireCjApiAdmin, async (req, res) => {
  const checkedAt = new Date();

  try {
    const response = await cjRequest('/product/getCategory');

    await CjApiCredential.findOneAndUpdate(
      { provider: 'CJ' },
      {
        $set: {
          lastHealthCheckAt: checkedAt,
          lastHealthCheckStatus: 'HEALTHY',
          lastErrorCode: '',
          lastErrorMessage: '',
          lastRequestId: String(response?.requestId || '')
            .trim()
            .slice(0, 200),
        },
        $setOnInsert: {
          provider: 'CJ',
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    await logAdminAction(req, {
      action: 'cj.api.health-test',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'success',
      meta: {
        requestId: String(response?.requestId || '').trim(),
      },
    });

    const categoryCount = Array.isArray(response?.data) ? response.data.length : 0;

    req.flash(
      'success',
      `CJ API connection is healthy. Kasyora received ${categoryCount} top-level CJ product categories.`,
    );

    return res.redirect('/admin/cj');
  } catch (error) {
    const safe = safeError(error);

    await CjApiCredential.findOneAndUpdate(
      { provider: 'CJ' },
      {
        $set: {
          lastHealthCheckAt: checkedAt,
          lastHealthCheckStatus: 'FAILED',
          lastErrorCode: safe.code,
          lastErrorMessage: safe.message,
          lastRequestId: safe.requestId,
        },
        $setOnInsert: {
          provider: 'CJ',
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    await logAdminAction(req, {
      action: 'cj.api.health-test',
      entityType: 'CjApiCredential',
      entityId: 'CJ',
      status: 'failure',
      meta: safe,
    });

    req.flash('error', `CJ health test failed: ${safe.message}`);

    return res.redirect('/admin/cj');
  }
});

module.exports = router;
