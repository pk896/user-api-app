// utils/courierGuy/autoCreateCourierGuyShipments.js
'use strict';

const Order = require('../../models/Order');

const {
  createCourierGuyShipment,
} = require('./createCourierGuyShipment');

const {
  saveCourierGuyShipmentToOrder,
} = require('./saveCourierGuyShipmentToOrder');

const {
  sendOrderProcessingEmail,
} = require('../emails/orderStatusEmail');

let running = false;
let timer = null;

const PAID_LIKE_STATUSES = [
  'COMPLETED',
  'PAID',
  'SHIPPED',
  'DELIVERED',
  'CAPTURED',
];

const PAID_LIKE_PAYMENT_STATUSES = [
  'PAID',
  'COMPLETED',
  'CAPTURED',
];

const REFUND_BLOCKED_STATUSES = [
  'REFUND_SUBMITTED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'CANCELED',
];

const REFUND_BLOCKED_PAYMENT_STATUSES = [
  'REFUND_SUBMITTED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
  'CANCELLED',
  'CANCELED',
];

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();

  if (!raw) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function numEnv(name, fallback) {
  const raw = String(process.env[name] ?? '').trim();
  const value = Number(raw);

  return Number.isFinite(value)
    ? value
    : fallback;
}

function paidQuery() {
  return {
    $or: [
      {
        status: {
          $in: [
            ...PAID_LIKE_STATUSES,
            ...PAID_LIKE_STATUSES.map((status) =>
              status.toLowerCase(),
            ),
          ],
        },
      },
      {
        paymentStatus: {
          $in: [
            ...PAID_LIKE_PAYMENT_STATUSES,
            ...PAID_LIKE_PAYMENT_STATUSES.map((status) =>
              status.toLowerCase(),
            ),
          ],
        },
      },
    ],
  };
}

function refundBlockedQuery() {
  return {
    status: {
      $nin: [
        ...REFUND_BLOCKED_STATUSES,
        ...REFUND_BLOCKED_STATUSES.map((status) =>
          status.toLowerCase(),
        ),
      ],
    },

    paymentStatus: {
      $nin: [
        ...REFUND_BLOCKED_PAYMENT_STATUSES,
        ...REFUND_BLOCKED_PAYMENT_STATUSES.map((status) =>
          status.toLowerCase(),
        ),
      ],
    },
  };
}

function nextRetryDate() {
  const retryMinutes = Math.max(
    5,
    Math.floor(
      numEnv(
        'COURIER_GUY_AUTO_CREATE_RETRY_MINUTES',
        30,
      ),
    ),
  );

  return new Date(
    Date.now() + retryMinutes * 60 * 1000,
  );
}

function getAutoCreateAfterHours() {
  /*
   * Decimal values are allowed for local testing.
   *
   * Examples:
   * 12    = 12 hours
   * 1     = 1 hour
   * 0.05  = about 3 minutes
   * 0     = immediate eligibility
   */
  return Math.max(
    0,
    numEnv(
      'COURIER_GUY_AUTO_CREATE_AFTER_HOURS',
      12,
    ),
  );
}

function getEligibilityCutoff(now = new Date()) {
  const afterHours = getAutoCreateAfterHours();

  return new Date(
    now.getTime() - afterHours * 60 * 60 * 1000,
  );
}

async function markFailed(order, error) {
  order.courierGuy = order.courierGuy || {};

  order.courierGuy.autoCreateStatus = 'FAILED';

  order.courierGuy.autoCreateAttemptedAt =
    new Date();

  order.courierGuy.autoCreateNextAttemptAt =
    nextRetryDate();

  order.courierGuy.autoCreateLastError =
    String(error?.message || error).slice(0, 500);

  await order.save().catch((saveError) => {
    console.error(
      '[courier-guy-auto] failed to save failure state:',
      {
        orderId: order.orderId,
        message:
          saveError?.message ||
          String(saveError),
      },
    );
  });
}

