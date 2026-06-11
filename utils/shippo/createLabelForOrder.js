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
        const detailText = Array.isArray(data?.detail)
          ? JSON.stringify(data.detail)
          : typeof data?.detail === 'object' && data?.detail !== null
            ? JSON.stringify(data.detail)
            : data?.detail;

        const messageText = Array.isArray(data?.message)
          ? JSON.stringify(data.message)
          : typeof data?.message === 'object' && data?.message !== null
            ? JSON.stringify(data.message)
            : data?.message;

        const msg =
          detailText ||
          messageText ||
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
        e?.name === 'AbortError' ||
        String(e?.message || '')
          .toLowerCase()
          .includes('aborted');

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
  const { shipment, rates } = await pollShipmentUntilRates(shipmentId, {
    attempts: 18,
    delayMs: 900,
  });
  if (!Array.isArray(rates) || !rates.length) {
    const err = new Error('Shippo shipment has no rates.');
    err.code = 'SHIPPO_NO_RATES';
    err.shippo = { shipment };
    throw err;
  }
  return { shipment, rates };
}

function cleanShippoAddress(address) {
  const a = address || {};

  return {
    name: a.name || 'Customer',
    company: a.company || undefined,
    street1: a.street1 || '',
    street2: a.street2 || '',
    city: a.city || '',
    state: a.state || '',
    zip: a.zip || '',
    country: a.country || '',
    phone: a.phone || undefined,
    email: a.email || undefined,
    is_residential: a.is_residential === true ? true : undefined,
  };
}

function cleanShippoParcel(parcel) {
  const p = parcel || {};

  return {
    length: p.length,
    width: p.width,
    height: p.height,
    distance_unit: p.distance_unit || 'cm',
    weight: p.weight,
    mass_unit: p.mass_unit || 'kg',
  };
}

function pickCustomsDeclarationId(shipment) {
  const raw =
    shipment?.customs_declaration ||
    shipment?.customsDeclaration ||
    shipment?.customs_declaration_id ||
    null;

  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (raw.object_id) return String(raw.object_id);
  if (raw.id) return String(raw.id);

  return null;
}

function envStr(name, fallback = '') {
  const v = String(process.env[name] || '').trim();
  return v || fallback;
}

function shippoEelPfc() {
  return envStr('SHIPPO_EEL_PFC', 'NOEEI_30_37_a');
}

function customsItemId(item) {
  if (!item) return '';
  if (typeof item === 'string') return item.trim();
  return String(item.object_id || item.id || '').trim();
}

function cleanCustomsItems(items) {
  return (Array.isArray(items) ? items : []).map(customsItemId).filter(Boolean);
}

// ======================================================
// ✅ Creates a fresh customs declaration from the old one.
// This fixes: customs_declaration.eel_pfc must not be empty.
// ======================================================
async function createFreshCustomsDeclarationFromOldShipment(oldShipment, order) {
  const oldDeclarationId = pickCustomsDeclarationId(oldShipment);

  if (!oldDeclarationId) {
    return null;
  }

  const oldDeclaration = await shippoFetch(
    `/customs/declarations/${encodeURIComponent(oldDeclarationId)}/`,
    {
      method: 'GET',
      timeoutMs: 25000,
      retries: 2,
    },
  );

  const items = cleanCustomsItems(oldDeclaration?.items);

  if (!items.length) {
    const err = new Error(
      'Cannot create fresh customs declaration: old declaration has no customs item IDs.',
    );
    err.code = 'SHIPPO_FRESH_CUSTOMS_NO_ITEMS';
    err.shippo = {
      oldDeclarationId,
      orderId: order?.orderId || order?._id || '',
    };
    throw err;
  }

  const payload = {
    contents_type: String(oldDeclaration?.contents_type || 'MERCHANDISE').trim() || 'MERCHANDISE',
    contents_explanation:
      String(
        oldDeclaration?.contents_explanation ||
          oldDeclaration?.contentsExplanation ||
          'Merchandise',
      ).trim() || 'Merchandise',
    non_delivery_option:
      String(
        oldDeclaration?.non_delivery_option || oldDeclaration?.nonDeliveryOption || 'RETURN',
      ).trim() || 'RETURN',

    certify: true,
    certify_signer:
      String(
        oldDeclaration?.certify_signer ||
          oldDeclaration?.certifySigner ||
          process.env.SHIPPO_CUSTOMS_CERTIFY_SIGNER ||
          process.env.SHIPPO_FROM_NAME ||
          'Kasyora',
      ).trim() || 'Kasyora',

    // ✅ THIS is the missing field causing your failure.
    eel_pfc: shippoEelPfc(),

    incoterm:
      String(oldDeclaration?.incoterm || process.env.SHIPPO_INCOTERM || 'DDU').trim() || 'DDU',

    items,

    metadata: `fresh-customs-for-order:${order?.orderId || order?._id || ''}`,
  };

  const freshDeclaration = await shippoFetch('/customs/declarations/', {
    method: 'POST',
    body: payload,
    timeoutMs: 30000,
    retries: 2,
  });

  const freshId = String(freshDeclaration?.object_id || freshDeclaration?.id || '').trim();

  if (!freshId) {
    const err = new Error('Fresh customs declaration did not return object_id.');
    err.code = 'SHIPPO_FRESH_CUSTOMS_NO_OBJECT_ID';
    err.shippo = {
      oldDeclarationId,
      freshDeclaration,
    };
    throw err;
  }

  return freshId;
}

