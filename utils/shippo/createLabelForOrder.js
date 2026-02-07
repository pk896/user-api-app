// utils/shippo/createLabelForOrder.js
'use strict';

const { fetch } = require('undici');
const { setTimeout: delay } = require('node:timers/promises');

const SHIPPO_BASE = 'https://api.goshippo.com';

function mustEnv(name) {
  const v = String(process.env[name] || '').trim();
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function shippoFetch(path, { method = 'GET', body, timeoutMs = 20000, retries = 2 } = {}) {
  const token = mustEnv('SHIPPO_TOKEN');

  const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = globalThis.setTimeout(() => controller.abort(), timeoutMs);

    try {
      const r = await fetch(`${SHIPPO_BASE}${path}`, {
        method,
        headers: {
          Authorization: `ShippoToken ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(t);

      const text = await r.text().catch(() => '');
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text };
      }

      if (!r.ok) {
        const status = r.status;
        const msg =
          data?.detail ||
          data?.message ||
          (typeof data?.raw === 'string' && data.raw.trim() ? data.raw.slice(0, 200) : '') ||
          `Shippo error (${status})`;

        const err = new Error(msg);
        err.status = status;
        err.shippo = data;

        if (RETRY_STATUSES.has(status) && attempt < retries) {
          const backoff = 600 * Math.pow(2, attempt);
          await delay(backoff);
          lastErr = err;
          continue;
        }

        throw err;
      }

      return data;
    } catch (e) {
      clearTimeout(t);

      const isAbort =
        e?.name === 'AbortError' || String(e?.message || '').toLowerCase().includes('aborted');

      if ((isAbort || e?.status === 504) && attempt < retries) {
        const backoff = 600 * Math.pow(2, attempt);
        await delay(backoff);
        lastErr = e;
        continue;
      }

      throw e;
    }
  }

  throw lastErr || new Error('Shippo request failed after retries.');
}

// ------------------------------------------------------
// Poll shipment until rates exist (NO shipment creation)
// ------------------------------------------------------
async function pollShipmentUntilRates(shipmentId, { attempts = 18, delayMs = 900 } = {}) {
  const sid = String(shipmentId || '').trim();
  if (!sid) {
    const err = new Error('Missing Shippo shipmentId.');
    err.code = 'SHIPPO_MISSING_SHIPMENT_ID';
    throw err;
  }

  let last = null;

  for (let i = 0; i < attempts; i++) {
    const cur = await shippoFetch(`/shipments/${encodeURIComponent(sid)}/`, {
      method: 'GET',
      timeoutMs: 25000,
      retries: 2,
    });

    last = cur;

    const st = String(cur?.object_status || cur?.status || '').toUpperCase();
    const rates = Array.isArray(cur?.rates) ? cur.rates : [];

    if (rates.length) return { shipment: cur, rates };

    if (st === 'ERROR' || st === 'FAILED') {
      const err = new Error('Shippo shipment failed to produce rates.');
      err.code = 'SHIPPO_SHIPMENT_FAILED';
      err.shippo = { shipment: cur };
      throw err;
    }

    await delay(delayMs + i * 120);
  }

  const err = new Error('Shippo rates are still not ready. Please retry.');
  err.code = 'SHIPPO_RATES_NOT_READY';
  err.shippo = { shipment: last };
  throw err;
}

async function getShipmentAndRatesOrThrow(shipmentId) {
  const { shipment, rates } = await pollShipmentUntilRates(shipmentId, { attempts: 18, delayMs: 900 });
  if (!Array.isArray(rates) || !rates.length) {
    const err = new Error('Shippo shipment has no rates.');
    err.code = 'SHIPPO_NO_RATES';
    err.shippo = { shipment };
    throw err;
  }
  return { shipment, rates };
}

// ------------------------------------------------------
// Poll transaction until label_url exists or terminal state
// ------------------------------------------------------
async function pollTransactionUntilDone(tx, { attempts = 45, delayMs = 1400, maxDelayMs = 6500 } = {}) {
  let cur = tx;

  for (let i = 0; i < attempts; i++) {
    const label = cur?.label_url;
    const st = String(cur?.status || cur?.object_status || '').toUpperCase();

    if (label) return cur;
    if (st === 'SUCCESS') return cur;
    if (st === 'ERROR' || st === 'FAILED') return cur;
    if (!cur?.object_id) return cur;

    const wait = Math.min(maxDelayMs, delayMs + i * 150);
    await delay(wait);

    cur = await shippoFetch(`/transactions/${encodeURIComponent(cur.object_id)}/`, {
      method: 'GET',
      timeoutMs: 20000,
      retries: 2,
    });
  }

  return cur;
}

function providerToShippoCarrierToken(providerName) {
  const raw = String(providerName || '').trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ======================================================
// ✅ createLabelForOrder
// - STRICT: requires rateId + shipmentId (existing) and verifies rateId exists on shipment
// - NON-STRICT: just buys provided rateId (no shipment creation)
// ======================================================
async function createLabelForOrder(order, opts = {}) {
  if (!order) throw new Error('Order is required');

  const strictRateId = !!opts.strictRateId;

  const rateId = opts.rateId ? String(opts.rateId).trim() : '';
  const shipmentId = String(order?.shippo?.payerShipmentId || '').trim();

  if (!rateId) {
    const err = new Error('Missing rateId.');
    err.code = 'SHIPPO_MISSING_RATE_ID';
    throw err;
  }

  // STRICT: confirm rateId is on the saved shipmentId
  let shipment = null;
  let chosenRate = { object_id: rateId };

  if (strictRateId) {
    if (!shipmentId) {
      const err = new Error('Missing shipmentId for strict payer purchase (payerShipmentId must be saved in payment.js).');
      err.code = 'SHIPPO_STRICT_MISSING_SHIPMENT_ID';
      throw err;
    }

    const got = await getShipmentAndRatesOrThrow(shipmentId);
    shipment = got.shipment;

    const exact = got.rates.find((r) => String(r?.object_id || '').trim() === rateId);
    if (!exact) {
      const err = new Error('Payer-selected rateId is not found on the payer shipment (expired or wrong shipment).');
      err.code = 'SHIPPO_RATE_NOT_ON_PAYER_SHIPMENT';
      err.shippo = {
        payerShipmentId: shipment?.object_id || shipmentId,
        attemptedRateId: rateId,
        rateCount: got.rates.length,
      };
      throw err; // NO fallback
    }

    chosenRate = exact;
  }

  // Buy the transaction
  let tx = await shippoFetch('/transactions/', {
    method: 'POST',
    body: {
      rate: String(chosenRate?.object_id || rateId).trim(),
      label_file_type: String(process.env.SHIPPO_LABEL_FILE_TYPE || 'PDF').trim() || 'PDF',
      async: true,
      metadata: `order:${order.orderId || order._id}`,
    },
    timeoutMs: 20000,
    retries: 2,
  });

  if (!tx?.label_url) tx = await pollTransactionUntilDone(tx);

  if (!tx?.label_url) {
    const status = tx?.status || tx?.object_status || 'UNKNOWN';
    const messages = tx?.messages || tx?.validation_results || tx?.meta || null;

    const err = new Error('Shippo did not return a label_url.');
    err.code = 'SHIPPO_NO_LABEL_URL';
    err.shippo = {
      status,
      messages,
      transaction: tx,
      chosenRate,
      shipmentId: shipment?.object_id || (shipmentId || null),
    };
    throw err;
  }

  const carrierToken =
    providerToShippoCarrierToken(chosenRate?.provider) ||
    providerToShippoCarrierToken(tx?.provider) ||
    null;

  return {
    shipment,       // may be null in non-strict
    chosenRate,     // best-effort
    transaction: tx,
    carrierEnum: null,
    carrierToken,
  };
}

// ======================================================
// ✅ getRatesForOrder (NO shipment creation)
// ONLY reads saved payerShipmentId/shipmentId and returns rates.
// ======================================================
async function getRatesForOrder(order) {
  if (!order) throw new Error('Order is required');

  const shipmentId =
    String(order?.shippo?.payerShipmentId || '').trim() ||
    String(order?.shippo?.shipmentId || '').trim() ||
    '';

  if (!shipmentId) {
    const err = new Error('Missing Shippo shipmentId on order. payment.js must create shipment + save payerShipmentId.');
    err.code = 'SHIPPO_MISSING_SAVED_SHIPMENT';
    err.details = { orderId: order?.orderId || order?._id };
    throw err;
  }

  const { shipment, rates } = await pollShipmentUntilRates(shipmentId, { attempts: 18, delayMs: 900 });
  return { shipment, rates, reused: true };
}

module.exports = { createLabelForOrder, getRatesForOrder };