async function processOrder(order) {
  try {
    const result =
      await createCourierGuyShipment(order);

    await saveCourierGuyShipmentToOrder(
      order,
      result,
    );

    order.courierGuy =
      order.courierGuy || {};

    order.courierGuy.autoCreateStatus =
      'SUCCESS';

    order.courierGuy.autoCreateLastSuccessAt =
      new Date();

    order.courierGuy.autoCreateNextAttemptAt =
      null;

    order.courierGuy.autoCreateLastError =
      '';

    await order.save();

    try {
      await sendOrderProcessingEmail(order);
    } catch (emailError) {
      console.warn(
        '[courier-guy-auto] processing email failed:',
        emailError?.message ||
          String(emailError),
      );
    }

    console.log(
      '[courier-guy-auto] shipment created:',
      {
        orderId: order.orderId,

        shipmentId:
          order.courierGuy?.shipmentId,

        afterHours:
          getAutoCreateAfterHours(),
      },
    );
  } catch (error) {
    await markFailed(order, error);

    console.error(
      '[courier-guy-auto] shipment creation failed:',
      {
        orderId: order.orderId,
        code: error?.code || '',
        message:
          error?.message ||
          String(error),
      },
    );
  }
}

function buildCandidateQuery({
  now,
  cutoff,
  maxAttempts,
}) {
  return {
    shippingProvider: 'COURIER_GUY',

    /*
     * This is the delay rule.
     *
     * An order created after this cutoff remains
     * untouched until it reaches the configured age.
     */
    createdAt: {
      $lte: cutoff,
    },

    $and: [
      paidQuery(),

      /*
       * Never automatically create a shipment while
       * the order is cancelled, refunded or involved
       * in a refund flow.
       */
      refundBlockedQuery(),

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
          $in: [
            'PENDING',
            'FAILED',
            null,
          ],
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
            'courierGuy.autoCreateNextAttemptAt':
              null,
          },
          {
            'courierGuy.autoCreateNextAttemptAt': {
              $lte: now,
            },
          },
        ],
      },
    ],
  };
}

function buildClaimQuery({
  orderId,
  now,
  cutoff,
  maxAttempts,
}) {
  return {
    _id: orderId,

    shippingProvider: 'COURIER_GUY',

    /*
     * Repeat the age check during the atomic claim.
     * This prevents another worker or stale query from
     * claiming the order before its delay has elapsed.
     */
    createdAt: {
      $lte: cutoff,
    },

    $and: [
      paidQuery(),

      refundBlockedQuery(),

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
          $in: [
            'PENDING',
            'FAILED',
            null,
          ],
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
            'courierGuy.autoCreateNextAttemptAt':
              null,
          },
          {
            'courierGuy.autoCreateNextAttemptAt': {
              $lte: now,
            },
          },
        ],
      },
    ],
  };
}

