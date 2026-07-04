// utils/cj/autoCreateCjOrders.js
'use strict';

const CjOrder = require('../../models/CjOrder');

const { createCjSupplierOrderForOrderId } = require('./cjOrderService');

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

function isAutoCreateEnabled() {
  return booleanFromEnv(process.env.CJ_AUTO_CREATE_ORDERS_ENABLED, false);
}

function getIntervalMs() {
  return boundedInteger(
    process.env.CJ_AUTO_CREATE_ORDERS_INTERVAL_MS,
    5 * 60 * 1000,
    60 * 1000,
    60 * 60 * 1000,
  );
}

function getBatchLimit() {
  return boundedInteger(process.env.CJ_AUTO_CREATE_ORDERS_BATCH_LIMIT, 10, 1, 50);
}

function eligibleCjOrderQuery() {
  return {
    department: 'CJ',

    status: 'PAID',

    paymentStatus: 'COMPLETED',

    fulfillmentStatus: 'CJ_ORDER_PENDING',

    'supplierOrder.createStatus': 'PENDING',
  };
}

async function runAutoCreateCjOrders({ limit = getBatchLimit(), source = 'manual' } = {}) {
  if (workerRunning) {
    return {
      ok: true,
      skipped: true,
      reason: 'CJ_AUTO_CREATE_ALREADY_RUNNING',
      source,
    };
  }

  workerRunning = true;

  const result = {
    ok: true,
    source,
    scanned: 0,
    success: 0,
    failed: 0,
    rows: [],
  };

  try {
    const orders = await CjOrder.find(eligibleCjOrderQuery())
      .select('_id cjOrderNumber')
      .sort({
        paidAt: 1,
        createdAt: 1,
      })
      .limit(limit)
      .lean();

    result.scanned = orders.length;

    for (const order of orders) {
      const row = {
        cjOrderNumber: order.cjOrderNumber,
        ok: false,
        message: '',
      };

      try {
        const created = await createCjSupplierOrderForOrderId(order._id);

        row.ok = created.ok === true;
        row.message = created.ok
          ? 'CJ supplier order created.'
          : created.message || 'CJ supplier order creation failed.';

        if (created.ok) {
          result.success += 1;
        } else {
          result.failed += 1;
        }
      } catch (error) {
        row.ok = false;
        row.message = String(error?.message || error || 'CJ order creation failed.').slice(0, 1000);
        result.failed += 1;
      }

      result.rows.push(row);
    }

    return result;
  } finally {
    workerRunning = false;
  }
}

function startAutoCreateCjOrdersWorker() {
  if (workerStarted) {
    return {
      ok: true,
      started: false,
      reason: 'CJ_AUTO_CREATE_WORKER_ALREADY_STARTED',
    };
  }

  workerStarted = true;

  if (!isAutoCreateEnabled()) {
    console.log('[CJ auto-create] Disabled. Set CJ_AUTO_CREATE_ORDERS_ENABLED=true to enable.');

    return {
      ok: true,
      started: false,
      reason: 'CJ_AUTO_CREATE_DISABLED',
    };
  }

  const intervalMs = getIntervalMs();

  console.log(`[CJ auto-create] Worker enabled. Interval: ${intervalMs}ms`);

  runAutoCreateCjOrders({
    source: 'startup',
  })
    .then((result) => {
      console.log('[CJ auto-create] Startup result:', result);

      return result;
    })
    .catch((error) => {
      console.error('[CJ auto-create] Startup run failed:', error?.stack || error);

      return null;
    });

  intervalHandle = setInterval(() => {
    runAutoCreateCjOrders({
      source: 'interval',
    })
      .then((result) => {
        if (result.scanned || result.success || result.failed) {
          console.log('[CJ auto-create] Interval result:', result);
        }

        return result;
      })
      .catch((error) => {
        console.error('[CJ auto-create] Interval run failed:', error?.stack || error);

        return null;
      });
  }, intervalMs);

  return {
    ok: true,
    started: true,
    intervalMs,
  };
}

function stopAutoCreateCjOrdersWorker() {
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
  eligibleCjOrderQuery,
  runAutoCreateCjOrders,
  startAutoCreateCjOrdersWorker,
  stopAutoCreateCjOrdersWorker,
};
