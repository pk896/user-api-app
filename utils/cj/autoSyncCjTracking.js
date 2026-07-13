// utils/cj/autoSyncCjTracking.js
'use strict';

const CjOrder = require('../../models/CjOrder');

const { syncCjTrackingForOrderId, recordTrackingFailure } = require('./cjTrackingService');

let workerStarted = false;
let workerRunning = false;
let intervalHandle = null;

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function isEnabled() {
  return booleanFromEnv(process.env.CJ_TRACKING_SYNC_ENABLED, false);
}

function getIntervalMs() {
  return boundedInteger(
    process.env.CJ_TRACKING_SYNC_INTERVAL_MS,
    15 * 60 * 1000,
    5 * 60 * 1000,
    6 * 60 * 60 * 1000,
  );
}

function getBatchLimit() {
  return boundedInteger(process.env.CJ_TRACKING_SYNC_BATCH_LIMIT, 20, 1, 100);
}

function getMinimumAgeMs() {
  return boundedInteger(
    process.env.CJ_TRACKING_SYNC_MIN_AGE_MS,
    5 * 60 * 1000,
    60 * 1000,
    24 * 60 * 60 * 1000,
  );
}

function eligibleTrackingQuery() {
  const nextAllowedSync = new Date(Date.now() - getMinimumAgeMs());

  return {
    department: 'CJ',

    paymentStatus: 'COMPLETED',

    'supplierOrder.createStatus': 'SUCCESS',

    'supplierOrder.cjOrderId': {
      $exists: true,
      $ne: '',
    },

    'tracking.status': {
      $nin: ['DELIVERED', 'CANCELLED', 'RETURNED'],
    },

    $or: [
      {
        'tracking.lastSyncedAt': null,
      },

      {
        'tracking.lastSyncedAt': {
          $exists: false,
        },
      },

      {
        'tracking.lastSyncedAt': {
          $lte: nextAllowedSync,
        },
      },
    ],
  };
}

async function runCjTrackingSync({ limit = getBatchLimit(), source = 'manual' } = {}) {
  if (workerRunning) {
    return {
      ok: true,
      skipped: true,
      reason: 'CJ_TRACKING_SYNC_ALREADY_RUNNING',
      source,
    };
  }

  workerRunning = true;

  const result = {
    ok: true,
    source,
    scanned: 0,
    changed: 0,
    unchanged: 0,
    failed: 0,
    rows: [],
  };

  try {
    const orders = await CjOrder.find(eligibleTrackingQuery())
      .select('_id cjOrderNumber')
      .sort({
        'tracking.lastSyncedAt': 1,
        'supplierOrder.createdAt': 1,
      })
      .limit(limit)
      .lean();

    result.scanned = orders.length;

    for (const order of orders) {
      try {
        const row = await syncCjTrackingForOrderId(order._id, {
          source,
        });

        result.rows.push(row);

        if (row.changed) {
          result.changed += 1;
        } else {
          result.unchanged += 1;
        }
      } catch (error) {
        result.failed += 1;

        await recordTrackingFailure(order._id, error).catch(() => {});

        result.rows.push({
          ok: false,
          cjOrderNumber: order.cjOrderNumber,
          message: String(error?.message || error).slice(0, 1000),
        });

        console.error('[CJ tracking sync] Order failed:', {
          cjOrderNumber: order.cjOrderNumber,
          message: error?.message || error,
        });
      }
    }

    return result;
  } finally {
    workerRunning = false;
  }
}

function startCjTrackingSyncWorker() {
  if (workerStarted) {
    return {
      ok: true,
      started: false,
      reason: 'CJ_TRACKING_WORKER_ALREADY_STARTED',
    };
  }

  workerStarted = true;

  if (!isEnabled()) {
    console.log('[CJ tracking sync] Disabled. Set CJ_TRACKING_SYNC_ENABLED=true to enable.');

    return {
      ok: true,
      started: false,
      reason: 'CJ_TRACKING_SYNC_DISABLED',
    };
  }

  const intervalMs = getIntervalMs();

  console.log(`[CJ tracking sync] Worker enabled. Interval: ${intervalMs}ms`);

  runCjTrackingSync({
    source: 'startup',
  }).catch((error) => {
    console.error('[CJ tracking sync] Startup run failed:', error?.stack || error);
  });

  intervalHandle = setInterval(() => {
    runCjTrackingSync({
      source: 'interval',
    })
      .then((result) => {
        if (result.scanned || result.changed || result.failed) {
          console.log('[CJ tracking sync] Interval result:', result);
        }

        /*
         * Return the result so the promise callback always
         * returns a value and satisfies the lint rule.
         */
        return result;
      })
      .catch((error) => {
        console.error('[CJ tracking sync] Interval failed:', error?.stack || error);

        return null;
      });
  }, intervalMs);

  return {
    ok: true,
    started: true,
    intervalMs,
  };
}

function stopCjTrackingSyncWorker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }

  workerStarted = false;

  return {
    ok: true,
    stopped: true,
  };
}

module.exports = {
  eligibleTrackingQuery,
  runCjTrackingSync,
  startCjTrackingSyncWorker,
  stopCjTrackingSyncWorker,
};
