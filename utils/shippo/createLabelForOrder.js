// utils/shippo/createLabelForOrder.js
'use strict';

const { fetch } = require('undici');
const { setTimeout: delay } = require('node:timers/promises');

const SHIPPO_BASE = 'https://api.goshippo.com';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function shippoFetch(path, { method = 'GET', body, timeoutMs = 20000, retries = 2 } = {}) {
  const token = mustEnv('SHIPPO_TOKEN');

  // retry on gateway/timeouts + rate limits + transient server errors
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

      // 504 / 502 sometimes returns HTML, so DON'T do r.json() directly
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
          (typeof data?.raw === 'string' && data.raw.trim() ? data.raw.slice(0, 160) : '') ||
          `Shippo error (${status})`;

        const err = new Error(msg);
        err.status = status;
        err.shippo = data;

        // retry transient statuses
        if (RETRY_STATUSES.has(status) && attempt < retries) {
          const backoff = 600 * Math.pow(2, attempt); // 600ms, 1200ms, ...
          await delay(backoff);
          continue;
        }

        throw err;
      }

      return data;
    } catch (e) {
      clearTimeout(t);

      // Abort/timeout -> retry
      const isAbort =
        e?.name === 'AbortError' ||
        String(e?.message || '').toLowerCase().includes('aborted');

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

function buildFromAddress() {
  return {
    name: mustEnv('SHIPPO_FROM_NAME'),
    phone: mustEnv('SHIPPO_FROM_PHONE'),
    email: process.env.SHIPPO_FROM_EMAIL || undefined,
    street1: mustEnv('SHIPPO_FROM_STREET1'),
    city: mustEnv('SHIPPO_FROM_CITY'),
    state: mustEnv('SHIPPO_FROM_STATE'),
    zip: mustEnv('SHIPPO_FROM_ZIP'),
    country: mustEnv('SHIPPO_FROM_COUNTRY'),
  };
}

function buildParcel() {
  return {
    length: String(mustEnv('SHIPPO_PARCEL_LENGTH')),
    width: String(mustEnv('SHIPPO_PARCEL_WIDTH')),
    height: String(mustEnv('SHIPPO_PARCEL_HEIGHT')),
    distance_unit: String(mustEnv('SHIPPO_PARCEL_DISTANCE_UNIT')),
    // ✅ Use your existing env naming
    weight: String(
      process.env.SHIPPO_PARCEL_WEIGHT ||
      process.env.SHIPPO_PARCEL_WEIGHT_PER_ITEM ||
      '0.5'
    ),
    mass_unit: String(mustEnv('SHIPPO_PARCEL_MASS_UNIT')),
  };
}

function pickStr(...vals) {
  for (const v of vals) {
    const s = v === undefined || v === null ? '' : String(v).trim();
    if (s) return s;
  }
  return '';
}

function pickUpper(...vals) {
  const s = pickStr(...vals);
  return s ? s.toUpperCase() : '';
}

function normalizePhoneE164(rawPhone, country2) {
  const raw = String(rawPhone || '').trim();
  const cc = String(country2 || '').trim().toUpperCase();

  // Already E.164
  if (/^\+\d{10,15}$/.test(raw)) return raw;

  // Digits only
  const digits = raw.replace(/[^\d]/g, '');

  // South Africa: 0XXXXXXXXX -> +27XXXXXXXXX
  if (cc === 'ZA') {
    if (digits.length === 10 && digits.startsWith('0')) return `+27${digits.slice(1)}`;
    if (digits.length === 11 && digits.startsWith('27')) return `+${digits}`;
  }

  // UK basic (if ever used)
  if (cc === 'GB') {
    if (digits.length >= 10 && digits.startsWith('0')) return `+44${digits.slice(1)}`;
    if (digits.startsWith('44')) return `+${digits}`;
  }

  // US basic
  if (cc === 'US') {
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  }

  // Generic fallback
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;

  return ''; // invalid
}

function readPaypalShipping(order) {
  const pu = order?.paypal?.purchase_units?.[0] || null;
  const ship = pu?.shipping || null;
  const addr = ship?.address || null;
  const name = ship?.name || null;
  return { ship, addr, name };
}

function mapOrderToShippoToAddress(order) {
  const s = order.shipping || {};
  const { addr: ppAddr, name: ppName } = readPaypalShipping(order);

  const fullName =
    pickStr(
      s.name,
      ppName?.full_name,
      order?.payer?.name?.full_name,
      order?.payer?.name?.full,
      [order?.payer?.name?.given_name, order?.payer?.name?.surname].filter(Boolean).join(' ')
    ) || 'Customer';

  // ✅ Do NOT default to US. Default to your FROM country (ZA).
  const countryGuess =
    pickUpper(s.country_code, s.country, ppAddr?.country_code) ||
    String(process.env.SHIPPO_FROM_COUNTRY || 'ZA').toUpperCase();

  const rawPhone =
    pickStr(s.phone, order?.payer?.phone, order?.payer?.phone_number, order?.payer?.phone?.phone_number) || '';

  const phoneNorm = normalizePhoneE164(rawPhone, countryGuess);

  // Keep your safe fallback (still ok for dev/testing)
  const phone = phoneNorm || '+14155550123';

  const email = pickStr(s.email, order?.payer?.email, order?.payer?.email_address) || undefined;

  const street1 = pickStr(s.address_line_1, s.street1, s.line1, ppAddr?.address_line_1);
  const street2 = pickStr(s.address_line_2, s.street2, s.line2, ppAddr?.address_line_2) || undefined;
  const city = pickStr(s.admin_area_2, s.city, ppAddr?.admin_area_2);
  const state = pickStr(s.admin_area_1, s.state, ppAddr?.admin_area_1);
  const zip = pickStr(s.postal_code, s.zip, ppAddr?.postal_code);
  const country = pickUpper(s.country_code, s.country, ppAddr?.country_code);

  return {
    name: fullName,
    street1,
    street2,
    city,
    state,
    zip,
    country,
    phone,
    email,
    is_residential: true,
  };
}

function requireToFields(addressTo) {
  const missing = [];
  const country = String(addressTo?.country || '').toUpperCase();

  if (!addressTo.street1) missing.push('street1');
  if (!addressTo.city) missing.push('city');
  if (!addressTo.country) missing.push('country');

  if (country === 'US') {
    if (!addressTo.state) missing.push('state');
    if (!addressTo.zip) missing.push('zip');
  } else {
    if (!addressTo.zip) missing.push('zip');
  }

  if (missing.length) {
    const err = new Error(`Order missing shipping fields: ${missing.join(', ')}`);
    err.details = { address_to: addressTo };
    throw err;
  }
}

function normalizeAddressTo(addressTo) {
  const a = { ...addressTo };

  a.street1 = pickStr(a.street1);
  a.street2 = pickStr(a.street2) || undefined;
  a.city = pickStr(a.city);
  a.state = pickStr(a.state);
  a.zip = pickStr(a.zip);
  a.country = pickUpper(a.country);

  if (a.country === 'US') {
    const STATE_MAP = {
      CALIFORNIA: 'CA',
      NEWYORK: 'NY',
      'NEW YORK': 'NY',
      TEXAS: 'TX',
      FLORIDA: 'FL',
    };

    const raw = a.state.toUpperCase();
    if (raw.length !== 2) {
      const mapped = STATE_MAP[raw] || STATE_MAP[raw.replace(/\./g, '')] || '';
      if (mapped) a.state = mapped;
    }

    const zipOk = /^\d{5}(-\d{4})?$/.test(a.zip);
    if (!zipOk) {
      const err = new Error(`Invalid US ZIP code saved on order: "${a.zip}"`);
      err.details = { address_to: a };
      throw err;
    }

    if (a.state.length !== 2) {
      const err = new Error(`Invalid US state code saved on order: "${a.state}"`);
      err.details = { address_to: a };
      throw err;
    }
  }

  return a;
}

async function pollTransactionUntilDone(tx, { attempts = 45, delayMs = 1400, maxDelayMs = 6500 } = {}) {
  let cur = tx;

  for (let i = 0; i < attempts; i++) {
    const label = cur?.label_url;
    const st = String(cur?.status || cur?.object_status || '').toUpperCase();

    // ✅ Success: label ready
    if (label) return cur;

    // ✅ If Shippo says SUCCESS but still no label_url, stop polling and return
    if (st === 'SUCCESS') return cur;

    // ✅ Hard stop: error states
    if (st === 'ERROR' || st === 'FAILED') return cur;

    // ✅ Can't poll without an id
    if (!cur?.object_id) return cur;

    // ✅ Many accounts return QUEUED / WAITING / VALIDATING first
    // We'll keep polling a bit longer than before.
    const wait = Math.min(maxDelayMs, delayMs + (i * 150)); // small ramp up
    await delay(wait);

    // Always re-fetch full transaction state
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

  // "DHL Express" -> "dhl_express"
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function pickSameAsSavedRate(rates, saved) {
  if (!saved) return null;

  const wantProv = String(saved.provider || '').trim().toLowerCase();
  const wantSvc  = String(saved.service || '').trim().toLowerCase();

  if (!wantProv && !wantSvc) return null;

  // Try strong match: provider + servicelevel token/name
  const strong = rates.find(r => {
    const prov = String(r?.provider || '').trim().toLowerCase();
    const token = String(r?.servicelevel?.token || '').trim().toLowerCase();
    const name  = String(r?.servicelevel?.name || '').trim().toLowerCase();
    const svcMatch = wantSvc && (token === wantSvc || name === wantSvc || name.includes(wantSvc) || token.includes(wantSvc));
    const provMatch = wantProv && prov === wantProv;
    return provMatch && svcMatch;
  });
  if (strong) return strong;

  // If service doesn't match, still try provider-only
  if (wantProv) {
    const provOnly = rates.find(r => String(r?.provider || '').trim().toLowerCase() === wantProv);
    if (provOnly) return provOnly;
  }

  return null;
}

// ======================================================
// ✅ Poll shipment until rates are ready (prevents "rates: []" forever)
// ======================================================
async function pollShipmentUntilRates(shipmentId, { attempts = 18, delayMs = 900 } = {}) {
  let last = null;

  for (let i = 0; i < attempts; i++) {
    const cur = await shippoFetch(`/shipments/${encodeURIComponent(String(shipmentId))}/`, {
      method: 'GET',
      timeoutMs: 20000,
      retries: 1,
    });

    last = cur;

    const st = String(cur?.object_status || cur?.status || '').toUpperCase();
    const rates = Array.isArray(cur?.rates) ? cur.rates : [];

    // ✅ Success: rates ready
    if (rates.length) return { shipment: cur, rates };

    // ✅ Hard stop: Shippo says shipment failed/error
    if (st === 'ERROR' || st === 'FAILED') {
      const err = new Error('Shippo shipment failed to produce rates.');
      err.shippo = { shipment: cur };
      throw err;
    }

    // Wait and try again
    await delay(delayMs + i * 120);
  }

  // After attempts, still no rates
  const err = new Error('Shippo rates are still not ready. Please retry.');
  err.shippo = { shipment: last };
  throw err;
}

async function getShipmentAndRatesOrThrow(shipmentId) {
  if (!shipmentId) {
    const err = new Error('Missing Shippo shipmentId for strict rate purchase.');
    err.code = 'SHIPPO_MISSING_SHIPMENT_ID';
    throw err;
  }

  let shipment = await shippoFetch(`/shipments/${encodeURIComponent(String(shipmentId))}/`, {
    method: 'GET',
    timeoutMs: 20000,
    retries: 2,
  });

  // If rates are async/empty, poll until ready
  if (shipment?.object_id && (!Array.isArray(shipment.rates) || shipment.rates.length === 0)) {
    const polled = await pollShipmentUntilRates(shipment.object_id, { attempts: 18, delayMs: 900 });
    shipment = polled.shipment;
  }

  const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];
  if (!rates.length) {
    const err = new Error('Shippo shipment has no rates (still queued or failed).');
    err.code = 'SHIPPO_NO_RATES_ON_SHIPMENT';
    err.shippo = { shipment };
    throw err;
  }

  return { shipment, rates };
}

async function createLabelForOrder(order, opts = {}) {
  if (!order) throw new Error('Order is required');

  const strictRateId = !!opts.strictRateId;

  let chooseRate = String(opts.chooseRate || 'cheapest');
  let rateId = opts.rateId ? String(opts.rateId).trim() : null;

  // ======================================================
  // ✅ STRICT MODE: buy EXACT payer rateId from payerShipmentId ONLY
  // ======================================================
  if (strictRateId) {
    if (!rateId) {
      const err = new Error('Strict mode requires a rateId.');
      err.code = 'SHIPPO_STRICT_MISSING_RATE_ID';
      throw err;
    }

    const shipmentId =
      String(opts.shipmentId || '').trim() ||
      String(order?.shippo?.payerShipmentId || '').trim() ||
      '';

    if (!shipmentId) {
      const err = new Error(
        'Cannot buy exact payer rateId because payerShipmentId was not saved on the order.'
      );
      err.code = 'SHIPPO_PAYER_SHIPMENT_NOT_SAVED';
      err.details = { orderId: order?.orderId || order?._id, rateId };
      throw err;
    }

    // ✅ Load ORIGINAL shipment and confirm the exact rateId exists on it
    const { shipment, rates } = await getShipmentAndRatesOrThrow(shipmentId);

    const exact = rates.find((r) => String(r?.object_id || '').trim() === String(rateId).trim());
    if (!exact) {
      const err = new Error(
        'Payer-selected rateId is not found on the payer shipment (expired or wrong shipment).'
      );
      err.code = 'SHIPPO_RATE_NOT_ON_PAYER_SHIPMENT';
      err.shippo = {
        payerShipmentId: shipment?.object_id || shipmentId,
        attemptedRateId: rateId,
        rateCount: rates.length,
      };
      throw err; // ✅ NO fallback
    }

    // ✅ Buy EXACT rateId
    let tx = await shippoFetch('/transactions/', {
      method: 'POST',
      body: {
        rate: exact.object_id,
        label_file_type: process.env.SHIPPO_LABEL_FILE_TYPE || 'PDF',
        async: true,
        metadata: `order:${order.orderId || order._id}`,
      },
      timeoutMs: 20000,
      retries: 2,
    });

    if (!tx?.label_url) tx = await pollTransactionUntilDone(tx);

    if (!tx?.label_url) {
      const status = tx?.status || tx?.object_status || 'UNKNOWN';
      const messages = tx?.messages || tx?.validation_results || null;

      const err = new Error('Shippo did not return a label_url.');
      err.code = 'SHIPPO_NO_LABEL_URL';
      err.shippo = {
        status,
        messages,
        transaction: tx,
        chosenRate: exact,
        shipmentId: shipment?.object_id || shipmentId,
      };
      throw err;
    }

    const carrierToken =
      providerToShippoCarrierToken(exact?.provider) ||
      providerToShippoCarrierToken(tx?.provider) ||
      null;

    return {
      shipment,
      chosenRate: exact,
      transaction: tx,
      carrierEnum: null,
      carrierToken,
    };
  }

  // ======================================================
  // ✅ NON-STRICT "direct rateId buy" (optional safe)
  // If someone passes rateId without strictRateId, we just buy it.
  // ======================================================
  if (rateId) {
    let tx = await shippoFetch('/transactions/', {
      method: 'POST',
      body: {
        rate: rateId,
        label_file_type: process.env.SHIPPO_LABEL_FILE_TYPE || 'PDF',
        async: true,
        metadata: `order:${order.orderId || order._id}`,
      },
      timeoutMs: 20000,
      retries: 2,
    });

    if (!tx?.label_url) tx = await pollTransactionUntilDone(tx);

    if (!tx?.label_url) {
      const status = tx?.status || tx?.object_status || 'UNKNOWN';
      const messages = tx?.messages || tx?.validation_results || null;

      const err = new Error('Shippo did not return a label_url.');
      err.code = 'SHIPPO_NO_LABEL_URL';
      err.shippo = { status, messages, transaction: tx, rateId };
      throw err;
    }

    // best-effort carrier token
    const providerName =
      String(opts?.savedRate?.provider || '').trim() ||
      String(tx?.provider || '').trim();

    const carrierToken = providerToShippoCarrierToken(providerName) || null;

    return {
      shipment: null,
      chosenRate: { object_id: rateId, provider: providerName || null },
      transaction: tx,
      carrierEnum: null,
      carrierToken,
    };
  }

  // ======================================================
  // ✅ Normal flow (no rateId): create shipment -> pick rate -> buy
  // ======================================================
  const address_from = buildFromAddress();
  let address_to = mapOrderToShippoToAddress(order);
  requireToFields(address_to);
  address_to = normalizeAddressTo(address_to);

  const parcel = buildParcel();

  const fromC = String(address_from.country || '').toUpperCase();
  const toC = String(address_to.country || '').toUpperCase();
  const isInternational = !!fromC && !!toC && fromC !== toC;

    let customs_declaration = undefined;

  if (isInternational) {
    customs_declaration = order?.shippo?.customsDeclarationId
      ? String(order.shippo.customsDeclarationId).trim()
      : '';

    // ✅ IMPORTANT: do NOT create customs here. Payment.js must have saved it.
    if (!customs_declaration) {
      const err = new Error(
        'International shipment is missing shippo.customsDeclarationId (must be created/saved in payment.js).'
      );
      err.code = 'SHIPPO_CUSTOMS_MISSING_ON_ORDER';
      err.details = { orderId: order?.orderId || order?._id };
      throw err;
    }
  }

  // ✅ Reuse existing shipment if possible
  let shipment = null;
  const existingShipmentId = order?.shippo?.shipmentId ? String(order.shippo.shipmentId).trim() : '';

  if (existingShipmentId) {
    try {
      let existing = await shippoFetch(`/shipments/${encodeURIComponent(existingShipmentId)}/`, {
        method: 'GET',
        timeoutMs: 20000,
        retries: 2,
      });

      if (existing?.object_id && (!Array.isArray(existing.rates) || existing.rates.length === 0)) {
        const polled = await pollShipmentUntilRates(existing.object_id, { attempts: 18, delayMs: 900 });
        existing = polled.shipment;
      }

      if (existing?.object_id && Array.isArray(existing.rates) && existing.rates.length) {
        shipment = existing;
      }
    } catch {
      // ignore
    }
  }

  // ✅ Create new shipment if no reusable one
  if (!shipment) {
    shipment = await shippoFetch('/shipments/', {
      method: 'POST',
      body: {
        address_from,
        address_to,
        parcels: [parcel],
        async: true,
        metadata: `order:${order.orderId || order._id}`,
        ...(customs_declaration ? { customs_declaration } : {}),
      },
      timeoutMs: 20000,
      retries: 2,
    });

    if (shipment?.object_id && (!Array.isArray(shipment.rates) || shipment.rates.length === 0)) {
      const polled = await pollShipmentUntilRates(shipment.object_id);
      shipment = polled.shipment;
    }

    // ✅ Cache shipment id for reuse
    try {
      const sid = shipment?.object_id ? String(shipment.object_id).trim() : '';
      if (sid) {
        order.shippo = order.shippo || {};
        if (!order.shippo.shipmentId) order.shippo.shipmentId = sid;
        if (typeof order.save === 'function') await order.save();
      }
    } catch {
      // non-fatal
    }
  }

  const rates = Array.isArray(shipment?.rates) ? shipment.rates : [];
  if (!rates.length) {
    const err = new Error('No Shippo rates returned (check carrier accounts + address).');
    err.shippo = { shipment };
    throw err;
  }

  let chosen = rates[0];

  if (chooseRate === 'payer') {
    const payerRateId = order?.shippo?.payerRateId ? String(order.shippo.payerRateId).trim() : '';
    const exact = payerRateId ? rates.find((r) => String(r?.object_id || '').trim() === payerRateId) : null;

    if (exact) {
      chosen = exact;
    } else {
      const saved = opts?.savedRate || order?.shippo?.chosenRate || null;
      const same = pickSameAsSavedRate(rates, saved);
      chosen = same || rates.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];
    }
  } else if (chooseRate === 'fastest') {
    const withEta = rates.filter((r) => r.estimated_days != null);
    chosen = (withEta.length ? withEta : rates)
      .slice()
      .sort((a, b) => {
        const da = a.estimated_days == null ? 9999 : Number(a.estimated_days);
        const db = b.estimated_days == null ? 9999 : Number(b.estimated_days);
        if (da !== db) return da - db;
        return Number(a.amount) - Number(b.amount);
      })[0];
  } else {
    chosen = rates.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  }

  let tx = await shippoFetch('/transactions/', {
    method: 'POST',
    body: {
      rate: chosen.object_id,
      label_file_type: process.env.SHIPPO_LABEL_FILE_TYPE || 'PDF',
      async: true,
      metadata: `order:${order.orderId || order._id}`,
    },
    timeoutMs: 20000,
    retries: 2,
  });

  if (!tx?.label_url) tx = await pollTransactionUntilDone(tx);

  if (!tx?.label_url) {
    const status = tx?.status || tx?.object_status || 'UNKNOWN';
    const messages = tx?.messages || tx?.validation_results || null;

    const err = new Error('Shippo did not return a label_url.');
    err.shippo = { status, messages, transaction: tx, chosenRate: chosen };
    throw err;
  }

  const providerName = String(chosen?.provider || '').trim();
  const carrierToken = providerToShippoCarrierToken(providerName);

  return {
    shipment,
    chosenRate: chosen,
    transaction: tx,
    carrierEnum: null,
    carrierToken,
  };
}

async function getRatesForOrder(order) {
  if (!order) throw new Error('Order is required');

  // ✅ 1) Try reuse saved shipment first (FAST, matches payerRateId)
  const savedShipmentId =
    order?.shippo?.shipmentId ||
    order?.shippo?.payerShipmentId ||
    null;

  if (savedShipmentId) {
    try {
      // Try shipment object
      const existing = await shippoFetch(`/shipments/${encodeURIComponent(String(savedShipmentId))}/`, {
        method: 'GET',
        timeoutMs: 20000,
        retries: 2,
      });

      let rates = Array.isArray(existing?.rates) ? existing.rates : [];

      // ✅ If Shippo returns QUEUED with empty rates, poll shipment until rates appear
      if (!rates.length && existing?.object_id) {
        const polled = await pollShipmentUntilRates(existing.object_id, { attempts: 14, delayMs: 850 });
        return { shipment: polled.shipment, rates: polled.rates, reused: true };
      }

      if (existing?.object_id && rates.length) {
        return { shipment: existing, rates, reused: true };
      }

      // else fall through to rerate
    } catch {
      // saved shipment may be expired or Shippo may be temporarily failing; fallback below
    }
  }

  // ✅ 2) Fallback: create a NEW shipment (rerate)
  const address_from = buildFromAddress();
  let address_to = mapOrderToShippoToAddress(order);
  requireToFields(address_to);
  address_to = normalizeAddressTo(address_to);

  const parcel = buildParcel();

  const fromC = String(address_from.country || '').toUpperCase();
  const toC   = String(address_to.country || '').toUpperCase();

  // Only international if BOTH are present and different
  const isInternational = !!fromC && !!toC && fromC !== toC;

  let customs_declaration = undefined;

  if (isInternational) {
    customs_declaration = order?.shippo?.customsDeclarationId
      ? String(order.shippo.customsDeclarationId).trim()
      : '';

    // ✅ IMPORTANT: do NOT create customs here. Payment.js must have saved it.
    if (!customs_declaration) {
      const err = new Error(
        'International shipment is missing shippo.customsDeclarationId (must be created/saved in payment.js).'
      );
      err.code = 'SHIPPO_CUSTOMS_MISSING_ON_ORDER';
      err.details = { orderId: order?.orderId || order?._id };
      throw err;
    }
  }

  let shipment = await shippoFetch('/shipments/', {
  method: 'POST',
  body: {
    address_from,
    address_to,
    parcels: [parcel],
    async: true, // ✅ allow async rating
    metadata: `order:${order.orderId || order._id}`,
    ...(customs_declaration ? { customs_declaration } : {}),
  },
  timeoutMs: 20000,
  retries: 2,
});

// ✅ Poll until rates exist (prevents infinite loader)
if (shipment?.object_id && (!Array.isArray(shipment.rates) || shipment.rates.length === 0)) {
  const polled = await pollShipmentUntilRates(shipment.object_id, { attempts: 16, delayMs: 900 });
  shipment = polled.shipment;
}

const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
return { shipment, rates, reused: false };
}

module.exports = { createLabelForOrder, getRatesForOrder };
