// routes/adminPayouts.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const requireAdmin = require('../middleware/requireAdmin');
const Business = require('../models/Business');
const Payout = require('../models/Payout');
const SellerBalanceLedger = require('../models/SellerBalanceLedger');

const { getSellerAvailableCents } = require('../utils/payouts/getSellerAvailableCents');
const {
  createPayoutBatch,
  getPayoutBatch,
  getPayPalBase,
} = require('../utils/payouts/createPaypalPayoutBatch');

const router = express.Router();

/* -----------------------------
 * Helpers
 * --------------------------- */

function toMoneyString(cents) {
  // cents can be number/string, allow 0, but always return "0.00"
  const n = Number(cents || 0);
  const safe = Number.isFinite(n) ? n : 0;
  return (Math.round(safe) / 100).toFixed(2);
}

function normalizeTxStatus(s) {
  const v = String(s || '').trim().toUpperCase();
  return v || 'PENDING';
}

function mapToItemStatus(txStatus) {
  const v = normalizeTxStatus(txStatus);
  if (v === 'SUCCESS') return 'SENT';
  if (v === 'FAILED' || v === 'RETURNED' || v === 'BLOCKED') return 'FAILED';
  return 'PENDING';
}

function mapBatchStatus(batchStatus) {
  const v = String(batchStatus || '').trim().toUpperCase();
  if (v === 'SUCCESS') return 'COMPLETED';
  if (v === 'DENIED' || v === 'FAILED') return 'FAILED';
  return 'PROCESSING';
}

// ✅ keep nonce consistent with your CSP setup
function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}

// ✅ mask paypal email for admin UI (still don’t print raw email everywhere)
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
  currency = 'USD',
  minCents = 0,
  note = 'Seller payout',
  senderBatchPrefix = 'payout',
}) {
  const cur = String(currency || 'USD').toUpperCase().trim() || 'USD';
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

  // ✅ sequential is okay for small seller counts; for large, optimize later
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

  const payoutDoc = await Payout.create({
    createdByAdminId,
    mode,
    senderBatchId,
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

  // ✅ Create PayPal batch (if this fails, mark the payout FAILED)
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
      }
    );
    throw e;
  }

  const batchId = paypalRes?.batch_header?.payout_batch_id || null;

  await Payout.updateOne(
    { _id: payoutDoc._id },
    { $set: { batchId, status: 'PROCESSING' } }
  );

  // ✅ IMPORTANT FIX:
  // Your SellerBalanceLedger unique index is:
  // { businessId, type, orderId, meta.uniqueKey } unique sparse
  // For payouts, orderId is NULL => multiple PAYOUT_DEBIT rows for same seller WOULD CONFLICT
  // if meta.uniqueKey is the same OR missing.
  //
  // ✅ So: we MUST include BOTH:
  // - payoutId: payoutDoc._id (for querying)
  // - orderId: payoutDoc._id (to satisfy uniqueness and avoid conflicts when orderId is null)
  //
  // This keeps idempotency per payout batch + seller.
  for (const it of payItems) {
    const uniqueKey = `payoutdebit:${String(payoutDoc._id)}:${String(it.businessId)}:${cur}`;

    const exists = await SellerBalanceLedger.findOne({
      businessId: it.businessId,
      type: 'PAYOUT_DEBIT',
      orderId: payoutDoc._id, // ✅ critical (see note above)
      'meta.uniqueKey': uniqueKey,
    })
      .select('_id')
      .lean();

    if (exists) continue;

    await SellerBalanceLedger.create({
      businessId: it.businessId,
      type: 'PAYOUT_DEBIT',
      amountCents: -Math.abs(it.amountCents),
      currency: cur,
      payoutId: payoutDoc._id,
      orderId: payoutDoc._id, // ✅ critical (see note above)
      note: `Payout initiated: ${batchId || senderBatchId}`,
      meta: { senderBatchId, batchId, uniqueKey },
    });
  }

  return {
    ok: true,
    payoutId: String(payoutDoc._id),
    batchId,
    count: payItems.length,
    totalCents,
  };
}

