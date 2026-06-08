// routes/adminPayouts.js
'use strict';

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const Business = require('../models/Business');
const Payout = require('../models/Payout');
const SellerBalanceLedger = require('../models/SellerBalanceLedger');

const { getSellerAvailableCents } = require('../utils/payouts/getSellerAvailableCents');
const { runSyncPayoutById } = require('../utils/payouts/syncPayout');
const {
  createPayoutBatch,
  getPayPalBase,
  paypalHealthCheck,
} = require('../utils/payouts/createPaypalPayoutBatch');

const router = express.Router();

/* -----------------------------
 * Helpers
 * --------------------------- */

function isDupKey(err) {
  return !!(err && (err.code === 11000 || String(err.message || '').includes('E11000')));
}

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function getPayPalMode() {
  return String(process.env.PAYPAL_MODE || 'sandbox').trim().toUpperCase() === 'LIVE'
    ? 'LIVE'
    : 'SANDBOX';
}

function toMoneyString(cents) {
  const n = Number(cents || 0);
  const safe = Number.isFinite(n) ? n : 0;
  return (Math.round(safe) / 100).toFixed(2);
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonthsAgo(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - Number(months || 0));
  d.setHours(0, 0, 0, 0);
  return d;
}

async function sumSentPayoutItemsSince(startDate, currency) {
  const rows = await Payout.aggregate([
    {
      $match: {
        currency,
        items: {
          $elemMatch: {
            status: 'SENT',
            paidAt: { $gte: startDate },
          },
        },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.status': 'SENT',
        'items.paidAt': { $gte: startDate },
        'items.currency': currency,
      },
    },
    {
      $group: {
        _id: null,
        totalCents: { $sum: '$items.amountCents' },
      },
    },
  ]);

  return Math.max(0, Number(rows?.[0]?.totalCents || 0));
}

function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}

function maskEmail(email = '') {
  const [name, domain] = String(email || '').split('@');
  if (!name || !domain) return email;

  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];

  const parts = domain.split('.');
  const domName = parts[0] || '';
  const domExt = parts.slice(1).join('.') || '';

  const maskedDomain =
    domName.length <= 2
      ? (domName[0] || '*') + '*'
      : domName[0] + '*'.repeat(Math.max(1, domName.length - 2)) + domName[domName.length - 1];

  return `${maskedName}@${maskedDomain}${domExt ? '.' + domExt : ''}`;
}

function safeObjectId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function cleanNote(v) {
  return String(v || 'Seller payout').trim().slice(0, 255) || 'Seller payout';
}

