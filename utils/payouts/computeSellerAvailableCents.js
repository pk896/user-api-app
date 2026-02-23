// utils/payouts/computeSellerAvailableCents.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

let getSellerAvailableCents = null;
try {
  ({ getSellerAvailableCents } = require('./getSellerAvailableCents'));
} catch {
  // optional
}

function toObjectId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function normCcy(v) {
  if (v === null || v === undefined || v === '') return null;
  return String(v).trim().toUpperCase();
}

async function fallbackCompute(businessId, currency = null) {
  const bid = toObjectId(businessId);
  if (!bid) return 0;

  const ccy =
    normCcy(currency) ||
    String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
    'USD';

  const now = new Date();

  // ✅ Same logic as getSellerAvailableCents:
  // matured EARNING + debits/adjustments
  const match = {
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

  const rows = await SellerBalanceLedger.aggregate([
    { $match: match },
    { $group: { _id: null, sum: { $sum: '$amountCents' } } },
  ]);

  const n = Number(rows?.[0]?.sum || 0);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

async function computeSellerAvailableCents(businessId, opts = {}) {
  // ✅ Use requested currency, else BASE_CURRENCY, else USD fallback
  const currency =
    normCcy(opts?.currency) ||
    String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
    'USD';

  // Prefer the dedicated function if present
  try {
    if (typeof getSellerAvailableCents === 'function') {
      const v = await getSellerAvailableCents(businessId, currency);
      const n = Number(v || 0);
      return Number.isFinite(n) ? n : 0;
    }
  } catch {
    // fall back
  }

  return fallbackCompute(businessId, currency);
}

module.exports = { computeSellerAvailableCents };