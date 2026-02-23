// utils/payouts/getSellerAvailableCents.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

function toObjectId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

function normCcy(v, fallback = null) {
  const s = String(v ?? '').trim().toUpperCase();
  return s || fallback || getBaseCurrency();
}

async function getSellerAvailableCents(businessId, currency = null) {
  const bid = toObjectId(businessId);
  if (!bid) return 0;

  const ccy = normCcy(currency);
  const now = new Date();

  // ✅ AVAILABLE = matured earnings + debits/adjustments
  const availableMatch = {
    businessId: bid,
    currency: ccy,
    $or: [
      {
        type: 'EARNING',
        $or: [
          { availableAt: { $exists: false } },
          { availableAt: null },
          { availableAt: { $lte: now } },
        ],
      },
      { type: { $in: ['REFUND_DEBIT', 'PAYOUT_DEBIT', 'ADJUSTMENT'] } },
    ],
  };

  const agg = await SellerBalanceLedger.aggregate([
    { $match: availableMatch },
    { $group: { _id: null, sum: { $sum: '$amountCents' } } },
  ]);

  const sum = Number(agg?.[0]?.sum || 0);
  return Math.max(0, Math.trunc(sum));
}

module.exports = { getSellerAvailableCents };
