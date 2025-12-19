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

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.min(max, Math.max(min, Math.trunc(x)));
}

function grossToNetCents(grossCents, platformFeeBps) {
  // net = gross - fee; fee = gross * bps/10000
  const bps = clampInt(platformFeeBps, 0, 10000);
  const fee = Math.round((grossCents * bps) / 10000);
  return grossCents - fee;
}

async function debitSellersFromRefund(order, opts = {}) {
  const {
    refundId = null,
    amount = null,            // gross refund amount (PayPal refundJson.amount.value) OR null => full refund
    currency = null,
    allowWhenUnpaid = false,

    // ✅ mirror creditSellersFromOrder:
    platformFeeBps = Number(process.env.PLATFORM_FEE_BPS || 1000),
  } = opts;

  if (!order) return { debited: 0, skipped: 'no-order' };

  // Optional safety gate if your Order has isPaidLike()
  if (!allowWhenUnpaid && typeof order.isPaidLike === 'function' && !order.isPaidLike()) {
    return { debited: 0, skipped: 'not-paid' };
  }

  const orderId = safeId(order._id);
  if (!orderId) return { debited: 0, skipped: 'missing-order-_id' };

  const ccy =
    toUpper(
      currency ||
        order?.amount?.currency ||
        order?.breakdown?.currency ||
        order?.capture?.amount?.currency ||
        'USD'
    );

  // 1) Fetch seller EARNING entries for this order (these are NET earnings)
  const earnings = await SellerBalanceLedger.find({
    type: 'EARNING',
    orderId,
  })
    .select('businessId amountCents currency meta')
    .lean();

  if (!earnings.length) return { debited: 0, skipped: 'no-earnings-to-debit' };

  // Only debit entries matching this currency (simple + safe)
  const sameCcy = earnings.filter((e) => toUpper(e.currency, ccy) === ccy);
  if (!sameCcy.length) return { debited: 0, skipped: 'no-earnings-in-currency' };

  const totalNetCents = sameCcy.reduce(
    (sum, e) => sum + Math.max(0, Number(e.amountCents || 0)),
    0
  );
  if (totalNetCents <= 0) return { debited: 0, skipped: 'total-net-zero' };

  // 2) Determine WANT NET debit cents
  // - full refund (amount == null): debit totalNetCents
  // - partial refund: amount is GROSS refunded => convert to NET using platformFeeBps
  let wantNetCents = totalNetCents;

  if (amount != null) {
    const grossRefundCents = moneyToCents(amount);
    if (!Number.isFinite(grossRefundCents) || grossRefundCents <= 0) {
      return { debited: 0, skipped: 'bad-amount' };
    }

    // ✅ mirror fee logic: sellers return net portion, platform returns fee portion
    wantNetCents = grossToNetCents(grossRefundCents, platformFeeBps);

    if (!Number.isFinite(wantNetCents) || wantNetCents <= 0) {
      return { debited: 0, skipped: 'net-zero-after-fee' };
    }

    if (wantNetCents > totalNetCents) wantNetCents = totalNetCents;
  }

  // 3) Allocate proportionally by each seller’s NET earnings
  const bySeller = new Map();
  for (const e of sameCcy) {
    const bid = safeId(e.businessId);
    if (!bid) continue;
    const prev = bySeller.get(bid) || 0;
    bySeller.set(bid, prev + Math.max(0, Number(e.amountCents || 0)));
  }

  const sellers = [...bySeller.entries()];
  if (!sellers.length) return { debited: 0, skipped: 'no-seller-ids' };

  let remaining = wantNetCents;
  let created = 0;

  // ✅ stable ordering for consistent rounding
  sellers.sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  for (let i = 0; i < sellers.length; i++) {
    const [businessId, sellerNetCents] = sellers[i];
    if (sellerNetCents <= 0) continue;

    let sellerDebit = 0;
    if (i === sellers.length - 1) {
      sellerDebit = remaining; // remainder
    } else {
      sellerDebit = Math.round((wantNetCents * sellerNetCents) / totalNetCents);
      if (sellerDebit > remaining) sellerDebit = remaining;
    }
    if (sellerDebit <= 0) continue;

    // ✅ idempotency key (per refund)
    const uniqueKey = `refunddebit:${String(orderId)}:${String(refundId || 'noRefundId')}:${businessId}:${ccy}:${wantNetCents}`;

    const exists = await SellerBalanceLedger.findOne({
      type: 'REFUND_DEBIT',
      orderId,
      businessId,
      'meta.uniqueKey': uniqueKey,
    })
      .select('_id')
      .lean();

    if (exists) {
      remaining -= sellerDebit;
      continue;
    }

    await SellerBalanceLedger.create({
      businessId,
      type: 'REFUND_DEBIT',
      amountCents: -Math.abs(sellerDebit),
      currency: ccy,
      orderId,
      note: `Refund debit (net) for order ${order.orderId || orderId} (${refundId || 'refund'})`,
      meta: {
        uniqueKey,
        refundId: refundId || null,
        platformFeeBps: clampInt(platformFeeBps, 0, 10000),
        requestedNetRefundCents: wantNetCents,
        sellerNetCents,
        totalNetCents,
      },
    });

    created += 1;
    remaining -= sellerDebit;
    if (remaining <= 0) break;
  }

  return {
    debited: created,
    currency: ccy,
    debitedCents: wantNetCents - Math.max(0, remaining),
    requestedNetCents: wantNetCents,
  };
}

module.exports = { debitSellersFromRefund };