function parseMinCents(v) {
  const n = Number(v || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

function parseBoolean(v) {
  const s = String(v || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(s);
}

function makeHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function makeSenderBatchId(prefix, fingerprint) {
  const safePrefix = String(prefix || 'payout').replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'payout';
  return `${safePrefix}-${Date.now()}-${String(fingerprint || '').slice(0, 12)}`.slice(0, 127);
}

function makePayPalRequestId(senderBatchId) {
  return makeHash(`paypal-request:${senderBatchId}`).slice(0, 32);
}

function getFingerprintWindow() {
  // 10-minute window prevents accidental double-click / repeated review duplicates,
  // but still allows a future legitimate payout with the same amount set later.
  return Math.floor(Date.now() / (10 * 60 * 1000));
}

function makePayoutFingerprint({ currency, minCents, items }) {
  const stableItems = (Array.isArray(items) ? items : [])
    .map((item) => ({
      businessId: String(item.businessId || ''),
      amountCents: Number(item.amountCents || 0),
      currency: String(item.currency || currency || '').toUpperCase(),
      receiverHash: makeHash(normEmail(item.receiver)).slice(0, 16),
    }))
    .sort((a, b) => a.businessId.localeCompare(b.businessId));

  return makeHash(
    JSON.stringify({
      kind: 'payout-review-v1',
      mode: getPayPalMode(),
      currency,
      minCents,
      window: getFingerprintWindow(),
      items: stableItems,
    }),
  );
}

function payoutSnapshot(payout) {
  if (!payout) return null;

  const items = Array.isArray(payout.items) ? payout.items : [];

  return {
    payoutId: String(payout._id || ''),
    mode: payout.mode || '',
    approvalStatus: payout.approvalStatus || '',
    senderBatchId: payout.senderBatchId || '',
    paypalRequestId: payout.paypalRequestId || '',
    batchId: payout.batchId || '',
    currency: payout.currency || '',
    totalCents: Number(payout.totalCents || 0),
    totalAmount: toMoneyString(payout.totalCents || 0),
    status: payout.status || '',
    note: payout.note || '',
    itemCount: items.length,
    itemStatusCounts: items.reduce((acc, item) => {
      const status = String(item.status || 'UNKNOWN').toUpperCase();
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}),
    createdAt: payout.createdAt || null,
    updatedAt: payout.updatedAt || null,
  };
}

function syncResultSnapshot(out) {
  if (!out) return null;

  return {
    ok: !!out.ok,
    error: out.error || '',
    message: out.message || '',
    status: out.status || '',
    payoutId: out.payoutId ? String(out.payoutId) : '',
    batchId: out.batchId || '',
    count: Number(out.count || 0),
    totalCents: Number(out.totalCents || 0),
  };
}

function assertProductionPayoutLimits({ totalCents, items }) {
  const maxBatchCents = Number(process.env.PAYOUTS_MAX_BATCH_CENTS || 0);
  const maxItemCents = Number(process.env.PAYOUTS_MAX_ITEM_CENTS || 0);

  if (Number.isFinite(maxBatchCents) && maxBatchCents > 0 && totalCents > maxBatchCents) {
    throw new Error(
      `Payout batch total is above PAYOUTS_MAX_BATCH_CENTS. Total=${totalCents}, limit=${maxBatchCents}`,
    );
  }

  if (Number.isFinite(maxItemCents) && maxItemCents > 0) {
    const over = (items || []).find((item) => Number(item.amountCents || 0) > maxItemCents);

    if (over) {
      throw new Error(
        `A payout item is above PAYOUTS_MAX_ITEM_CENTS. businessId=${String(
          over.businessId,
        )}, amountCents=${Number(over.amountCents || 0)}, limit=${maxItemCents}`,
      );
    }
  }
}

/* -----------------------------
 * Cron guard
 * --------------------------- */

function requireCronSecret(req, res, next) {
  const secret = String(process.env.PAYOUTS_CRON_SECRET || '').trim();
  if (!secret) {
    return res.status(503).send('Cron secret not configured (PAYOUTS_CRON_SECRET).');
  }

  const header = String(req.headers['x-cron-secret'] || '').trim();
  const query = String(req.query.secret || '').trim();

  if (header === secret || query === secret) return next();
  return res.status(401).send('Unauthorized cron request.');
}

/* -----------------------------
 * Core payout preview/review logic
 * --------------------------- */

async function buildEligiblePayoutItems({ minCents = 0, currency = getBaseCurrency() }) {
  const cur = String(currency || getBaseCurrency()).trim().toUpperCase() || getBaseCurrency();
  const min = parseMinCents(minCents);

  const payoutBusinesses = await Business.find({
    role: { $in: ['seller', 'supplier'] },
    'payouts.enabled': true,
    'payouts.paypalEmail': { $exists: true, $ne: '' },
  })
    .select('_id name role payouts.paypalEmail')
    .lean();

  const items = [];
  let totalCents = 0;

  for (const business of payoutBusinesses) {
    const receiver = normEmail(business?.payouts?.paypalEmail);
    const available = await getSellerAvailableCents(business._id, cur);

    if (receiver && available >= min && available > 0) {
      const amountCents = Number(available || 0);

      items.push({
        businessId: business._id,
        businessName: business.name || '—',
        role: business.role || 'business',
        receiver,
        receiverMasked: maskEmail(receiver),
        amountCents,
        currency: cur,
      });

      totalCents += amountCents;
    }
  }

  items.sort((a, b) => String(a.businessId).localeCompare(String(b.businessId)));

  return {
    currency: cur,
    minCents: min,
    items,
    totalCents,
  };
}

async function createPayoutReview({
  req,
  createdByAdminId = null,
  minCents = 0,
  note = 'Seller payout',
}) {
  const noteClean = cleanNote(note);
  const review = await buildEligiblePayoutItems({ minCents, currency: getBaseCurrency() });

  if (!review.items.length) {
    return {
      ok: true,
      skippedReason: 'no-eligible-businesses',
      payoutId: null,
      count: 0,
      totalCents: 0,
    };
  }

  assertProductionPayoutLimits({
    totalCents: review.totalCents,
    items: review.items,
  });

  const fingerprint = makePayoutFingerprint({
    currency: review.currency,
    minCents: review.minCents,
    items: review.items,
  });

  const fingerprintExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

  let payoutDoc = null;

  try {
    payoutDoc = await Payout.create({
      createdByAdminId,
      mode: getPayPalMode(),
      currency: review.currency,
      totalCents: review.totalCents,
      status: 'CREATED',
      approvalStatus: 'REVIEWED',
      note: noteClean,
      fingerprint,
      fingerprintExpiresAt,
      items: review.items.map((item) => ({
        businessId: item.businessId,
        receiver: item.receiver,
        amountCents: item.amountCents,
        currency: item.currency,
        status: 'PENDING',
      })),
      meta: {
        paypalBase: getPayPalBase(),
        reviewCreatedAt: new Date(),
        reviewMinCents: review.minCents,
        reviewItemCount: review.items.length,
        reviewRoles: [...new Set(review.items.map((item) => item.role || 'business'))],
        reviewReceiversMasked: review.items.map((item) => ({
          businessId: String(item.businessId),
          businessName: item.businessName,
          role: item.role,
          receiverMasked: item.receiverMasked,
          amountCents: item.amountCents,
          currency: item.currency,
        })),
      },
    });
  } catch (err) {
    if (isDupKey(err)) {
      const existing = await Payout.findOne({
        fingerprint,
        approvalStatus: { $in: ['REVIEWED', 'CONFIRMED', 'SUBMITTED'] },
        batchId: { $exists: false },
      })
        .sort({ createdAt: -1 })
        .lean();

      if (existing) {
        return {
          ok: true,
          duplicateReview: true,
          payoutId: String(existing._id),
          count: Array.isArray(existing.items) ? existing.items.length : 0,
          totalCents: Number(existing.totalCents || 0),
        };
      }

      return {
        ok: false,
        error: 'duplicate-payout-review',
        message: 'A matching payout review already exists. Refresh the payout page.',
      };
    }

    throw err;
  }

  await logAdminAction(req, {
    action: 'payout.review.created',
    entityType: 'payout',
    entityId: String(payoutDoc._id),
    status: 'success',
    after: payoutSnapshot(payoutDoc),
    meta: {
      section: 'payouts',
      minCents: review.minCents,
      note: noteClean,
      fingerprint,
      count: review.items.length,
      totalCents: review.totalCents,
      totalAmount: toMoneyString(review.totalCents),
      currency: review.currency,
    },
  });

  return {
    ok: true,
    payoutId: String(payoutDoc._id),
    count: review.items.length,
    totalCents: review.totalCents,
  };
}

async function confirmPayoutReview({
  req,
  payoutId,
  confirmedByAdminId = null,
  autoSync = false,
}) {
  if (!mongoose.isValidObjectId(payoutId)) {
    return { ok: false, error: 'invalid-payout-id' };
  }

  const existing = await Payout.findById(payoutId);

  if (!existing) {
    return { ok: false, error: 'payout-not-found' };
  }

  if (existing.batchId) {
    return {
      ok: true,
      alreadySubmitted: true,
      payoutId: String(existing._id),
      batchId: existing.batchId,
      count: Array.isArray(existing.items) ? existing.items.length : 0,
      totalCents: Number(existing.totalCents || 0),
    };
  }

  if (!['REVIEWED', 'CONFIRMED'].includes(String(existing.approvalStatus || '').toUpperCase())) {
    return {
      ok: false,
      error: 'payout-not-reviewable',
      message: `This payout cannot be confirmed because approvalStatus is ${existing.approvalStatus || '—'}.`,
    };
  }

  const items = Array.isArray(existing.items) ? existing.items : [];

  if (!items.length) {
    return { ok: false, error: 'payout-has-no-items' };
  }

  const totalCents = Number(existing.totalCents || 0);

  assertProductionPayoutLimits({
    totalCents,
    items,
  });

  const runKey = `RUNLOCK:${String(existing.currency || getBaseCurrency()).toUpperCase()}`;
  const staleLockCutoff = new Date(Date.now() - 5 * 60 * 1000);

  const staleLockResult = await Payout.updateMany(
    {
      runKey,
      status: { $in: ['CREATED', 'FAILED'] },
      createdAt: { $lte: staleLockCutoff },
    },
    {
      $unset: { runKey: 1 },
      $set: {
        'meta.staleRunKeyClearedAt': new Date(),
        'meta.staleRunKeyClearedReason': 'Cleared before confirming a payout batch',
      },
    },
  );

  if (Number(staleLockResult?.modifiedCount || 0) > 0) {
    console.warn('[admin payouts confirm] cleared stale payout run locks', {
      runKey,
      clearedCount: staleLockResult.modifiedCount,
    });
  }

  const senderBatchId =
    existing.senderBatchId || makeSenderBatchId('payout', existing.fingerprint || String(existing._id));

  const paypalRequestId =
    existing.paypalRequestId || makePayPalRequestId(senderBatchId);

  const locked = await Payout.findOneAndUpdate(
    {
      _id: existing._id,
      batchId: { $exists: false },
      approvalStatus: { $in: ['REVIEWED', 'CONFIRMED'] },
      $or: [
        { runKey: { $exists: false } },
        { runKey: null },
        { runKey: '' },
      ],
    },
    {
      $set: {
        runKey,
        senderBatchId,
        paypalRequestId,
        confirmedByAdminId,
        confirmedAt: new Date(),
        approvalStatus: 'CONFIRMED',
        status: 'CREATED',
        'meta.confirmStartedAt': new Date(),
      },
    },
    { new: true },
  );

  if (!locked) {
    return {
      ok: false,
      error: 'payout-confirm-already-in-progress',
      message: 'This payout is already being confirmed. Refresh the page before trying again.',
    };
  }

  console.log('[admin payouts confirm] local payout locked before PayPal call', {
    payoutId: String(locked._id),
    senderBatchId,
    paypalRequestId,
    currency: locked.currency,
    itemCount: items.length,
    totalCents,
  });

  let paypalRes = null;

  try {
    paypalRes = await createPayoutBatch({
      senderBatchId,
      paypalRequestId,
      emailSubject: 'You have received a Kasyora payout',
      emailMessage:
        'You have received a payout from Kasyora for seller or supplier earnings.',
      items: items.map((item) => ({
        receiver: normEmail(item.receiver),
        amount: toMoneyString(item.amountCents),
        currency: item.currency || locked.currency || getBaseCurrency(),
        note: locked.note || 'Seller payout',
        senderItemId: `${locked._id}-${String(item.businessId)}`,
      })),
    });
  } catch (err) {
    console.error('[admin payouts confirm] PayPal create failed', {
      payoutId: String(locked._id),
      message: String(err?.message || err),
      status: err?.status || null,
      paypal: err?.paypal || null,
      senderBatchId,
      paypalRequestId,
    });

    await Payout.updateOne(
      { _id: locked._id },
      {
        $set: {
          status: 'FAILED',
          approvalStatus: 'FAILED',
          meta: {
            ...(locked.meta || {}),
            createError: String(err?.message || err).slice(0, 1000),
            createErrorAt: new Date(),
            createErrorStatus: err?.status || null,
            createErrorPaypal: err?.paypal || null,
            senderBatchId,
            paypalRequestId,
          },
        },
        $unset: { runKey: 1 },
      },
    );

    await logAdminAction(req, {
      action: 'payout.confirm.paypal_failed',
      entityType: 'payout',
      entityId: String(locked._id),
      status: 'failure',
      before: payoutSnapshot(existing),
      meta: {
        section: 'payouts',
        error: String(err?.message || err || '').slice(0, 500),
        senderBatchId,
        paypalRequestId,
      },
    });

    throw err;
  }

  const batchId = paypalRes?.batch_header?.payout_batch_id || '';

  await Payout.updateOne(
    { _id: locked._id },
    {
      $set: {
        batchId,
        status: 'PROCESSING',
        approvalStatus: 'SUBMITTED',
        senderBatchId: paypalRes?.senderBatchId || senderBatchId,
        paypalRequestId: paypalRes?.paypalRequestId || paypalRequestId,
        meta: {
          ...(locked.meta || {}),
          submittedAt: new Date(),
          batchId,
          senderBatchId: paypalRes?.senderBatchId || senderBatchId,
          paypalRequestId: paypalRes?.paypalRequestId || paypalRequestId,
        },
      },
      $unset: { runKey: 1 },
    },
  );

  const debitRows = items
    .map((item) => {
      const businessObjId = new mongoose.Types.ObjectId(String(item.businessId));
      const uniqueKey = `payoutdebit:${String(locked._id)}:${String(item.businessId)}:${locked.currency}`;

      return {
        businessId: businessObjId,
        type: 'PAYOUT_DEBIT',
        amountCents: -Math.abs(Number(item.amountCents || 0)),
        currency: locked.currency || getBaseCurrency(),
        payoutId: locked._id,
        orderId: locked._id,
        note: `Payout initiated: ${batchId || senderBatchId}`,
        meta: { senderBatchId, paypalRequestId, batchId, uniqueKey },
      };
    })
    .filter((row) => row.amountCents < 0);

  if (debitRows.length) {
    const debitOps = debitRows.map((row) => ({
      updateOne: {
        filter: {
          businessId: row.businessId,
          type: 'PAYOUT_DEBIT',
          orderId: row.orderId,
          'meta.uniqueKey': row.meta.uniqueKey,
        },
        update: {
          $setOnInsert: {
            amountCents: row.amountCents,
            currency: row.currency,
            payoutId: row.payoutId,
            note: row.note,
            meta: row.meta,
          },
        },
        upsert: true,
      },
    }));

    try {
      await SellerBalanceLedger.bulkWrite(debitOps, { ordered: false });
    } catch (err) {
      if (!isDupKey(err)) throw err;
    }
  }

  let syncAttempted = false;
  let syncSuccess = false;
  let syncError = '';

  if (autoSync) {
    syncAttempted = true;

    try {
      await runSyncPayoutById(locked._id, { source: 'manual' });
      syncSuccess = true;
    } catch (err) {
      syncError = String(err?.message || err).slice(0, 500);
    }
  }

  const afterDoc = await Payout.findById(locked._id).lean();

  await logAdminAction(req, {
    action: 'payout.confirm.submitted',
    entityType: 'payout',
    entityId: String(locked._id),
    status: 'success',
    before: payoutSnapshot(existing),
    after: payoutSnapshot(afterDoc),
    meta: {
      section: 'payouts',
      batchId,
      senderBatchId,
      paypalRequestId,
      autoSync,
      syncAttempted,
      syncSuccess,
      syncError,
    },
  });

  return {
    ok: true,
    payoutId: String(locked._id),
    batchId,
    count: items.length,
    totalCents,
    syncAttempted,
    syncSuccess,
    syncError,
  };
}

/* -----------------------------
 * Admin UI routes
 * --------------------------- */

router.get(
  '/payouts',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.read'),
  async (req, res) => {
    try {
      const payouts = await Payout.find({}).sort({ createdAt: -1 }).limit(30).lean();
      const totalBatches = await Payout.countDocuments({});

      const currencyPreview = getBaseCurrency();

      const paidOutTodayCents = await sumSentPayoutItemsSince(startOfToday(), currencyPreview);

      const paidOutLast30DaysCents = await sumSentPayoutItemsSince(
        startOfDaysAgo(30),
        currencyPreview,
      );

      const paidOutLast12MonthsCents = await sumSentPayoutItemsSince(
        startOfMonthsAgo(12),
        currencyPreview,
      );

      const sellers = await Business.find({ role: { $in: ['seller', 'supplier'] } })
        .select('_id name role payouts.enabled payouts.paypalEmail')
        .lean();

      const preview = [];
      let previewEligibleCount = 0;
      let previewEligibleTotalCents = 0;

      for (const seller of sellers) {
        const enabled = Boolean(seller?.payouts?.enabled);
        const paypalEmail = normEmail(seller?.payouts?.paypalEmail);
        const hasPaypal = Boolean(paypalEmail);

        let availableCents = 0;

        if (enabled && hasPaypal) {
          availableCents = await getSellerAvailableCents(seller._id, currencyPreview);

          console.log('[admin/payouts preview business]', {
            sellerName: seller.name,
            businessId: String(seller._id),
            enabled,
            hasPaypal,
            paypalEmail: paypalEmail ? '[set]' : '[missing]',
            currencyPreview,
            availableCents,
          });
        }

        const eligible = enabled && hasPaypal && availableCents > 0;

        if (eligible) {
          previewEligibleCount += 1;
          previewEligibleTotalCents += Math.max(0, Number(availableCents || 0));
        }

        preview.push({
          businessId: String(seller._id),
          name: seller.name || '—',
          role: seller.role || 'business',
          enabled,
          paypalEmailMasked: hasPaypal ? maskEmail(paypalEmail) : '',
          hasPaypal,
          availableCents: Number(availableCents || 0),
          eligible,
        });
      }

      preview.sort((a, b) => (b.availableCents || 0) - (a.availableCents || 0));

      const kpis = {
        totalBatches,

        paidOutToday: toMoneyString(paidOutTodayCents),
        paidOutLast30Days: toMoneyString(paidOutLast30DaysCents),
        paidOutLast12Months: toMoneyString(paidOutLast12MonthsCents),

        lastStatus: payouts[0]?.status || '—',
        previewCurrency: currencyPreview,
        eligibleSellers: previewEligibleCount,
        eligibleTotal: previewEligibleTotalCents
          ? toMoneyString(previewEligibleTotalCents)
          : '0.00',
      };

      return res.render('admin-payouts', {
        title: 'Seller Payouts',
        nonce: resNonce(req),
        fullWidthPage: true,
        payouts,
        kpis,
        previewSellers: preview,
        success: req.flash?.('success') || [],
        error: req.flash?.('error') || [],
        info: req.flash?.('info') || [],
        warning: req.flash?.('warning') || [],
      });
    } catch (err) {
      console.error(err);
      req.flash('error', `Failed to load payouts: ${err.message}`);
      return res.redirect('/admin/dashboard');
    }
  },
);

/**
 * POST /admin/payouts/review
 * Creates a local REVIEWED payout only.
 * It does NOT call PayPal and does NOT debit balances.
 */
router.post(
  '/payouts/review',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.approve'),
  async (req, res) => {
    const minCents = parseMinCents(req.body.minCents);
    const note = cleanNote(req.body.note);

    try {
      const out = await createPayoutReview({
        req,
        createdByAdminId: safeObjectId(req.session?.admin?._id) || null,
        minCents,
        note,
      });

      if (out.ok && out.skippedReason === 'no-eligible-businesses') {
        await logAdminAction(req, {
          action: 'payout.review.skipped',
          entityType: 'payout',
          entityId: '',
          status: 'success',
          meta: {
            section: 'payouts',
            reason: out.skippedReason,
            minCents,
            note,
          },
        });

        req.flash('info', 'No sellers or suppliers are eligible for payout yet.');
        return res.redirect('/admin/payouts');
      }

      if (out.duplicateReview) {
        req.flash(
          'info',
          `A payout review already exists. Review it in payout history before confirming. Total: ${toMoneyString(
            out.totalCents,
          )} ${getBaseCurrency()}.`,
        );
        return res.redirect('/admin/payouts');
      }

      if (!out.ok) {
        req.flash('error', out.message || 'Failed to create payout review.');
        return res.redirect('/admin/payouts');
      }

      req.flash(
        'success',
        `Payout review prepared for ${out.count} businesses. Check the payout history and click Confirm & Pay when ready.`,
      );

      return res.redirect('/admin/payouts');
    } catch (err) {
      console.error('[admin payouts route] payout review failed', {
        message: String(err?.message || err),
      });

      await logAdminAction(req, {
        action: 'payout.review.created',
        entityType: 'payout',
        entityId: '',
        status: 'failure',
        meta: {
          section: 'payouts',
          minCents,
          note,
          error: String(err?.message || err || '').slice(0, 500),
        },
      });

      req.flash('error', `Payout review failed: ${err.message}`);
      return res.redirect('/admin/payouts');
    }
  },
);

/**
 * POST /admin/payouts/:id/confirm
 * This is the ONLY manual route that calls PayPal.
 */
router.post(
  '/payouts/:id/confirm',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.approve'),
  async (req, res) => {
    const payoutId = String(req.params.id || '').trim();
    const autoSync = parseBoolean(req.body.autoSync);

    try {
      const out = await confirmPayoutReview({
        req,
        payoutId,
        confirmedByAdminId: safeObjectId(req.session?.admin?._id) || null,
        autoSync,
      });

      if (!out.ok) {
        await logAdminAction(req, {
          action: 'payout.confirm.blocked',
          entityType: 'payout',
          entityId: payoutId,
          status: 'failure',
          meta: {
            section: 'payouts',
            result: out,
          },
        });

        req.flash('error', out.message || `Payout confirmation failed: ${out.error || 'unknown'}`);
        return res.redirect('/admin/payouts');
      }

      if (out.alreadySubmitted) {
        req.flash('info', 'This payout was already submitted to PayPal.');
        return res.redirect('/admin/payouts');
      }

      if (out.syncAttempted && out.syncSuccess) {
        req.flash('success', `Payout submitted and synced (${out.count} businesses).`);
      } else if (out.syncAttempted && !out.syncSuccess) {
        req.flash(
          'warning',
          `Payout submitted (${out.count} businesses), but immediate sync failed: ${out.syncError || 'unknown'}. Webhook/manual sync can still update it.`,
        );
      } else {
        req.flash('success', `Payout submitted to PayPal (${out.count} businesses).`);
      }

      return res.redirect('/admin/payouts');
    } catch (err) {
      console.error('[admin payouts route] payout confirm failed', {
        payoutId,
        message: String(err?.message || err),
        status: err?.status || null,
        paypal: err?.paypal || null,
      });

      await logAdminAction(req, {
        action: 'payout.confirm.submitted',
        entityType: 'payout',
        entityId: payoutId,
        status: 'failure',
        meta: {
          section: 'payouts',
          error: String(err?.message || err || '').slice(0, 500),
          paypal: err?.paypal || null,
        },
      });

      req.flash('error', `Payout confirmation failed: ${err.message}`);
      return res.redirect('/admin/payouts');
    }
  },
);

/**
 * Old one-click route is intentionally blocked.
 */
router.post(
  '/payouts/create',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.approve'),
  async (req, res) => {
    await logAdminAction(req, {
      action: 'payout.batch.create_blocked',
      entityType: 'payout',
      entityId: '',
      status: 'failure',
      meta: {
        section: 'payouts',
        reason: 'review-required',
      },
    });

    req.flash(
      'warning',
      'For production safety, one-click Auto Pay is disabled. First create a payout review, then confirm it.',
    );

    return res.redirect('/admin/payouts');
  },
);

router.post(
  '/payouts/:id/sync',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.reconcile'),
  async (req, res) => {
    try {
      const payoutId = req.params.id;

      const beforeDoc = mongoose.isValidObjectId(payoutId)
        ? await Payout.findById(payoutId).lean()
        : null;

      const out = await runSyncPayoutById(payoutId, { source: 'manual' });

      const afterDoc = mongoose.isValidObjectId(payoutId)
        ? await Payout.findById(payoutId).lean()
        : null;

      if (!out.ok) {
        await logAdminAction(req, {
          action: 'payout.batch.sync',
          entityType: 'payout',
          entityId: String(payoutId || ''),
          status: 'failure',
          before: payoutSnapshot(beforeDoc),
          after: payoutSnapshot(afterDoc),
          meta: {
            section: 'payouts',
            result: syncResultSnapshot(out),
          },
        });

        req.flash('error', `Payout sync failed: ${out.error}`);
        return res.redirect('/admin/payouts');
      }

      await logAdminAction(req, {
        action: 'payout.batch.sync',
        entityType: 'payout',
        entityId: String(payoutId || ''),
        status: 'success',
        before: payoutSnapshot(beforeDoc),
        after: payoutSnapshot(afterDoc),
        meta: {
          section: 'payouts',
          result: syncResultSnapshot(out),
        },
      });

      req.flash('success', 'Payout sync complete.');
      return res.redirect('/admin/payouts');
    } catch (err) {
      console.error(err);

      await logAdminAction(req, {
        action: 'payout.batch.sync',
        entityType: 'payout',
        entityId: String(req.params.id || ''),
        status: 'failure',
        meta: {
          section: 'payouts',
          error: String(err?.message || err || '').slice(0, 500),
        },
      });

      req.flash('error', `Payout sync failed: ${err.message}`);
      return res.redirect('/admin/payouts');
    }
  },
);

router.post(
  '/payouts/sync-recent',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.reconcile'),
  async (req, res) => {
    const limit = Math.max(1, Math.min(30, Number(req.body.limit || 10)));

    try {
      const recent = await Payout.find({
        status: { $in: ['CREATED', 'PROCESSING', 'FAILED'] },
        batchId: { $exists: true, $ne: '' },
      })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select('_id status batchId')
        .lean();

      let okCount = 0;
      let failCount = 0;
      const syncedPayouts = [];

      for (const payout of recent) {
        const r = await runSyncPayoutById(payout._id, { source: 'manual' });

        syncedPayouts.push({
          payoutId: String(payout._id),
          batchId: payout.batchId || '',
          beforeStatus: payout.status || '',
          ok: !!r.ok,
          error: r.error || '',
        });

        if (r.ok) okCount += 1;
        else failCount += 1;
      }

      await logAdminAction(req, {
        action: 'payout.batch.sync_recent',
        entityType: 'payout',
        entityId: '',
        status: failCount > 0 ? 'failure' : 'success',
        meta: {
          section: 'payouts',
          limit,
          checkedCount: recent.length,
          okCount,
          failCount,
          syncedPayouts,
        },
      });

      req.flash('success', `Synced recent batches: ok=${okCount}, failed=${failCount}.`);
      return res.redirect('/admin/payouts');
    } catch (err) {
      console.error(err);

      await logAdminAction(req, {
        action: 'payout.batch.sync_recent',
        entityType: 'payout',
        entityId: '',
        status: 'failure',
        meta: {
          section: 'payouts',
          limit,
          error: String(err?.message || err || '').slice(0, 500),
        },
      });

      req.flash('error', `Sync recent failed: ${err.message}`);
      return res.redirect('/admin/payouts');
    }
  },
);

/* -----------------------------
 * AUTO payout routes
 * --------------------------- */

router.post('/payouts/auto-run', requireCronSecret, async (_req, res) => {
  return res.status(409).json({
    ok: false,
    message:
      'Auto-run direct payout creation is disabled for production safety. Use review + confirm flow.',
  });
});

router.post('/payouts/auto-sync-recent', requireCronSecret, async (_req, res) => {
  const limit = 10;

  try {
    const recent = await Payout.find({
      status: { $in: ['CREATED', 'PROCESSING', 'FAILED'] },
      batchId: { $exists: true, $ne: '' },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .select('_id status batchId')
      .lean();

    let okCount = 0;
    let failCount = 0;

    for (const payout of recent) {
      const out = await runSyncPayoutById(payout._id, { source: 'cron' });
      if (out.ok) okCount += 1;
      else failCount += 1;
    }

    return res.json({
      ok: true,
      checkedCount: recent.length,
      okCount,
      failCount,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      message: String(err?.message || err),
    });
  }
});

router.get(
  '/payouts/_paypal-health',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.read'),
  async (_req, res) => {
    try {
      const out = await paypalHealthCheck();

      return res.json({
        ok: true,
        message: 'PayPal connection is working.',
        ...out,
      });
    } catch (err) {
      console.error('[admin payouts paypal health] failed', {
        message: String(err?.message || err),
        status: err?.status || null,
        paypal: err?.paypal || null,
      });

      return res.status(500).json({
        ok: false,
        message: String(err?.message || err),
        status: err?.status || null,
        paypal: err?.paypal || null,
      });
    }
  },
);

router.get(
  '/payouts/_ping',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.read'),
  (_req, res) => {
    res.send('payouts route OK');
  },
);

module.exports = router;