// utils/cj/cjApiRateLimiter.js
'use strict';

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(
    String(value ?? '').trim(),
    10,
  );

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(
    min,
    Math.min(max, parsed),
  );
}

/*
 * CJ reports a maximum rate of 1 request per second.
 *
 * Use a slightly larger gap to avoid requests arriving
 * inside the same rolling one-second CJ rate window.
 */
const CJ_API_MIN_REQUEST_GAP_MS =
  boundedInteger(
    process.env.CJ_API_MIN_REQUEST_GAP_MS,
    1300,
    1100,
    10000,
  );

let requestQueue = Promise.resolve();
let lastRequestStartedAt = 0;

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function scheduleCjApiCall(operation) {
  if (typeof operation !== 'function') {
    throw new TypeError(
      'scheduleCjApiCall requires a function.',
    );
  }

  const scheduled = requestQueue.then(
    async () => {
      const elapsed =
        Date.now() -
        lastRequestStartedAt;

      const waitMs = Math.max(
        0,
        CJ_API_MIN_REQUEST_GAP_MS -
          elapsed,
      );

      if (waitMs > 0) {
        await sleep(waitMs);
      }

      lastRequestStartedAt =
        Date.now();

      return operation();
    },
  );

  /*
   * Keep the shared queue operational after a failed API call.
   * The caller still receives the original rejection.
   */
  requestQueue = scheduled.catch(
    () => null,
  );

  return scheduled;
}

module.exports = {
  CJ_API_MIN_REQUEST_GAP_MS,
  scheduleCjApiCall,
};
