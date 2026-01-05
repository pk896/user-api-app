// utils/payouts/getSellerAvailableCents.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

function toObjectId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function normCcy(v, fallback = 'USD') {
  const s = String(v ?? '').trim().toUpperCase();
  return s || fallback; // always return a currency
}

async function getSellerAvailableCents(businessId, currency = 'USD') {
  const bid = toObjectId(businessId);
  if (!bid) return 0;

  const ccy = normCcy(currency, 'USD');

  // Keep it ledger-based and simple:
  // + credits (EARNING / SELLER_CREDIT / etc.)
  // - debits (REFUND_DEBIT / PAYOUT_DEBIT / etc.)
  const match = { businessId: bid, currency: ccy };

  const agg = await SellerBalanceLedger.aggregate([
    { $match: match },
    { $group: { _id: null, sum: { $sum: '$amountCents' } } },
  ]);

  const sum = Number(agg?.[0]?.sum || 0);

  // ✅ never return negative available for payouts
  return Math.max(0, Math.trunc(sum));
}

module.exports = { getSellerAvailableCents };



