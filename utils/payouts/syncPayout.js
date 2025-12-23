// utils/payouts/syncPayout.js
'use strict';

const mongoose = require('mongoose');
const Payout = require('../../models/Payout');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');
const { getPayoutBatch } = require('./createPaypalPayoutBatch');

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

    const normalized = { senderItemId, receiver, value, currency, payoutItemId, txStatus, errMsg };

    if (senderItemId) bySenderItem.set(senderItemId, normalized);
    byFallbackKey.set(`${receiver}|${currency}|${value}`, normalized);
  }

  const updates = [];
  const creditBacks = [];

  for (const local of payout.items || []) {
    const receiver = String(local.receiver || '').toLowerCase().trim();
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
      amountCents: cb.amountCents,
      currency: cb.currency,
      payoutId: payout._id,
      note: cb.note,
      meta: cb.meta,
    });

    credited += 1;
  }

  return { ok: true, payoutId: String(payout._id), status: newPayoutStatus, creditedBackCount: credited };
}

module.exports = { runSyncPayoutById };