async function runSyncPayoutById(payoutId) {
  if (!mongoose.isValidObjectId(payoutId)) {
    return { ok: false, error: 'invalid-payout-id' };
  }

  const payout = await Payout.findById(payoutId).lean();
  if (!payout) return { ok: false, error: 'payout-not-found' };
  if (!payout.batchId) return { ok: false, error: 'no-batchId' };

  const batch = await getPayoutBatch(payout.batchId);

  const batchStatus = batch?.batch_header?.batch_status;
  const newPayoutStatus = mapBatchStatus(batchStatus);

  const remoteItems = Array.isArray(batch?.items) ? batch.items : [];

  const bySenderItem = new Map();
  const byFallbackKey = new Map();

  for (const ri of remoteItems) {
    const senderItemId = String(ri?.payout_item?.sender_item_id || '').trim();
    const receiver = normEmail(ri?.payout_item?.receiver);
    const value = String(ri?.payout_item?.amount?.value || '').trim();
    const currency = String(ri?.payout_item?.amount?.currency || '').toUpperCase().trim();

    const payoutItemId =
      String(ri?.payout_item_id || ri?.payout_item?.payout_item_id || '').trim();

    const txStatus =
      String(ri?.transaction_status || ri?.payout_item?.transaction_status || '').trim();

    const errMsg =
      String(ri?.errors?.message || ri?.errors?.name || '').trim();

    const normalized = {
      senderItemId,
      receiver,
      value,
      currency,
      payoutItemId,
      txStatus,
      errMsg,
    };

    if (senderItemId) bySenderItem.set(senderItemId, normalized);
    if (receiver && currency && value) byFallbackKey.set(`${receiver}|${currency}|${value}`, normalized);
  }

  const updates = [];
  const creditBacks = [];

  for (const local of payout.items || []) {
    const receiver = normEmail(local.receiver);
    const value = toMoneyString(local.amountCents);
    const currency = String(local.currency || payout.currency || 'USD').toUpperCase().trim();

    const senderItemIdGuess = `${payout._id}-${String(local.businessId)}`;

    const remote =
      bySenderItem.get(senderItemIdGuess) ||
      byFallbackKey.get(`${receiver}|${currency}|${value}`);

    const txStatus = remote?.txStatus || 'PENDING';
    const nextStatus = mapToItemStatus(txStatus);

    const paypalItemId = String(remote?.payoutItemId || local.paypalItemId || '').trim();
    const error = String(remote?.errMsg || local.error || '').trim();

    updates.push({
      businessId: local.businessId,
      receiver: local.receiver,
      amountCents: local.amountCents,
      currency: local.currency,
      status: nextStatus,
      paypalItemId,
      error,
    });

    if (nextStatus === 'FAILED') {
      const uniqueKey = `creditback:${String(payout._id)}:${String(local.businessId)}:${paypalItemId || receiver}|${value}|${currency}`;

      creditBacks.push({
        businessId: local.businessId,
        currency,
        amountCents: Math.abs(local.amountCents),
        uniqueKey,
        note: `Auto credit-back for failed payout (${payout.batchId})`,
        meta: {
          creditBackForPayout: true,
          uniqueKey,
          batchId: payout.batchId,
          paypalItemId,
          receiver,
          value,
          currency,
          txStatus: normalizeTxStatus(txStatus),
        },
      });
    }
  }

  await Payout.updateOne(
    { _id: payout._id },
    {
      $set: {
        status: newPayoutStatus,
        items: updates,
        meta: {
          ...(payout.meta || {}),
          lastSyncAt: new Date(),
          batchStatus: String(batchStatus || ''),
        },
      },
    }
  );

  let credited = 0;
  for (const cb of creditBacks) {
    // ✅ IMPORTANT FIX (same uniqueness issue):
    // ADJUSTMENT rows could also conflict if orderId is null.
    // We will store orderId=payout._id for payout-related adjustments as well.
    const exists = await SellerBalanceLedger.findOne({
      payoutId: payout._id,
      type: 'ADJUSTMENT',
      orderId: payout._id, // ✅ critical
      'meta.uniqueKey': cb.uniqueKey,
    })
      .select('_id')
      .lean();

    if (exists) continue;

    await SellerBalanceLedger.create({
      businessId: cb.businessId,
      type: 'ADJUSTMENT',
      amountCents: cb.amountCents,
      currency: cb.currency,
      payoutId: payout._id,
      orderId: payout._id, // ✅ critical
      note: cb.note,
      meta: cb.meta,
    });

    credited += 1;
  }

  return {
    ok: true,
    payoutId: String(payout._id),
    status: newPayoutStatus,
    creditedBackCount: credited,
  };
}

