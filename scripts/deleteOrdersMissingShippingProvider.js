// scripts/deleteOrdersMissingShippingProvider.js
'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const Order = require('../models/Order');

const CONFIRMATION_VALUE = 'DELETE_MISSING_SHIPPING_PROVIDER_ORDERS';

function hasExecuteFlag() {
  return process.argv.includes('--execute');
}

function getMongoUri() {
  return String(process.env.MONGO_URI || '').trim();
}

async function connectDatabase() {
  const mongoUri = getMongoUri();

  if (!mongoUri) {
    const error = new Error(
      'MONGO_URI is missing. The cleanup script cannot connect to MongoDB.',
    );

    error.code = 'MONGO_URI_MISSING';

    throw error;
  }

  await mongoose.connect(mongoUri);

  console.log('[cleanup] Connected to MongoDB.');
}

async function previewOrdersMissingShippingProvider() {
  /*
   * Use the raw MongoDB collection.
   *
   * This is important because the Mongoose schema has a default value
   * for shippingProvider. The raw collection query checks whether the
   * field is physically absent from the stored MongoDB document.
   */
  const filter = {
    shippingProvider: {
      $exists: false,
    },
  };

  const count = await Order.collection.countDocuments(filter);

  const sample = await Order.collection
    .find(filter, {
      projection: {
        _id: 1,
        orderId: 1,
        status: 1,
        paymentStatus: 1,
        createdAt: 1,
        'shippo.payerRateId': 1,
        'shippo.payerShipmentId': 1,
        'courierGuy.serviceLevelId': 1,
      },
    })
    .sort({ createdAt: -1 })
    .limit(20)
    .toArray();

  return {
    filter,
    count,
    sample,
  };
}

async function run() {
  let exitCode = 0;

  try {
    await connectDatabase();

    const { filter, count, sample } =
      await previewOrdersMissingShippingProvider();

    console.log('');
    console.log('======================================================');
    console.log('ORDERS PHYSICALLY MISSING shippingProvider');
    console.log('======================================================');
    console.log(`Found: ${count}`);
    console.log('');

    if (sample.length) {
      console.table(
        sample.map((order) => ({
          mongoId: String(order._id || ''),
          orderId: String(order.orderId || ''),
          status: String(order.status || ''),
          paymentStatus: String(order.paymentStatus || ''),
          createdAt: order.createdAt || '',
          shippoRateId: String(order.shippo?.payerRateId || ''),
          shippoShipmentId: String(order.shippo?.payerShipmentId || ''),
          courierGuyServiceLevelId: String(
            order.courierGuy?.serviceLevelId || '',
          ),
        })),
      );
    }

    if (count === 0) {
      console.log(
        '[cleanup] Nothing to delete. Every order already has shippingProvider.',
      );

      return;
    }

    if (!hasExecuteFlag()) {
      console.log('');
      console.log('[cleanup] PREVIEW ONLY. No orders were deleted.');
      console.log('');
      console.log('After checking the preview, run deletion with:');
      console.log('');
      console.log(
        `$env:CONFIRM_ORDER_CLEANUP="${CONFIRMATION_VALUE}"`,
      );
      console.log(
        'node scripts/deleteOrdersMissingShippingProvider.js --execute',
      );

      return;
    }

    const confirmation = String(
      process.env.CONFIRM_ORDER_CLEANUP || '',
    ).trim();

    if (confirmation !== CONFIRMATION_VALUE) {
      const error = new Error(
        `Deletion blocked. CONFIRM_ORDER_CLEANUP must equal ${CONFIRMATION_VALUE}.`,
      );

      error.code = 'ORDER_CLEANUP_CONFIRMATION_MISSING';

      throw error;
    }

    const result = await Order.collection.deleteMany(filter);

    console.log('');
    console.log('======================================================');
    console.log('CLEANUP COMPLETED');
    console.log('======================================================');
    console.log(`Matched: ${result.matchedCount}`);
    console.log(`Deleted: ${result.deletedCount}`);
    console.log('');

    const remaining = await Order.collection.countDocuments(filter);

    console.log(
      `[cleanup] Orders still missing shippingProvider: ${remaining}`,
    );
  } catch (error) {
    exitCode = 1;

    console.error('');
    console.error('[cleanup] Failed:', {
      code: error?.code || '',
      message: error?.message || String(error),
    });
  } finally {
    await mongoose.disconnect().catch(() => {});

    console.log('[cleanup] MongoDB connection closed.');

    process.exitCode = exitCode;
  }
}

run();
