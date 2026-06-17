// utils/courierGuy/autoCreateCourierGuyShipments.js
'use strict';

const Order = require('../../models/Order');

const { createCourierGuyShipment } = require('./createCourierGuyShipment');

const { saveCourierGuyShipmentToOrder } = require('./saveCourierGuyShipmentToOrder');

const { sendOrderProcessingEmail } = require('../emails/orderStatusEmail');

let running = false;
let timer = null;

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();

  if (!raw) return fallback;

  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function numEnv(name, fallback) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function paidQuery() {
  return {
    $or: [
      {
        status: {
          $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'],
        },
      },
      {
        paymentStatus: {
          $in: ['PAID', 'COMPLETED', 'CAPTURED', 'paid', 'completed', 'captured'],
        },
      },
    ],
  };
}

function nextRetryDate() {
  const retryMinutes = Math.max(5, Math.floor(numEnv('COURIER_GUY_AUTO_CREATE_RETRY_MINUTES', 30)));

  return new Date(Date.now() + retryMinutes * 60 * 1000);
}

async function markFailed(order, error) {
  order.courierGuy = order.courierGuy || {};

  order.courierGuy.autoCreateStatus = 'FAILED';

  order.courierGuy.autoCreateAttemptedAt = new Date();

  order.courierGuy.autoCreateNextAttemptAt = nextRetryDate();

  order.courierGuy.autoCreateLastError = String(error?.message || error).slice(0, 500);

  await order.save().catch((saveError) => {
    console.error('[courier-guy-auto] failed to save failure state:', {
      orderId: order.orderId,
      message: saveError?.message || String(saveError),
    });
  });
}

async function processOrder(order) {
  try {
    const result = await createCourierGuyShipment(order);

    await saveCourierGuyShipmentToOrder(order, result);

    order.courierGuy.autoCreateNextAttemptAt = null;

    await order.save();

    try {
      await sendOrderProcessingEmail(order);
    } catch (emailError) {
      console.warn(
        '[courier-guy-auto] processing email failed:',
        emailError?.message || String(emailError),
      );
    }

    console.log('[courier-guy-auto] shipment created:', {
      orderId: order.orderId,
      shipmentId: order.courierGuy?.shipmentId,
    });
  } catch (error) {
    await markFailed(order, error);

    console.error('[courier-guy-auto] shipment creation failed:', {
      orderId: order.orderId,
      code: error?.code || '',
      message: error?.message || String(error),
    });
  }
}