/* -----------------------------
 * Admin UI routes (manual)
 * --------------------------- */

router.get('/payouts', requireAdmin, async (req, res) => {
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

    // ✅ PREVIEW: show sellers and how much is available
    const currencyPreview = String(req.query.currency || 'USD').toUpperCase().trim() || 'USD';

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
});

/**
 * POST /admin/payouts/create (manual admin click)
 * ✅ Now supports autoSync checkbox from UI.
 */
router.post('/payouts/create', requireAdmin, async (req, res) => {
  try {
    const currency = String(req.body.currency || 'USD').toUpperCase();
    const minCents = Math.max(0, Number(req.body.minCents || 0));
    const note = String(req.body.note || 'Seller payout').trim();
    const autoSyncRaw = String(req.body.autoSync || '').trim().toLowerCase();
    const autoSync = autoSyncRaw === '1' || autoSyncRaw === 'true' || autoSyncRaw === 'yes' || autoSyncRaw === 'on';

    const out = await runCreatePayoutBatch({
      createdByAdminId: safeObjectId(req.session?.admin?._id) || null,
      currency,
      minCents,
      note,
      senderBatchPrefix: 'payout',
    });

    if (out.ok && out.skippedReason === 'no-eligible-sellers') {
      req.flash('info', 'No sellers are eligible for payout yet.');
      return res.redirect('/admin/payouts');
    }

    // ✅ Best-effort immediate sync
    if (autoSync && out.payoutId) {
      try {
        await runSyncPayoutById(out.payoutId);
        req.flash('success', `Payout batch created + synced (${out.count} sellers).`);
      } catch (e) {
        req.flash('warning', `Payout created (${out.count} sellers) but sync failed: ${e.message}`);
      }
      return res.redirect('/admin/payouts');
    }

    req.flash('success', `Payout batch created (${out.count} sellers).`);
    return res.redirect('/admin/payouts');
  } catch (err) {
    console.error(err);
    req.flash('error', `Payout create failed: ${err.message}`);
    return res.redirect('/admin/payouts');
  }
});

router.post('/payouts/:id/sync', requireAdmin, async (req, res) => {
  try {
    const payoutId = req.params.id;

    const out = await runSyncPayoutById(payoutId);
    if (!out.ok) {
      req.flash('error', `Payout sync failed: ${out.error}`);
      return res.redirect('/admin/payouts');
    }

    req.flash('success', 'Payout sync complete (failed items credited back automatically).');
    return res.redirect('/admin/payouts');
  } catch (err) {
    console.error(err);
    req.flash('error', `Payout sync failed: ${err.message}`);
    return res.redirect('/admin/payouts');
  }
});

/**
 * ✅ Admin-only helper: sync recent batches (no cron secret)
 * POST /admin/payouts/sync-recent
 */
router.post('/payouts/sync-recent', requireAdmin, async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(30, Number(req.body.limit || 10)));

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

    for (const p of recent) {
      const r = await runSyncPayoutById(p._id);
      if (r.ok) okCount += 1;
      else failCount += 1;
    }

    req.flash('success', `Synced recent batches: ok=${okCount}, failed=${failCount}.`);
    return res.redirect('/admin/payouts');
  } catch (err) {
    console.error(err);
    req.flash('error', `Sync recent failed: ${err.message}`);
    return res.redirect('/admin/payouts');
  }
});

/* -----------------------------
 * AUTO payouts routes (Cron) (unchanged)
 * --------------------------- */

router.post('/payouts/auto-run', requireCronSecret, async (_req, _res) => { /* unchanged */ });
router.post('/payouts/auto-sync-recent', requireCronSecret, async (_req, _res) => { /* unchanged */ });

router.get('/payouts/_ping', requireAdmin, (req, res) => {
  res.send('payouts route OK');
});

module.exports = router;
