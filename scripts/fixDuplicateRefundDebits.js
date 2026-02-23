'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const SellerBalanceLedger = require('../models/SellerBalanceLedger');

async function run() {
  await connectDB();

  const rows = await SellerBalanceLedger.find({ type: 'REFUND_DEBIT' })
    .sort({ createdAt: 1 })
    .lean();

  const seen = new Map();
  const dupIds = [];

  for (const r of rows) {
    const key = [
      String(r.businessId || ''),
      String(r.orderId || ''),
      String(r.currency || 'USD').toUpperCase(),
      Number(r.amountCents || 0),
      'REFUND_DEBIT',
    ].join('|');

    if (!seen.has(key)) {
      seen.set(key, r._id.toString());
      continue;
    }

    dupIds.push(r._id);
  }

  console.log('Duplicate REFUND_DEBIT rows to delete:', dupIds.length);

  if (!dupIds.length) {
    console.log('No duplicates found.');
    await mongoose.disconnect();
    return;
  }

  const res = await SellerBalanceLedger.deleteMany({ _id: { $in: dupIds } });
  console.log('Deleted:', res.deletedCount);

  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch (e) {
    console.error('Disconnect error:', e);
  }
  throw err;
});

