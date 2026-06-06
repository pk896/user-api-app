// scripts/repairPayoutIndexes.js
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
    })),
  );

  return indexes;
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

  const beforeIndexes = await printIndexes(collection, '📋 Existing payout indexes before repair:');

  const oldIndexName = 'mode_1_batchId_1';
  const hasOldIndex = beforeIndexes.some((idx) => idx.name === oldIndexName);

  if (hasOldIndex) {
    console.log(`🧹 Dropping old bad index: ${oldIndexName}`);
    await collection.dropIndex(oldIndexName);
    console.log('✅ Old bad index dropped');
  } else {
    console.log(`ℹ️ Old bad index not found: ${oldIndexName}`);
  }

  console.log('🧹 Removing null/empty batchId from old local payout docs...');

  const cleanResult = await collection.updateMany(
    {
      $or: [{ batchId: null }, { batchId: '' }, { batchId: { $exists: false } }],
    },
    {
      $unset: { batchId: 1 },
      $set: {
        'meta.batchIdCleanedAt': new Date(),
        'meta.batchIdCleanedReason':
          'Removed null/empty/missing batchId so the unique partial index only tracks real PayPal batch IDs',
      },
    },
  );

  console.log('✅ Cleaned payout docs:', {
    matchedCount: cleanResult.matchedCount,
    modifiedCount: cleanResult.modifiedCount,
  });

  console.log('🔧 Re-syncing indexes from models/Payout.js...');
  await Payout.syncIndexes();
  console.log('✅ Indexes synced');

  await printIndexes(collection, '📋 Existing payout indexes after repair:');

  console.log('✅ Done. You can now test Auto Pay Now again.');
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error('❌ Repair failed:', err);
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