async function runCourierGuyAutoCreateOnce() {
  if (running) {
    console.log('[courier-guy-auto] skipped overlapping run.');

    return;
  }

  running = true;

  try {
    const now = new Date();

    const staleProcessingMinutes = Math.max(
      10,
      Math.floor(numEnv('COURIER_GUY_AUTO_CREATE_STALE_MINUTES', 30)),
    );

    const staleBefore = new Date(now.getTime() - staleProcessingMinutes * 60 * 1000);

    await Order.updateMany(
      {
        shippingProvider: 'COURIER_GUY',

        'courierGuy.shipmentId': {
          $in: ['', null],
        },

        'courierGuy.autoCreateStatus': 'PROCESSING',

        'courierGuy.autoCreateAttemptedAt': {
          $lte: staleBefore,
        },
      },
      {
        $set: {
          'courierGuy.autoCreateStatus': 'FAILED',

          'courierGuy.autoCreateNextAttemptAt': now,

          'courierGuy.autoCreateLastError':
            'Recovered a stale Courier Guy shipment creation lock after a server interruption.',
        },
      },
    );

    const maxPerRun = Math.max(1, Math.floor(numEnv('COURIER_GUY_AUTO_CREATE_MAX_PER_RUN', 10)));

    const maxAttempts = Math.max(1, Math.floor(numEnv('COURIER_GUY_AUTO_CREATE_MAX_ATTEMPTS', 5)));

    const candidates = await Order.find({
      shippingProvider: 'COURIER_GUY',

      $and: [
        paidQuery(),

        {
          $or: [
            {
              'courierGuy.serviceLevelId': {
                $exists: true,
                $nin: ['', null],
              },
            },
            {
              'courierGuy.serviceCode': {
                $exists: true,
                $nin: ['', null],
              },
            },
          ],
        },

        {
          $or: [
            {
              'courierGuy.shipmentId': {
                $exists: false,
              },
            },
            {
              'courierGuy.shipmentId': '',
            },
            {
              'courierGuy.shipmentId': null,
            },
          ],
        },

        {
          'courierGuy.autoCreateEnabled': {
            $ne: false,
          },
        },

        {
          'courierGuy.autoCreateStatus': {
            $in: ['PENDING', 'FAILED', null],
          },
        },

        {
          $or: [
            {
              'courierGuy.autoCreateAttempts': {
                $exists: false,
              },
            },
            {
              'courierGuy.autoCreateAttempts': {
                $lt: maxAttempts,
              },
            },
          ],
        },

        {
          $or: [
            {
              'courierGuy.autoCreateNextAttemptAt': {
                $exists: false,
              },
            },
            {
              'courierGuy.autoCreateNextAttemptAt': null,
            },
            {
              'courierGuy.autoCreateNextAttemptAt': {
                $lte: now,
              },
            },
          ],
        },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(maxPerRun);

    for (const candidate of candidates) {
      const claimed = await Order.findOneAndUpdate(
        {
          _id: candidate._id,

          shippingProvider: 'COURIER_GUY',

          $and: [
            {
              $or: [
                {
                  'courierGuy.serviceLevelId': {
                    $exists: true,
                    $nin: ['', null],
                  },
                },
                {
                  'courierGuy.serviceCode': {
                    $exists: true,
                    $nin: ['', null],
                  },
                },
              ],
            },

            {
              $or: [
                {
                  'courierGuy.shipmentId': {
                    $exists: false,
                  },
                },
                {
                  'courierGuy.shipmentId': '',
                },
                {
                  'courierGuy.shipmentId': null,
                },
              ],
            },

            {
              'courierGuy.autoCreateEnabled': {
                $ne: false,
              },
            },

            {
              'courierGuy.autoCreateStatus': {
                $in: ['PENDING', 'FAILED', null],
              },
            },

            {
              $or: [
                {
                  'courierGuy.autoCreateAttempts': {
                    $exists: false,
                  },
                },
                {
                  'courierGuy.autoCreateAttempts': {
                    $lt: maxAttempts,
                  },
                },
              ],
            },

            {
              $or: [
                {
                  'courierGuy.autoCreateNextAttemptAt': {
                    $exists: false,
                  },
                },
                {
                  'courierGuy.autoCreateNextAttemptAt': null,
                },
                {
                  'courierGuy.autoCreateNextAttemptAt': {
                    $lte: now,
                  },
                },
              ],
            },
          ],
        },
        {
          $set: {
            'courierGuy.autoCreateStatus': 'PROCESSING',

            'courierGuy.autoCreateAttemptedAt': now,

            'courierGuy.autoCreateLastError': '',
          },

          $inc: {
            'courierGuy.autoCreateAttempts': 1,
          },
        },
        {
          new: true,
        },
      );

      if (claimed) {
        await processOrder(claimed);
      }
    }
  } catch (error) {
    console.error('[courier-guy-auto] worker run failed:', error?.stack || error?.message || error);
  } finally {
    running = false;
  }
}

function startCourierGuyAutoCreateWorker() {
  const enabled = boolEnv('COURIER_GUY_AUTO_CREATE_ENABLED', false);

  if (!enabled) {
    console.log('[courier-guy-auto] disabled.');

    return;
  }

  if (timer) {
    console.warn('[courier-guy-auto] worker already started.');

    return;
  }

  const intervalMinutes = Math.max(1, numEnv('COURIER_GUY_AUTO_CREATE_INTERVAL_MINUTES', 5));

  console.log(`[courier-guy-auto] enabled. interval=${intervalMinutes}m`);

  const initialTimer = setTimeout(() => {
    runCourierGuyAutoCreateOnce().catch((error) => {
      console.error('[courier-guy-auto] initial run failed:', error);
    });
  }, 15000);

  initialTimer.unref?.();

  timer = setInterval(
    () => {
      runCourierGuyAutoCreateOnce().catch((error) => {
        console.error('[courier-guy-auto] scheduled run failed:', error);
      });
    },
    intervalMinutes * 60 * 1000,
  );

  timer.unref?.();
}

module.exports = {
  runCourierGuyAutoCreateOnce,
  startCourierGuyAutoCreateWorker,
};