// ======================================================
// ✅ Creates a FRESH Shippo shipment by cloning the saved payer shipment.
// This is only for fallback when the payer-selected rate is expired.
// ======================================================
async function createFreshShipmentRatesForOrder(order) {
  if (!order) throw new Error('Order is required');

  const oldShipmentId = String(
    order?.shippo?.payerShipmentId || order?.shippo?.shipmentId || '',
  ).trim();

  if (!oldShipmentId) {
    const err = new Error('Missing saved Shippo shipmentId for fresh fallback shipment.');
    err.code = 'SHIPPO_MISSING_SAVED_SHIPMENT_FOR_FRESH_FALLBACK';
    throw err;
  }

  const oldShipment = await shippoFetch(`/shipments/${encodeURIComponent(oldShipmentId)}/`, {
    method: 'GET',
    timeoutMs: 25000,
    retries: 2,
  });

  const addressFrom = cleanShippoAddress(oldShipment?.address_from);
  const addressTo = cleanShippoAddress(oldShipment?.address_to);

  const parcels = (Array.isArray(oldShipment?.parcels) ? oldShipment.parcels : [])
    .map(cleanShippoParcel)
    .filter((p) => p.length && p.width && p.height && p.weight);

  if (!addressFrom.street1 || !addressFrom.city || !addressFrom.zip || !addressFrom.country) {
    const err = new Error(
      'Cannot create fresh Shippo fallback shipment: old FROM address is incomplete.',
    );
    err.code = 'SHIPPO_FRESH_FALLBACK_FROM_ADDRESS_INCOMPLETE';
    err.shippo = { oldShipmentId };
    throw err;
  }

  if (!addressTo.street1 || !addressTo.city || !addressTo.zip || !addressTo.country) {
    const err = new Error(
      'Cannot create fresh Shippo fallback shipment: old TO address is incomplete.',
    );
    err.code = 'SHIPPO_FRESH_FALLBACK_TO_ADDRESS_INCOMPLETE';
    err.shippo = { oldShipmentId };
    throw err;
  }

  if (!parcels.length) {
    const err = new Error(
      'Cannot create fresh Shippo fallback shipment: old shipment has no usable parcels.',
    );
    err.code = 'SHIPPO_FRESH_FALLBACK_NO_PARCELS';
    err.shippo = { oldShipmentId };
    throw err;
  }

  const customsDeclarationId = await createFreshCustomsDeclarationFromOldShipment(
    oldShipment,
    order,
  );

  const payload = {
    address_from: addressFrom,
    address_to: addressTo,
    parcels,
    async: false,
    ...(customsDeclarationId ? { customs_declaration: customsDeclarationId } : {}),
    metadata: `fresh-fallback-for-order:${order.orderId || order._id}`,
  };

  const freshShipment = await shippoFetch('/shipments/', {
    method: 'POST',
    body: payload,
    timeoutMs: 45000,
    retries: 2,
  });

  const status = String(freshShipment?.object_status || freshShipment?.status || '').toUpperCase();

  if (status && status !== 'SUCCESS') {
    const err = new Error('Fresh Shippo fallback shipment failed.');
    err.code = 'SHIPPO_FRESH_FALLBACK_SHIPMENT_FAILED';
    err.shippo = {
      oldShipmentId,
      freshShipment,
      messages: freshShipment?.messages || null,
    };
    throw err;
  }

  const rates = Array.isArray(freshShipment?.rates) ? freshShipment.rates : [];

  if (!rates.length) {
    const err = new Error('Fresh Shippo fallback shipment returned no rates.');
    err.code = 'SHIPPO_FRESH_FALLBACK_NO_RATES';
    err.shippo = {
      oldShipmentId,
      freshShipmentId: freshShipment?.object_id || null,
      messages: freshShipment?.messages || null,
    };
    throw err;
  }

  return {
    shipment: freshShipment,
    rates,
    oldShipmentId,
    freshShipmentId: freshShipment?.object_id || null,
  };
}

// ------------------------------------------------------
// Poll transaction until label_url exists or terminal state
// ------------------------------------------------------
async function pollTransactionUntilDone(
  tx,
  { attempts = 45, delayMs = 1400, maxDelayMs = 6500 } = {},
) {
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
  const raw = String(providerName || '')
    .trim()
    .toLowerCase();
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
  const shipmentId = String(
    order?.shippo?.payerShipmentId || order?.shippo?.shipmentId || '',
  ).trim();

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
      const err = new Error(
        'Missing shipmentId for strict payer purchase (payerShipmentId must be saved in payment.js).',
      );
      err.code = 'SHIPPO_STRICT_MISSING_SHIPMENT_ID';
      throw err;
    }

    const got = await getShipmentAndRatesOrThrow(shipmentId);
    shipment = got.shipment;

    const exact = got.rates.find((r) => String(r?.object_id || '').trim() === rateId);
    if (!exact) {
      const err = new Error(
        'Payer-selected rateId is not found on the payer shipment (expired or wrong shipment).',
      );
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
      shipmentId: shipment?.object_id || shipmentId || null,
    };
    throw err;
  }

  const carrierToken =
    providerToShippoCarrierToken(chosenRate?.provider) ||
    providerToShippoCarrierToken(tx?.provider) ||
    null;

  return {
    shipment, // may be null in non-strict
    chosenRate, // best-effort
    transaction: tx,
    trackingNumber: tx?.tracking_number || null,
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
    const err = new Error(
      'Missing Shippo shipmentId on order. payment.js must create shipment + save payerShipmentId.',
    );
    err.code = 'SHIPPO_MISSING_SAVED_SHIPMENT';
    err.details = { orderId: order?.orderId || order?._id };
    throw err;
  }

  const { shipment, rates } = await pollShipmentUntilRates(shipmentId, {
    attempts: 18,
    delayMs: 900,
  });
  return { shipment, rates, reused: true };
}

module.exports = {
  createLabelForOrder,
  getRatesForOrder,
  createFreshShipmentRatesForOrder,
};
