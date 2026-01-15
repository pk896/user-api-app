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
  return s || fallback;
}

async function getSellerAvailableCents(businessId, currency = 'USD') {
  const bid = toObjectId(businessId);
  if (!bid) return 0;

  const ccy = normCcy(currency, 'USD');
  const now = new Date();

  // ✅ AVAILABLE = matured earnings + all debits/adjustments immediately
  const match = {
    businessId: bid,
    currency: ccy,
    $or: [
      // ✅ EARNING counts only when matured
      {
        type: 'EARNING',
        $or: [
          { availableAt: { $exists: false } }, // old docs without the field
          { availableAt: null },               // important if schema default is null
          { availableAt: { $lte: now } },      // matured
        ],
      },

      // ✅ all non-earnings apply immediately (refunds, payout debits, adjustments)
      { type: { $ne: 'EARNING' } },
    ],
  };

  const agg = await SellerBalanceLedger.aggregate([
    { $match: match },
    { $group: { _id: null, sum: { $sum: '$amountCents' } } },
  ]);

  const sum = Number(agg?.[0]?.sum || 0);
  return Math.max(0, Math.trunc(sum));
}

module.exports = { getSellerAvailableCents };
