// routes/adminPayouts.js
'use strict';

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
} = require('../utils/payouts/createPaypalPayoutBatch');

const router = express.Router();

/* -----------------------------
 * Helpers
 * --------------------------- */

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
}

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function toMoneyString(cents) {
  // cents can be number/string, allow 0, but always return "0.00"
  const n = Number(cents || 0);
  const safe = Number.isFinite(n) ? n : 0;
  return (Math.round(safe) / 100).toFixed(2);
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

function payoutSnapshot(payout) {
  if (!payout) return null;

  const items = Array.isArray(payout.items) ? payout.items : [];

  return {
    payoutId: String(payout._id || ''),
    mode: payout.mode || '',
    senderBatchId: payout.senderBatchId || '',
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

/* -----------------------------
 * Cron guard (unchanged)
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
 * Core payout logic (shared)
 * --------------------------- */

async function runCreatePayoutBatch({
  createdByAdminId = null,
  minCents = 0,
  note = 'Seller payout',
  senderBatchPrefix = 'payout',
}) {
  const baseCurrency = getBaseCurrency();
  const cur = baseCurrency;
  const min = Math.max(0, Number(minCents || 0));
  const noteClean = String(note || 'Seller payout').trim() || 'Seller payout';

  const sellers = await Business.find({
    role: 'seller',
    'payouts.enabled': true,
    'payouts.paypalEmail': { $exists: true, $ne: '' },
  })
    .select('_id name payouts.paypalEmail')
    .lean();

  const payItems = [];
  let totalCents = 0;

  // Sequential is okay for small seller counts; optimize later if needed.
  for (const s of sellers) {
    const available = await getSellerAvailableCents(s._id, cur);
    if (available >= min && available > 0) {
      payItems.push({
        businessId: s._id,
        receiver: normEmail(s?.payouts?.paypalEmail),
        amountCents: Number(available || 0),
        currency: cur,
      });
      totalCents += Number(available || 0);
    }
  }

  if (!payItems.length) {
    return {
      ok: true,
      skippedReason: 'no-eligible-sellers',
      payoutId: null,
      batchId: null,
      count: 0,
      totalCents: 0,
    };
  }

  const mode = String(process.env.PAYPAL_MODE || 'sandbox').toUpperCase();
  const senderBatchId = `${senderBatchPrefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

  // One active creation per currency
  const runKey = `RUNLOCK:${cur}`;

  let payoutDoc;
  try {
    payoutDoc = await Payout.create({
      createdByAdminId,
      mode,
      senderBatchId,
      runKey,
      currency: cur,
      totalCents,
      status: 'CREATED',
      note: noteClean,
      items: payItems.map((it) => ({
        businessId: it.businessId,
        receiver: it.receiver,
        amountCents: it.amountCents,
        currency: it.currency,
        status: 'PENDING',
      })),
      meta: { paypalBase: getPayPalBase() },
    });
  } catch (e) {
    if (isDupKey(e)) {
      return {
        ok: false,
        error: 'payout-run-already-in-progress',
        message: `Another payout run is already starting for ${cur}. Please wait and refresh.`,
      };
    }
    throw e;
  }

  // Create PayPal batch (if this fails, mark payout FAILED + release lock)
  let paypalRes = null;
  try {
    paypalRes = await createPayoutBatch({
      senderBatchId,
      emailSubject: 'You have received a payout',
      emailMessage: 'You have received a payout from Unicoporate.com.',
      items: payItems.map((it) => ({
        receiver: normEmail(it.receiver),
        amount: toMoneyString(it.amountCents),
        currency: it.currency,
        note: noteClean,
        senderItemId: `${payoutDoc._id}-${String(it.businessId)}`, // used later in sync
      })),
    });
  } catch (e) {
    await Payout.updateOne(
      { _id: payoutDoc._id },
      {
        $set: {
          status: 'FAILED',
          meta: { ...(payoutDoc.meta || {}), createError: String(e?.message || e) },
        },
        $unset: { runKey: 1 },
      }
    );
    throw e;
  }

  const batchId = paypalRes?.batch_header?.payout_batch_id || null;

  await Payout.updateOne(
    { _id: payoutDoc._id },
    {
      $set: { batchId, status: 'PROCESSING' },
      $unset: { runKey: 1 },
    }
  );

  // Race-safe idempotent payout debits (no findOne+create)
  const debitRows = payItems
    .map((it) => {
      const businessObjId = new mongoose.Types.ObjectId(String(it.businessId));
      const uniqueKey = `payoutdebit:${String(payoutDoc._id)}:${String(it.businessId)}:${cur}`;

      return {
        businessId: businessObjId,
        type: 'PAYOUT_DEBIT',
        amountCents: -Math.abs(Number(it.amountCents || 0)),
        currency: cur,
        payoutId: payoutDoc._id,
        orderId: payoutDoc._id, // intentional: matches your unique index shape
        note: `Payout initiated: ${batchId || senderBatchId}`,
        meta: { senderBatchId, batchId, uniqueKey },
      };
    })
    .filter((r) => r.amountCents < 0);

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
    } catch (e) {
      // harmless duplicate races
      if (!isDupKey(e)) throw e;
    }
  }

  return {
    ok: true,
    payoutId: String(payoutDoc._id),
    batchId,
    count: payItems.length,
    totalCents,
  };
}

/* -----------------------------
 * Admin UI routes (manual)
 * --------------------------- */

router.get(
  '/payouts',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.read'),
  async (req, res) => {
    try {
      const payouts = await Payout.find({})
        .sort({ createdAt: -1 })
        .limit(30)
        .lean();

      const totalBatches = payouts.length;

      let totalPaidOutCents = 0;
      for (const p of payouts) {
        const items = Array.isArray(p.items) ? p.items : [];
        for (const it of items) {
          if (String(it.status || '').toUpperCase() === 'SENT') {
            totalPaidOutCents += Math.max(0, Number(it.amountCents || 0));
          }
        }
      }

      const baseCurrency = getBaseCurrency();
      const currencyPreview = baseCurrency;

      const sellers = await Business.find({ role: 'seller' })
        .select('_id name payouts.enabled payouts.paypalEmail')
        .lean();

      const preview = [];
      let previewEligibleCount = 0;
      let previewEligibleTotalCents = 0;

      for (const s of sellers) {
        const enabled = Boolean(s?.payouts?.enabled);
        const paypalEmail = normEmail(s?.payouts?.paypalEmail);
        const hasPaypal = Boolean(paypalEmail);

        let availableCents = 0;
        if (enabled && hasPaypal) {
          availableCents = await getSellerAvailableCents(s._id, currencyPreview);

          console.log('[admin/payouts preview seller]', {
            sellerName: s.name,
            businessId: String(s._id),
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
          businessId: String(s._id),
          name: s.name || '—',
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
        totalPaidOut: totalPaidOutCents ? toMoneyString(totalPaidOutCents) : '—',
        lastStatus: payouts[0]?.status || '—',
        previewCurrency: currencyPreview,
        eligibleSellers: previewEligibleCount,
        eligibleTotal: previewEligibleTotalCents ? toMoneyString(previewEligibleTotalCents) : '0.00',
      };

      return res.render('admin-payouts', {
        title: 'Seller Payouts',
        nonce: resNonce(req),
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
  }
);

/**
 * POST /admin/payouts/create (manual admin click)
 * Supports autoSync checkbox from UI.
 */
router.post(
  '/payouts/create',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.approve'),
  async (req, res) => {
    const minCents = Math.max(0, Number(req.body.minCents || 0));
    const note = String(req.body.note || 'Seller payout').trim();
    const autoSyncRaw = String(req.body.autoSync || '').trim().toLowerCase();
    const autoSync =
      autoSyncRaw === '1' ||
      autoSyncRaw === 'true' ||
      autoSyncRaw === 'yes' ||
      autoSyncRaw === 'on';

    try {
      const out = await runCreatePayoutBatch({
        createdByAdminId: safeObjectId(req.session?.admin?._id) || null,
        minCents,
        note,
        senderBatchPrefix: 'payout',
      });

      if (!out.ok && out.error === 'payout-run-already-in-progress') {
        await logAdminAction(req, {
          action: 'payout.batch.create_blocked',
          entityType: 'payout',
          entityId: '',
          status: 'failure',
          meta: {
            section: 'payouts',
            reason: out.error,
            message: out.message || '',
            minCents,
            note,
            autoSync,
          },
        });

        req.flash('warning', out.message || 'Another payout run is already in progress.');
        return res.redirect('/admin/payouts');
      }

      if (out.ok && out.skippedReason === 'no-eligible-sellers') {
        await logAdminAction(req, {
          action: 'payout.batch.create_skipped',
          entityType: 'payout',
          entityId: '',
          status: 'success',
          meta: {
            section: 'payouts',
            reason: out.skippedReason,
            minCents,
            note,
            autoSync,
          },
        });

        req.flash('info', 'No sellers are eligible for payout yet.');
        return res.redirect('/admin/payouts');
      }

      let syncAttempted = false;
      let syncSuccess = false;
      let syncError = '';

      // Best-effort immediate sync
      if (autoSync && out.payoutId) {
        syncAttempted = true;

        try {
          await runSyncPayoutById(out.payoutId);
          syncSuccess = true;

          await logAdminAction(req, {
            action: 'payout.batch.create',
            entityType: 'payout',
            entityId: String(out.payoutId),
            status: 'success',
            after: {
              payoutId: String(out.payoutId),
              batchId: out.batchId || '',
              count: Number(out.count || 0),
              totalCents: Number(out.totalCents || 0),
              totalAmount: toMoneyString(out.totalCents || 0),
              currency: getBaseCurrency(),
            },
            meta: {
              section: 'payouts',
              minCents,
              note,
              autoSync,
              syncAttempted,
              syncSuccess,
            },
          });

          req.flash('success', `Payout batch created + synced (${out.count} sellers).`);
        } catch (e) {
          syncError = String(e?.message || e || '').slice(0, 500);

          await logAdminAction(req, {
            action: 'payout.batch.create',
            entityType: 'payout',
            entityId: String(out.payoutId),
            status: 'success',
            after: {
              payoutId: String(out.payoutId),
              batchId: out.batchId || '',
              count: Number(out.count || 0),
              totalCents: Number(out.totalCents || 0),
              totalAmount: toMoneyString(out.totalCents || 0),
              currency: getBaseCurrency(),
            },
            meta: {
              section: 'payouts',
              minCents,
              note,
              autoSync,
              syncAttempted,
              syncSuccess,
              syncError,
            },
          });

          req.flash('warning', `Payout created (${out.count} sellers) but sync failed: ${e.message}`);
        }

        return res.redirect('/admin/payouts');
      }

      await logAdminAction(req, {
        action: 'payout.batch.create',
        entityType: 'payout',
        entityId: String(out.payoutId || ''),
        status: 'success',
        after: {
          payoutId: String(out.payoutId || ''),
          batchId: out.batchId || '',
          count: Number(out.count || 0),
          totalCents: Number(out.totalCents || 0),
          totalAmount: toMoneyString(out.totalCents || 0),
          currency: getBaseCurrency(),
        },
        meta: {
          section: 'payouts',
          minCents,
          note,
          autoSync,
          syncAttempted,
          syncSuccess,
        },
      });

      req.flash('success', `Payout batch created (${out.count} sellers).`);
      return res.redirect('/admin/payouts');
    } catch (err) {
      console.error(err);

      await logAdminAction(req, {
        action: 'payout.batch.create',
        entityType: 'payout',
        entityId: '',
        status: 'failure',
        meta: {
          section: 'payouts',
          minCents,
          note,
          autoSync,
          error: String(err?.message || err || '').slice(0, 500),
        },
      });

      req.flash('error', `Payout create failed: ${err.message}`);
      return res.redirect('/admin/payouts');
    }
  }
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

      const out = await runSyncPayoutById(payoutId);

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

      req.flash('success', 'Payout sync complete (failed items credited back automatically).');
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
  }
);

/**
 * Admin-only helper: sync recent batches (no cron secret)
 * POST /admin/payouts/sync-recent
 */
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

      for (const p of recent) {
        const r = await runSyncPayoutById(p._id);
        syncedPayouts.push({
          payoutId: String(p._id),
          batchId: p.batchId || '',
          beforeStatus: p.status || '',
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
  }
);

/* -----------------------------
 * AUTO payouts routes (Cron) (unchanged)
 * --------------------------- */

router.post('/payouts/auto-run', requireCronSecret, async (_req, _res) => { /* unchanged */ });
router.post('/payouts/auto-sync-recent', requireCronSecret, async (_req, _res) => { /* unchanged */ });

router.get(
  '/payouts/_ping',
  requireAdmin,
  requireAdminRole(['super_admin', 'payout_admin']),
  requireAdminPermission('payouts.read'),
  (req, res) => {
    res.send('payouts route OK');
  }
);

module.exports = router;