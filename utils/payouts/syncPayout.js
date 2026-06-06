// utils/payouts/syncPayout.js
'use strict';

const crypto = require('crypto');
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

function safeStr(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function normalizeTxStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  return value || 'PENDING';
}

function normalizeBatchStatus(status) {
  const value = String(status || '').trim().toUpperCase();
  return value || 'PROCESSING';
}

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
}

function makeSyncLockKey(payoutId, source) {
  const raw = `${String(payoutId)}:${String(source || 'manual')}:${Date.now()}:${Math.random()}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function mapToItemStatus(txStatus) {
  const value = normalizeTxStatus(txStatus);

  if (value === 'SUCCESS') return 'SENT';

  if (
    value === 'FAILED' ||
    value === 'RETURNED' ||
    value === 'BLOCKED' ||
    value === 'DENIED' ||
    value === 'REVERSED' ||
    value === 'REFUNDED'
  ) {
    return 'FAILED';
  }

  if (value === 'UNCLAIMED') return 'UNCLAIMED';
  if (value === 'ONHOLD' || value === 'ON_HOLD') return 'ONHOLD';

  return 'PENDING';
}

function shouldCreditBack(txStatus) {
  const value = normalizeTxStatus(txStatus);

  // ✅ These are final/negative statuses where the seller/supplier should get their balance back.
  return (
    value === 'FAILED' ||
    value === 'RETURNED' ||
    value === 'BLOCKED' ||
    value === 'DENIED' ||
    value === 'REVERSED' ||
    value === 'REFUNDED'
  );
}

function mapBatchStatus(batchStatus, localItemStatuses = []) {
  const value = normalizeBatchStatus(batchStatus);
  const itemStatuses = localItemStatuses.map((s) => String(s || '').toUpperCase());

  if (value === 'SUCCESS') return 'COMPLETED';

  if (value === 'DENIED' || value === 'FAILED' || value === 'CANCELED') {
    return 'FAILED';
  }

  // If PayPal still says processing but every item is final, close it locally.
  if (itemStatuses.length && itemStatuses.every((s) => s === 'SENT')) {
    return 'COMPLETED';
  }

  if (itemStatuses.length && itemStatuses.every((s) => s === 'FAILED')) {
    return 'FAILED';
  }

  return 'PROCESSING';
}

function extractRemoteItem(row) {
  const payoutItem = row?.payout_item || {};

  const senderItemId = safeStr(payoutItem?.sender_item_id, 127);
  const receiver = safeStr(payoutItem?.receiver, 320).toLowerCase();
  const value = safeStr(payoutItem?.amount?.value, 64);
  const currency = safeStr(payoutItem?.amount?.currency, 12).toUpperCase();

  const payoutItemId = safeStr(row?.payout_item_id || payoutItem?.payout_item_id, 128);

  const txStatus = normalizeTxStatus(
    row?.transaction_status ||
      payoutItem?.transaction_status ||
      row?.payout_item_status ||
      payoutItem?.payout_item_status
  );

  const errMsg = safeStr(
    row?.errors?.message ||
      row?.errors?.name ||
      row?.errors?.details?.[0]?.issue ||
      row?.errors?.details?.[0]?.description ||
      ''
  );

  return {
    senderItemId,
    receiver,
    value,
    currency,
    payoutItemId,
    txStatus,
    errMsg,
  };
}

async function acquireSyncLock(payoutId, source) {
  const lockKey = makeSyncLockKey(payoutId, source);
  const now = new Date();
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000);

  const result = await Payout.updateOne(
    {
      _id: payoutId,
      $or: [
        { syncLockExpiresAt: { $exists: false } },
        { syncLockExpiresAt: null },
        { syncLockExpiresAt: { $lte: now } },
      ],
    },
    {
      $set: {
        syncLockKey: lockKey,
        syncLockExpiresAt: expiresAt,
      },
    }
  );

  if (Number(result.modifiedCount || 0) !== 1) {
    return { ok: false, reason: 'sync-already-running' };
  }

  return { ok: true, lockKey };
}

async function releaseSyncLock(payoutId, lockKey) {
  await Payout.updateOne(
    {
      _id: payoutId,
      syncLockKey: lockKey,
    },
    {
      $unset: {
        syncLockKey: 1,
        syncLockExpiresAt: 1,
      },
    }
  );
}

async function runSyncPayoutById(payoutId, opts = {}) {
  const source = String(opts.source || 'manual').trim().toLowerCase() || 'manual';
  const webhookEventId = safeStr(opts.webhookEventId || '', 128);

  if (!mongoose.isValidObjectId(payoutId)) {
    return { ok: false, error: 'invalid-payout-id' };
  }

  const payoutObjectId = new mongoose.Types.ObjectId(String(payoutId));

  const lock = await acquireSyncLock(payoutObjectId, source);
  if (!lock.ok) {
    return {
      ok: true,
      skipped: true,
      reason: lock.reason,
      payoutId: String(payoutObjectId),
    };
  }

  try {
    const payout = await Payout.findById(payoutObjectId).lean();

    if (!payout) {
      return { ok: false, error: 'payout-not-found' };
    }

    if (!payout.batchId) {
      return { ok: false, error: 'no-batchId' };
    }

    if (
      webhookEventId &&
      payout.lastWebhookEventId &&
      String(payout.lastWebhookEventId) === webhookEventId
    ) {
      return {
        ok: true,
        skipped: true,
        reason: 'duplicate-webhook-event',
        payoutId: String(payout._id),
      };
    }

    const batch = await getPayoutBatch(payout.batchId);

    const batchStatus = normalizeBatchStatus(batch?.batch_header?.batch_status);

    const remoteItems = Array.isArray(batch?.items) ? batch.items : [];
    const bySenderItem = new Map();
    const byFallbackKey = new Map();

    for (const remoteRow of remoteItems) {
      const remote = extractRemoteItem(remoteRow);

      if (remote.senderItemId) {
        bySenderItem.set(remote.senderItemId, remote);
      }

      if (remote.receiver && remote.currency && remote.value) {
        byFallbackKey.set(`${remote.receiver}|${remote.currency}|${remote.value}`, remote);
      }
    }

    const updates = [];
    const creditBacks = [];

    for (const local of payout.items || []) {
      const receiver = safeStr(local.receiver, 320).toLowerCase();
      const value = toMoneyString(local.amountCents);
      const currency = safeStr(local.currency || payout.currency || getBaseCurrency(), 12).toUpperCase();

      const senderItemIdGuess = `${payout._id}-${String(local.businessId)}`;

      const remote =
        bySenderItem.get(senderItemIdGuess) ||
        byFallbackKey.get(`${receiver}|${currency}|${value}`);

      const txStatus = normalizeTxStatus(remote?.txStatus || local.paypalTransactionStatus || 'PENDING');
      const nextStatus = mapToItemStatus(txStatus);

      const paypalItemId = safeStr(remote?.payoutItemId || local.paypalItemId || '', 128);
      const error = safeStr(remote?.errMsg || local.error || '', 500);

      const paidAt =
        nextStatus === 'SENT'
          ? local.paidAt || new Date()
          : local.paidAt || null;

      updates.push({
        businessId: local.businessId,
        receiver: local.receiver,
        amountCents: local.amountCents,
        currency: local.currency,
        status: nextStatus,
        paidAt,
        paypalItemId,
        error,
        paypalTransactionStatus: txStatus,
        lastSyncedAt: new Date(),
      });

      if (shouldCreditBack(txStatus)) {
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
            value,
            currency,
            txStatus,
          },
        });
      }
    }

    const newPayoutStatus = mapBatchStatus(
      batchStatus,
      updates.map((item) => item.status)
    );

    const now = new Date();

    const setFields = {
      status: newPayoutStatus,
      approvalStatus:
        newPayoutStatus === 'COMPLETED'
          ? 'COMPLETED'
          : (newPayoutStatus === 'FAILED' ? 'FAILED' : 'SUBMITTED'),
      items: updates,
      meta: {
        ...(payout.meta || {}),
        lastSyncAt: now,
        lastSyncSource: source,
        batchStatus,
        remoteItemCount: remoteItems.length,
      },
    };

    if (source === 'webhook') {
      setFields.lastAutoSyncAt = now;
      setFields.autoSyncAttempts = Number(payout.autoSyncAttempts || 0) + 1;
      setFields.lastWebhookAt = now;
      if (webhookEventId) setFields.lastWebhookEventId = webhookEventId;
    } else {
      setFields.lastManualSyncAt = now;
    }

    await Payout.updateOne(
      { _id: payout._id },
      {
        $set: setFields,
      }
    );

    let credited = 0;

    const creditRows = creditBacks
      .map((creditBack) => ({
        businessId: new mongoose.Types.ObjectId(String(creditBack.businessId)),
        type: 'ADJUSTMENT',
        amountCents: Math.abs(Number(creditBack.amountCents || 0)),
        currency: String(creditBack.currency || payout.currency || getBaseCurrency()).toUpperCase(),
        payoutId: payout._id,
        orderId: payout._id,
        note: creditBack.note,
        meta: creditBack.meta,
      }))
      .filter((row) => row.amountCents > 0);

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

      try {
        const writeResult = await SellerBalanceLedger.bulkWrite(creditOps, { ordered: false });
        credited = Number(writeResult?.upsertedCount || 0);
      } catch (err) {
        if (!isDupKey(err)) throw err;
        credited = 0;
      }
    }

    return {
      ok: true,
      payoutId: String(payout._id),
      status: newPayoutStatus,
      batchStatus,
      itemCount: updates.length,
      creditedBackCount: credited,
      source,
    };
  } finally {
    await releaseSyncLock(payoutObjectId, lock.lockKey);
  }
}

module.exports = { runSyncPayoutById };