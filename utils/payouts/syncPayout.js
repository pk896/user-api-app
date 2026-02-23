// utils/payouts/syncPayout.js
'use strict';

const mongoose = require('mongoose');
const Payout = require('../../models/Payout');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');
const { getPayoutBatch } = require('./createPaypalPayoutBatch');

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function toMoneyString(cents) {
  return (Math.round(Number(cents || 0)) / 100).toFixed(2);
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

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
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
    const receiver = String(ri?.payout_item?.receiver || '').toLowerCase().trim();
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
    if (receiver && currency && value) {
      byFallbackKey.set(`${receiver}|${currency}|${value}`, normalized);
    }
  }

  const updates = [];
  const creditBacks = [];

  for (const local of payout.items || []) {
    const receiver = String(local.receiver || '').toLowerCase().trim();
    const value = toMoneyString(local.amountCents);
    const currency = String(local.currency || payout.currency || getBaseCurrency()).toUpperCase().trim();

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

  // ✅ Race-safe idempotent credit-backs (failed payout items)
  const creditRows = creditBacks
    .map((cb) => ({
      businessId: new mongoose.Types.ObjectId(String(cb.businessId)),
      type: 'ADJUSTMENT',
      amountCents: Math.abs(Number(cb.amountCents || 0)),
      currency: String(cb.currency || payout.currency || getBaseCurrency()).toUpperCase(),
      payoutId: payout._id,
      orderId: payout._id, // ✅ intentional: matches your unique index shape
      note: cb.note,
      meta: cb.meta,
    }))
    .filter((r) => r.amountCents > 0);

  if (creditRows.length) {
    const creditOps = creditRows.map((row) => ({
      updateOne: {
        filter: {
          businessId: row.businessId,
          type: 'ADJUSTMENT',
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

    let upsertedCount = 0;
    try {
      const wr = await SellerBalanceLedger.bulkWrite(creditOps, { ordered: false });
      upsertedCount = Number(wr?.upsertedCount || 0);
    } catch (e) {
      // ✅ Duplicate races are harmless (another sync inserted first)
      if (!isDupKey(e)) throw e;
      upsertedCount = 0;
    }

    credited = upsertedCount;
  }

  return {
    ok: true,
    payoutId: String(payout._id),
    status: newPayoutStatus,
    creditedBackCount: credited,
  };
}

module.exports = { runSyncPayoutById };