// utils/payouts/debitSellersFromRefund.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');
const { moneyToCents } = require('../money');

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function getCapturedGrossCentsFromOrder(order) {
  // Try common shapes first
  const v =
    order?.amount?.value ??
    order?.amount?.amount ??
    order?.total?.value ??
    order?.total ??
    order?.raw?.purchase_units?.[0]?.amount?.value ??
    null;

  const cents = moneyToCents(v);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function toUpper(v, fallback = null) {
  const s = String(v || '').trim().toUpperCase();
  return s || (fallback || getBaseCurrency());
}

function safeId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.trunc(x)));
}

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
}

// If your crediting file uses a different type, add it here.
// This ensures refund debits will ALWAYS find the credited rows.
const CREDIT_TYPES = ['EARNING', 'SELLER_CREDIT', 'EARNING_CREDIT'];

async function debitSellersFromRefund(order, opts = {}) {
  const {
    refundId = null,
    amount = null, // gross refund amount string/number OR null => full refund
    currency = null,
    allowWhenUnpaid = false,
    platformFeeBps = Number(process.env.PLATFORM_FEE_BPS || 1000),
  } = opts;

  if (!order) return { debited: 0, skipped: 'no-order' };

  // Your refund route sets allowWhenUnpaid: true, so this will not block refunds.
  if (!allowWhenUnpaid && typeof order.isPaidLike === 'function' && !order.isPaidLike()) {
    return { debited: 0, skipped: 'not-paid' };
  }

  const orderId = safeId(order._id);
  if (!orderId) return { debited: 0, skipped: 'missing-order-_id' };

  const refundIdStr = String(refundId || '').trim();
  if (!refundIdStr) {
    return { debited: 0, skipped: 'missing-refundId' };
  }

  const orderObjId = new mongoose.Types.ObjectId(orderId);

  const ccy = toUpper(
    currency ||
      order?.amount?.currency ||
      order?.breakdown?.currency ||
      order?.capture?.amount?.currency ||
      getBaseCurrency()
  );

  // ✅ clamp fee bps once (mirror credit file)
  const feeBps = clampInt(platformFeeBps, 0, 5000);

  // 1) Fetch seller CREDIT entries for this order (support different type names + orderId shapes)
  const earningsRaw = await SellerBalanceLedger.find({
    type: { $in: CREDIT_TYPES },
    $or: [
      { orderId: orderObjId }, // ✅ if orderId stored as ObjectId (most common)
      { orderId: orderId }, // ✅ if stored as string (defensive)
    ],
  })
    .select('businessId amountCents currency meta orderId type')
    .lean();

  if (!earningsRaw.length) {
    return { debited: 0, skipped: 'no-earnings-to-debit', creditTypes: CREDIT_TYPES, currency: ccy };
  }

  // Normalize currency on rows (if missing, assume ccy)
  const earnings = earningsRaw.map((e) => ({
    ...e,
    currency: toUpper(e.currency, ccy),
  }));

  const sameCcy = earnings.filter((e) => toUpper(e.currency, ccy) === ccy);
  if (!sameCcy.length) {
    return {
      debited: 0,
      skipped: 'no-earnings-in-currency',
      wantedCurrency: ccy,
      foundCurrencies: [...new Set(earnings.map((e) => e.currency))],
    };
  }

  const totalNetCents = sameCcy.reduce(
    (sum, e) => sum + Math.max(0, Number(e.amountCents || 0)),
    0
  );
  if (totalNetCents <= 0) return { debited: 0, skipped: 'total-net-zero', currency: ccy };

  // 2) Determine wanted NET debit cents
  let wantNetCents = totalNetCents;

  if (amount != null) {
    const grossRefundCents = moneyToCents(amount);
    if (!Number.isFinite(grossRefundCents) || grossRefundCents <= 0) {
      return { debited: 0, skipped: 'bad-amount', currency: ccy };
    }

    // ✅ Ratio method: debit sellers based on how much of the total captured amount was refunded.
    const capturedGrossCents = getCapturedGrossCentsFromOrder(order);

    if (!capturedGrossCents) {
      // Fallback: if we can't read captured amount, cap to totalNetCents (safe).
      wantNetCents = Math.min(totalNetCents, grossRefundCents);
    } else {
      const ratio = grossRefundCents / capturedGrossCents;
      const safeRatio = Math.max(0, Math.min(1, ratio));
      wantNetCents = Math.round(totalNetCents * safeRatio);
    }

    if (!Number.isFinite(wantNetCents) || wantNetCents <= 0) {
      return { debited: 0, skipped: 'net-zero-after-ratio', currency: ccy, feeBps };
    }

    if (wantNetCents > totalNetCents) wantNetCents = totalNetCents;
  }

  // 3) Group by seller (NET)
  const bySeller = new Map();
  for (const e of sameCcy) {
    const bid = safeId(e.businessId);
    if (!bid) continue;
    bySeller.set(bid, (bySeller.get(bid) || 0) + Math.max(0, Number(e.amountCents || 0)));
  }

  const sellers = [...bySeller.entries()];
  if (!sellers.length) return { debited: 0, skipped: 'no-seller-ids', currency: ccy };

  sellers.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  // ✅ Idempotency: existing debits for this refund/order/currency
  const refundKeyPrefix = `refunddebit:${String(orderId)}:${refundIdStr}:`;

  const existingDebits = await SellerBalanceLedger.find({
    type: 'REFUND_DEBIT',
    $or: [
      { orderId: orderObjId },
      { orderId: orderId },
    ],
    currency: ccy,
    'meta.uniqueKey': { $regex: `^${escapeRegex(refundKeyPrefix)}` },
  })
    .select('businessId amountCents meta.uniqueKey')
    .lean();

  const existingBySeller = new Map();
  for (const row of existingDebits) {
    const bid = safeId(row.businessId);
    if (!bid) continue;

    const absCents = Math.abs(Number(row.amountCents || 0));
    if (!Number.isFinite(absCents) || absCents <= 0) continue;

    existingBySeller.set(bid, (existingBySeller.get(bid) || 0) + absCents);
  }

  let remaining = wantNetCents;
  for (const alreadyDebited of existingBySeller.values()) {
    remaining -= Math.max(0, Number(alreadyDebited || 0));
  }

  if (remaining <= 0) {
    return {
      debited: 0,
      currency: ccy,
      debitedCents: wantNetCents,
      requestedNetCents: wantNetCents,
      skipped: 'already-debited',
      feeBps,
    };
  }

  // Helper to find last allocatable seller index (not already debited)
  function lastAllocatableIndex() {
    for (let j = sellers.length - 1; j >= 0; j--) {
      const [bidJ, centsJ] = sellers[j];
      if (centsJ > 0 && !existingBySeller.has(bidJ)) return j;
    }
    return -1;
  }

  // ✅ Build rows first (deterministic allocation), then write via bulk upsert (race-safe)
  const plannedRows = [];
  let plannedDebitedCents = 0;

  for (let i = 0; i < sellers.length; i++) {
    const [businessId, sellerNetCents] = sellers[i];
    if (sellerNetCents <= 0) continue;

    // Skip seller if already has debit(s) for this refund
    if (existingBySeller.has(businessId)) continue;

    const lastIndex = lastAllocatableIndex();
    const isLastAllocatable = i === lastIndex;

    let sellerDebit = 0;
    if (isLastAllocatable) {
      sellerDebit = remaining;
    } else {
      sellerDebit = Math.floor((remaining * sellerNetCents) / totalNetCents);
      if (sellerDebit <= 0) sellerDebit = 1; // ensure progress
      if (sellerDebit > remaining) sellerDebit = remaining;
    }

    if (sellerDebit <= 0) continue;

    // ✅ IMPORTANT: uniqueKey must be stable for THIS refund+seller
    // Do NOT include wantNetCents (that can vary if a caller retries badly)
    const uniqueKey = `refunddebit:${String(orderId)}:${refundIdStr}:${businessId}:${ccy}`;

    plannedRows.push({
      businessId: new mongoose.Types.ObjectId(businessId),
      type: 'REFUND_DEBIT',
      amountCents: -Math.abs(sellerDebit),
      currency: ccy,
      orderId: orderObjId,
      note: `Refund debit (net) for order ${order.orderId || orderId} (${refundIdStr})`,
      meta: {
        uniqueKey,
        refundId: refundIdStr,
        platformFeeBps: feeBps,
        requestedNetRefundCents: wantNetCents,
        sellerNetCents,
        totalNetCents,
      },
    });

    plannedDebitedCents += sellerDebit;
    remaining -= sellerDebit;

    if (remaining <= 0) break;
  }

  if (!plannedRows.length) {
    return {
      debited: 0,
      currency: ccy,
      debitedCents: 0,
      requestedNetCents: wantNetCents,
      skipped: 'nothing-to-write',
      feeBps,
    };
  }

  const ops = plannedRows.map((row) => ({
    updateOne: {
      filter: {
        businessId: row.businessId,
        type: 'REFUND_DEBIT',
        orderId: row.orderId,
        'meta.uniqueKey': row.meta.uniqueKey,
      },
      update: {
        $setOnInsert: {
          amountCents: row.amountCents,
          currency: row.currency,
          note: row.note,
          meta: row.meta,
        },
      },
      upsert: true,
    },
  }));

  let upsertedCount = 0;

  try {
    const wr = await SellerBalanceLedger.bulkWrite(ops, { ordered: false });
    upsertedCount = Number(wr?.upsertedCount || 0);
  } catch (e) {
    // ✅ Another request may have inserted same rows first (race): treat as idempotent success
    if (!isDupKey(e)) throw e;
    upsertedCount = 0;
  }

  // If duplicates/race happened, rows already exist. That's OK.
  if (!upsertedCount) {
    return {
      debited: 0,
      currency: ccy,
      debitedCents: 0,
      requestedNetCents: wantNetCents,
      skipped: 'all-already-debited',
      feeBps,
    };
  }

  return {
    debited: upsertedCount,
    currency: ccy,
    debitedCents: plannedDebitedCents,
    requestedNetCents: wantNetCents,
    feeBps,
  };
}

module.exports = { debitSellersFromRefund };