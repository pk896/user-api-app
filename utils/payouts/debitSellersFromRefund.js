// utils/payouts/debitSellersFromRefund.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');
const { moneyToCents } = require('../money');

function toUpper(v, fallback = 'USD') {
  const s = String(v || '').trim().toUpperCase();
  return s || fallback;
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

function grossToNetCents(grossCents, platformFeeBps) {
  const bps = clampInt(platformFeeBps, 0, 10000);
  const fee = Math.round((grossCents * bps) / 10000);
  return grossCents - fee;
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

  const orderObjId = new mongoose.Types.ObjectId(orderId);

  const ccy = toUpper(
    currency ||
      order?.amount?.currency ||
      order?.breakdown?.currency ||
      order?.capture?.amount?.currency ||
      'USD'
  );

  // ✅ clamp fee bps once (mirror credit file)
  const feeBps = clampInt(platformFeeBps, 0, 3000);

  // 1) Fetch seller CREDIT entries for this order (support different type names + orderId shapes)
  const earningsRaw = await SellerBalanceLedger.find({
    type: { $in: CREDIT_TYPES },
    $or: [
      { orderId: orderObjId }, // ✅ if orderId stored as ObjectId (most common)
      { orderId: orderId },    // ✅ if stored as string (defensive)
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

    wantNetCents = grossToNetCents(grossRefundCents, feeBps);

    if (!Number.isFinite(wantNetCents) || wantNetCents <= 0) {
      return { debited: 0, skipped: 'net-zero-after-fee', currency: ccy, feeBps };
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
  const refundKeyPrefix = `refunddebit:${String(orderId)}:${String(refundId || 'noRefundId')}:`;

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
  let created = 0;

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

  for (let i = 0; i < sellers.length; i++) {
    const [businessId, sellerNetCents] = sellers[i];
    if (sellerNetCents <= 0) continue;

    // Skip seller if already has debit(s) for this refund
    if (existingBySeller.has(businessId)) continue;

    const lastIndex = lastAllocatableIndex();
    const isLastAllocatable = (i === lastIndex);

    let sellerDebit = 0;
    if (isLastAllocatable) {
      sellerDebit = remaining;
    } else {
      sellerDebit = Math.floor((remaining * sellerNetCents) / totalNetCents);
      if (sellerDebit <= 0) sellerDebit = 1; // ensure progress
      if (sellerDebit > remaining) sellerDebit = remaining;
    }

    if (sellerDebit <= 0) continue;

    const uniqueKey =
      `refunddebit:${String(orderId)}:${String(refundId || 'noRefundId')}` +
      `:${businessId}:${ccy}:${wantNetCents}`;

    try {
      await SellerBalanceLedger.create({
        businessId,
        type: 'REFUND_DEBIT',
        amountCents: -Math.abs(sellerDebit),
        currency: ccy,
        orderId: orderObjId, // ✅ store as ObjectId consistently
        note: `Refund debit (net) for order ${order.orderId || orderId} (${refundId || 'refund'})`,
        meta: {
          uniqueKey,
          refundId: refundId || null,
          platformFeeBps: feeBps,
          requestedNetRefundCents: wantNetCents,
          sellerNetCents,
          totalNetCents,
        },
      });

      created += 1;
      remaining -= sellerDebit;

      if (remaining <= 0) break;
    } catch (e) {
      const msg = String(e?.message || '');
      if (msg.includes('E11000')) {
        // Treat as already created; move on.
        existingBySeller.set(businessId, sellerDebit);
        remaining -= sellerDebit;
        if (remaining <= 0) break;
        continue;
      }
      throw e;
    }
  }

  return {
    debited: created,
    currency: ccy,
    debitedCents: wantNetCents - Math.max(0, remaining),
    requestedNetCents: wantNetCents,
    feeBps,
  };
}

module.exports = { debitSellersFromRefund };



