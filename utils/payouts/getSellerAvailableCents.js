// utils/payouts/getSellerAvailableCents.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

function toObjectId(v) {
  const id = String(v?._id || v || '').trim();
  return mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

function normCcy(v) {
  return String(v || 'USD').trim().toUpperCase();
}

async function getSellerAvailableCents(businessId, currency = 'USD') {
  const bid = toObjectId(businessId);
  if (!bid) return 0;

  const ccy = normCcy(currency);

  const agg = await SellerBalanceLedger.aggregate([
    { $match: { businessId: bid, currency: ccy } },
    { $group: { _id: null, sum: { $sum: '$amountCents' } } },
  ]);

  return Number(agg?.[0]?.sum || 0);
}

module.exports = { getSellerAvailableCents };
