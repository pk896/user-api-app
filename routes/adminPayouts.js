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
  createPayoutBatch: createPayoutBatch,
  getPayoutBatch,
  getPayPalBase,
} = require('../utils/payouts/createPaypalPayoutBatch');


const router = express.Router();

function toMoneyString(cents) {
  return (Math.round(Number(cents || 0)) / 100).toFixed(2);
}

function normalizeTxStatus(s) {
  const v = String(s || '').trim().toUpperCase();
  // PayPal commonly uses these for payouts:
  // SUCCESS / FAILED / PENDING / RETURNED / BLOCKED / UNCLAIMED
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

/**
 * POST /admin/payouts/create
 * - pays all eligible sellers (role=seller, payouts.enabled=true, payouts.paypalEmail exists)
 * - debits their balances immediately (prevents double payouts)
 */
router.post('/payouts/create', requireAdmin, async (req, res) => {
  try {
    const currency = String(req.body.currency || 'USD').toUpperCase();
    const minCents = Math.max(0, Number(req.body.minCents || 0)); // example: 5000 = R50
    const note = String(req.body.note || 'Seller payout').trim();

    const sellers = await Business.find({
      role: 'seller',
      'payouts.enabled': true,
      'payouts.paypalEmail': { $exists: true, $ne: '' },
    })
      .select('_id name payouts.paypalEmail')
      .lean();

    const payItems = [];
    let totalCents = 0;

    for (const s of sellers) {
      const available = await getSellerAvailableCents(s._id, currency);
      if (available >= minCents && available > 0) {
        payItems.push({
          businessId: s._id,
          receiver: s.payouts.paypalEmail,
          amountCents: available,
          currency,
        });
        totalCents += available;
      }
    }

    if (!payItems.length) {
      req.flash('info', 'No sellers are eligible for payout yet.');
      return res.redirect('/admin/payouts');
    }

    const mode = String(process.env.PAYPAL_MODE || 'sandbox').toUpperCase();
    const senderBatchId = `payout-${Date.now()}`;

    const payoutDoc = await Payout.create({
      createdByAdminId: req.session?.admin?._id,
      mode,
      senderBatchId,
      currency,
      totalCents,
      status: 'CREATED',
      note,
      items: payItems.map((it) => ({
        businessId: it.businessId,
        receiver: it.receiver,
        amountCents: it.amountCents,
        currency,
      })),
      meta: { paypalBase: getPayPalBase() },
    });

    const paypalRes = await createPayoutBatch({
      senderBatchId,
      emailSubject: 'You have received a payout',
      emailMessage: 'You have received a payout from Phakisi Global.',
      items: payItems.map((it) => ({
        receiver: it.receiver,
        amount: toMoneyString(it.amountCents),
        currency: it.currency,
        note,
        senderItemId: `${payoutDoc._id}-${String(it.businessId)}`,
      })),
    });

    const batchId = paypalRes?.batch_header?.payout_batch_id;

    await Payout.updateOne(
      { _id: payoutDoc._id },
      { $set: { batchId, status: 'PROCESSING' } }
    );

    // Debit balances immediately so a second payout run can't double-pay.
    for (const it of payItems) {
      await SellerBalanceLedger.create({
        businessId: it.businessId,
        type: 'PAYOUT_DEBIT',
        amountCents: -Math.abs(it.amountCents),
        currency,
        payoutId: payoutDoc._id,
        note: `Payout initiated: ${batchId || senderBatchId}`,
        meta: { senderBatchId, batchId },
      });
    }

    req.flash('success', `Payout batch created (${payItems.length} sellers).`);
    return res.redirect('/admin/payouts');
  } catch (err) {
    console.error(err);
    req.flash('error', `Payout create failed: ${err.message}`);
    return res.redirect('/admin/payouts');
  }
});

/**
 * POST /admin/payouts/:id/sync
 * - pulls PayPal payout batch result
 * - updates each payout item (SENT/FAILED/PENDING)
 * - ✅ auto-credit-back for FAILED items (idempotent)
 */
router.post('/payouts/:id/sync', requireAdmin, async (req, res) => {
  try {
    const payoutId = req.params.id;
    if (!mongoose.isValidObjectId(payoutId)) {
      req.flash('error', 'Invalid payout id.');
      return res.redirect('/admin/payouts');
    }

    const payout = await Payout.findById(payoutId).lean();
    if (!payout) {
      req.flash('error', 'Payout not found.');
      return res.redirect('/admin/payouts');
    }

    if (!payout.batchId) {
      req.flash('error', 'This payout has no PayPal batchId yet.');
      return res.redirect('/admin/payouts');
    }

    const batch = await getPayoutBatch(payout.batchId);

    const batchStatus = batch?.batch_header?.batch_status;
    const newPayoutStatus = mapBatchStatus(batchStatus);

    // PayPal returns payout items in: batch.items[]
    const remoteItems = Array.isArray(batch?.items) ? batch.items : [];

    // Build a quick lookup by receiver+amount (safe enough if your sender_item_id isn't returned)
    // If sender_item_id is available, use it.
    const bySenderItem = new Map();
    const byFallbackKey = new Map();

    for (const ri of remoteItems) {
      const senderItemId = ri?.payout_item?.sender_item_id || '';
      const receiver = String(ri?.payout_item?.receiver || '').toLowerCase();
      const value = String(ri?.payout_item?.amount?.value || '');
      const currency = String(ri?.payout_item?.amount?.currency || '');

      const payoutItemId = ri?.payout_item_id || ri?.payout_item?.payout_item_id || '';
      const txStatus = ri?.transaction_status || ri?.payout_item?.transaction_status || '';
      const errMsg = ri?.errors?.message || ri?.errors?.name || '';

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
      byFallbackKey.set(`${receiver}|${currency}|${value}`, normalized);
    }

    const updates = [];
    const creditBacks = [];

    for (const local of payout.items || []) {
      const receiver = String(local.receiver || '').toLowerCase();
      const value = toMoneyString(local.amountCents);
      const currency = String(local.currency || payout.currency || 'USD').toUpperCase();

      // We used sender_item_id as `${payoutDoc._id}-${businessId}` when creating
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

      // ✅ Auto-credit-back on FAILED (idempotent)
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

    // Save payout item updates
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

    // Perform idempotent credit-backs:
    for (const cb of creditBacks) {
      // Has this credit-back already been created?
      const exists = await SellerBalanceLedger.findOne({
        payoutId: payout._id,
        type: 'ADJUSTMENT',
        'meta.uniqueKey': cb.uniqueKey,
      })
        .select('_id')
        .lean();

      if (exists) continue;

      await SellerBalanceLedger.create({
        businessId: cb.businessId,
        type: 'ADJUSTMENT',
        amountCents: cb.amountCents, // positive credit back
        currency: cb.currency,
        payoutId: payout._id,
        note: cb.note,
        meta: cb.meta,
      });
    }

    req.flash('success', 'Payout sync complete (failed items credited back automatically).');
    return res.redirect('/admin/payouts');
  } catch (err) {
    console.error(err);
    req.flash('error', `Payout sync failed: ${err.message}`);
    return res.redirect('/admin/payouts');
  }
});

module.exports = router;