async function runCourierGuyAutoCreateOnce() {
  if (running) {
    console.log(
      '[courier-guy-auto] skipped overlapping run.',
    );

    return {
      ok: true,
      ran: false,
      reason: 'already-running',
    };
  }

  const enabled = boolEnv(
    'COURIER_GUY_AUTO_CREATE_ENABLED',
    false,
  );

  if (!enabled) {
    return {
      ok: true,
      ran: false,
      reason: 'disabled',
    };
  }

  running = true;

  let scanned = 0;
  let claimedCount = 0;
  let successCount = 0;
  let failedCount = 0;

  try {
    const now = new Date();

    const afterHours =
      getAutoCreateAfterHours();

    const cutoff =
      getEligibilityCutoff(now);

    const staleProcessingMinutes = Math.max(
      10,
      Math.floor(
        numEnv(
          'COURIER_GUY_AUTO_CREATE_STALE_MINUTES',
          30,
        ),
      ),
    );

    const staleBefore = new Date(
      now.getTime() -
        staleProcessingMinutes * 60 * 1000,
    );

    /*
     * Recover a job that was left in PROCESSING
     * after a crash or server interruption.
     */
    await Order.updateMany(
      {
        shippingProvider: 'COURIER_GUY',

        'courierGuy.shipmentId': {
          $in: ['', null],
        },

        'courierGuy.autoCreateStatus':
          'PROCESSING',

        'courierGuy.autoCreateAttemptedAt': {
          $lte: staleBefore,
        },
      },
      {
        $set: {
          'courierGuy.autoCreateStatus':
            'FAILED',

          'courierGuy.autoCreateNextAttemptAt':
            now,

          'courierGuy.autoCreateLastError':
            'Recovered a stale Courier Guy shipment creation lock after a server interruption.',
        },
      },
    );

    const maxPerRun = Math.max(
      1,
      Math.floor(
        numEnv(
          'COURIER_GUY_AUTO_CREATE_MAX_PER_RUN',
          10,
        ),
      ),
    );

    const maxAttempts = Math.max(
      1,
      Math.floor(
        numEnv(
          'COURIER_GUY_AUTO_CREATE_MAX_ATTEMPTS',
          5,
        ),
      ),
    );

    const candidates = await Order.find(
      buildCandidateQuery({
        now,
        cutoff,
        maxAttempts,
      }),
    )
      .sort({
        createdAt: 1,
      })
      .limit(maxPerRun);

    scanned = candidates.length;

    for (const candidate of candidates) {
      const claimed =
        await Order.findOneAndUpdate(
          buildClaimQuery({
            orderId: candidate._id,
            now,
            cutoff,
            maxAttempts,
          }),
          {
            $set: {
              'courierGuy.autoCreateStatus':
                'PROCESSING',

              'courierGuy.autoCreateAttemptedAt':
                now,

              'courierGuy.autoCreateLastError':
                '',
            },

            $inc: {
              'courierGuy.autoCreateAttempts':
                1,
            },
          },
          {
            new: true,
          },
        );

      if (!claimed) {
        continue;
      }

      claimedCount += 1;

      const attemptsBefore =
        Number(
          claimed.courierGuy
            ?.autoCreateAttempts || 0,
        );

      await processOrder(claimed);

      const resultOrder =
        await Order.findById(
          claimed._id,
        )
          .select(
            'courierGuy.autoCreateStatus',
          )
          .lean();

      if (
        resultOrder?.courierGuy
          ?.autoCreateStatus === 'SUCCESS'
      ) {
        successCount += 1;
      } else {
        failedCount += 1;
      }

      console.log(
        '[courier-guy-auto] order processed:',
        {
          orderId: claimed.orderId,
          afterHours,
          attempts: attemptsBefore,
        },
      );
    }

    return {
      ok: true,
      ran: true,
      afterHours,
      cutoff,
      scanned,
      claimed: claimedCount,
      success: successCount,
      failed: failedCount,
    };
  } catch (error) {
    console.error(
      '[courier-guy-auto] worker run failed:',
      error?.stack ||
        error?.message ||
        error,
    );

    return {
      ok: false,
      ran: true,
      scanned,
      claimed: claimedCount,
      success: successCount,
      failed: failedCount,
      error:
        error?.message ||
        String(error),
    };
  } finally {
    running = false;
  }
}

function startCourierGuyAutoCreateWorker() {
  const enabled = boolEnv(
    'COURIER_GUY_AUTO_CREATE_ENABLED',
    false,
  );

  if (!enabled) {
    console.log(
      '[courier-guy-auto] disabled.',
    );

    return;
  }

  if (timer) {
    console.warn(
      '[courier-guy-auto] worker already started.',
    );

    return;
  }

  const intervalMinutes = Math.max(
    1,
    numEnv(
      'COURIER_GUY_AUTO_CREATE_INTERVAL_MINUTES',
      5,
    ),
  );

  const afterHours =
    getAutoCreateAfterHours();

  console.log(
    `[courier-guy-auto] enabled. interval=${intervalMinutes}m afterHours=${afterHours}h`,
  );

  /*
   * The first scan happens after 15 seconds,
   * but young orders are not eligible because the
   * database query enforces createdAt <= cutoff.
   */
  const initialTimer = setTimeout(() => {
    runCourierGuyAutoCreateOnce().catch(
      (error) => {
        console.error(
          '[courier-guy-auto] initial run failed:',
          error,
        );
      },
    );
  }, 15000);

  initialTimer.unref?.();

  timer = setInterval(
    () => {
      runCourierGuyAutoCreateOnce().catch(
        (error) => {
          console.error(
            '[courier-guy-auto] scheduled run failed:',
            error,
          );
        },
      );
    },
    intervalMinutes * 60 * 1000,
  );

  timer.unref?.();
}

module.exports = {
  runCourierGuyAutoCreateOnce,
  startCourierGuyAutoCreateWorker,
};