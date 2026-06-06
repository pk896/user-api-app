
// scripts/repairPayoutProductionIndexes.js
'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Payout = require('../models/Payout');

async function printIndexes(collection, title) {
  console.log(title);

  const indexes = await collection.indexes();

  console.table(
    indexes.map((idx) => ({
      name: idx.name,
      unique: !!idx.unique,
      sparse: !!idx.sparse,
      partialFilterExpression: idx.partialFilterExpression
        ? JSON.stringify(idx.partialFilterExpression)
        : '',
      key: JSON.stringify(idx.key),
    }))
  );

  return indexes;
}

async function dropIndexIfExists(collection, indexes, name) {
  if (!indexes.some((idx) => idx.name === name)) {
    console.log(`ℹ️ Index not found: ${name}`);
    return;
  }

  console.log(`🧹 Dropping index: ${name}`);
  await collection.dropIndex(name);
  console.log(`✅ Dropped index: ${name}`);
}

async function main() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();

  if (!mongoUri) {
    throw new Error('Missing MONGO_URI in .env');
  }

  console.log('🔗 Connecting to MongoDB...');
  await mongoose.connect(mongoUri);
  console.log('✅ Connected');

  const collection = Payout.collection;

  const beforeIndexes = await printIndexes(
    collection,
    '📋 Existing payout indexes before production repair:'
  );

  // Drop older versions so syncIndexes can recreate using the model definition.
  await dropIndexIfExists(collection, beforeIndexes, 'mode_1_batchId_1');
  await dropIndexIfExists(collection, beforeIndexes, 'fingerprint_1');
  await dropIndexIfExists(collection, beforeIndexes, 'paypalRequestId_1');

  console.log('🧹 Cleaning null/empty fields from old local payout docs...');

  const cleanResult = await collection.updateMany(
    {
      $or: [
        { batchId: null },
        { batchId: '' },
        { fingerprint: null },
        { fingerprint: '' },
        { paypalRequestId: null },
        { paypalRequestId: '' },
        { runKey: '' },
      ],
    },
    {
      $unset: {
        batchId: 1,
        fingerprint: 1,
        paypalRequestId: 1,
        runKey: 1,
      },
      $set: {
        'meta.productionIndexCleanedAt': new Date(),
        'meta.productionIndexCleanedReason':
          'Removed null/empty payout fields before production-safe indexes were synced',
      },
    }
  );

  console.log('✅ Cleaned payout docs:', {
    matchedCount: cleanResult.matchedCount,
    modifiedCount: cleanResult.modifiedCount,
  });

  console.log('🧩 Backfilling approvalStatus on old payout docs...');

  const statusResult = await collection.updateMany(
    {
      $or: [
        { approvalStatus: { $exists: false } },
        { approvalStatus: null },
        { approvalStatus: '' },
      ],
    },
    [
      {
        $set: {
          approvalStatus: {
            $switch: {
              branches: [
                { case: { $eq: ['$status', 'COMPLETED'] }, then: 'COMPLETED' },
                { case: { $eq: ['$status', 'FAILED'] }, then: 'FAILED' },
                { case: { $eq: ['$status', 'PROCESSING'] }, then: 'SUBMITTED' },
              ],
              default: 'SUBMITTED',
            },
          },
        },
      },
    ]
  );

  console.log('✅ Backfilled approvalStatus:', {
    matchedCount: statusResult.matchedCount,
    modifiedCount: statusResult.modifiedCount,
  });

  console.log('🔧 Re-syncing indexes from models/Payout.js...');
  await Payout.syncIndexes();
  console.log('✅ Indexes synced');

  await printIndexes(collection, '📋 Existing payout indexes after production repair:');

  console.log('✅ Done. Production payout indexes are repaired.');
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error('❌ Production payout index repair failed:', err);
    process.exitCode = 1;
  } finally {
    try {
      await mongoose.disconnect();
      console.log('🔌 MongoDB disconnected');
    } catch (disconnectErr) {
      console.error('⚠️ MongoDB disconnect failed:', disconnectErr);
      process.exitCode = 1;
    }
  }
}

run();