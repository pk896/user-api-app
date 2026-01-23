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

async function shippoFetch(path, { method = 'GET', body } = {}) {
  const token = mustEnv('SHIPPO_TOKEN');

  const r = await fetch(`${SHIPPO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `ShippoToken ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.detail || data?.message || `Shippo error (${r.status})`;
    const err = new Error(msg);
    err.shippo = data;
    throw err;
  }
  return data;
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
    weight: String(mustEnv('SHIPPO_PARCEL_WEIGHT')),
    mass_unit: String(mustEnv('SHIPPO_PARCEL_MASS_UNIT')),
  };
}

function pickStr(...vals) {
  for (const v of vals) {
    const s = (v === undefined || v === null) ? '' : String(v).trim();
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
    // if starts with 0, drop it and add +44
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

function toNumber(v, fallback = 0) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function buildCustomsItemsFromOrder(order) {
  const items = Array.isArray(order?.items) ? order.items : [];

  // Shippo requires at least 1 customs item for international
  const customsItems = items.map((it, idx) => {
    const name = String(it?.name || `Item ${idx + 1}`).slice(0, 50);

    // quantity must be integer string
    const qty = Math.max(1, Math.floor(toNumber(it?.quantity, 1)));

    // Use gross if you want (customs value), or net; just be consistent.
    const unitVal =
      toNumber(it?.priceGross?.value, NaN) ||
      toNumber(it?.price?.value, NaN) ||
      toNumber(it?.price, NaN) ||
      1;

    // Very important: customs needs weight.
    // If you don't store per-item weight yet, use a small default for testing.
    // Later we can use product.weight from DB.
    const weight = 0.2; // kg default per item (testing)

    return {
      description: name,
      quantity: String(qty),
      net_weight: String(weight),
      mass_unit: 'kg',
      value_amount: String(unitVal.toFixed(2)),
      value_currency: (order?.amount?.currency || 'USD').toUpperCase(),

      // Required-ish fields; safe defaults for testing
      origin_country: (process.env.SHIPPO_FROM_COUNTRY || 'US').toUpperCase(),
      tariff_number: '0000.00.00',
    };
  });

  // If order has no items for some reason, create a safe fallback
  if (!customsItems.length) {
    customsItems.push({
      description: 'Merchandise',
      quantity: '1',
      net_weight: '0.2',
      mass_unit: 'kg',
      value_amount: '1.00',
      value_currency: (order?.amount?.currency || 'USD').toUpperCase(),
      origin_country: (process.env.SHIPPO_FROM_COUNTRY || 'US').toUpperCase(),
      tariff_number: '0000.00.00',
    });
  }

  return customsItems;
}

function readPaypalShipping(order) {
  // common shapes seen in apps:
  // order.paypal.purchase_units[0].shipping.address
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

    const countryGuess =
    pickUpper(s.country_code, s.country, ppAddr?.country_code) || 'US';

  const rawPhone =
    pickStr(
      s.phone,
      order?.payer?.phone,
      order?.payer?.phone_number,
      order?.payer?.phone?.phone_number
    ) || '';

  const phoneNorm = normalizePhoneE164(rawPhone, countryGuess);

  // Shippo/USPS needs a valid phone for some services
  // If you prefer to hard-fail instead of using fallback, see comment below.
  const phone = phoneNorm || '+14155550123'; // safe fallback (dev/testing)

  const email =
    pickStr(
      s.email,
      order?.payer?.email,
      order?.payer?.email_address
    ) || undefined;

  // Prefer your saved shipping, else PayPal shipping address
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

  // ✅ State/ZIP rules:
  // - US: requires state + zip
  // - Other countries: state is often optional; zip is usually required but not always.
  //   We keep zip required for now because most Shippo rating needs it.
  if (country === 'US') {
    if (!addressTo.state) missing.push('state');
    if (!addressTo.zip) missing.push('zip');
  } else {
    if (!addressTo.zip) missing.push('zip');
    // state is optional outside US
  }

  if (missing.length) {
    const err = new Error(`Order missing shipping fields: ${missing.join(', ')}`);
    err.details = { address_to: addressTo };
    throw err;
  }
}

function normalizeAddressTo(addressTo) {
  const a = { ...addressTo };

  // trim fields
  a.street1 = pickStr(a.street1);
  a.street2 = pickStr(a.street2) || undefined;
  a.city = pickStr(a.city);
  a.state = pickStr(a.state);
  a.zip = pickStr(a.zip);
  a.country = pickUpper(a.country);

  // If country is US, enforce 2-letter state + ZIP
  if (a.country === 'US') {
    // common bad cases: "California" instead of "CA"
    // You can extend this map if needed.
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

    // Basic ZIP sanity (5 digits or 5-4)
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

async function pollTransactionUntilDone(tx, { attempts = 10, delayMs = 1200 } = {}) {
  let cur = tx;

  for (let i = 0; i < attempts; i++) {
    const label = cur?.label_url;
    const st = String(cur?.status || cur?.object_status || '').toUpperCase();

    if (label) return cur;

    // If ERROR, stop immediately
    if (st === 'ERROR' || st === 'FAILED') return cur;

    // If we can’t poll, stop
    if (!cur?.object_id) return cur;

    // Wait then poll
    await delay(delayMs);
    cur = await shippoFetch(`/transactions/${encodeURIComponent(cur.object_id)}/`, { method: 'GET' });
  }

  return cur;
}

async function createLabelForOrder(order, { chooseRate = 'cheapest', rateId = null } = {}) {
  if (!order) throw new Error('Order is required');

  const address_from = buildFromAddress();
  let address_to = mapOrderToShippoToAddress(order);
  requireToFields(address_to);
  address_to = normalizeAddressTo(address_to);


  const parcel = buildParcel();

    const isInternational =
    String(address_from.country || '').toUpperCase() !== String(address_to.country || '').toUpperCase();

  let customs_declaration = undefined;

  if (isInternational) {
    // 1) create customs items
    const customsItems = buildCustomsItemsFromOrder(order);

    const createdItems = [];
    for (const ci of customsItems) {
      const item = await shippoFetch('/customs/items/', { method: 'POST', body: ci });
      createdItems.push(item.object_id);
    }

    // 2) create customs declaration
    const decl = await shippoFetch('/customs/declarations/', {
      method: 'POST',
      body: {
        contents_type: 'MERCHANDISE',
        non_delivery_option: 'RETURN',
        certify: true,
        certify_signer: process.env.SHIPPO_CUSTOMS_SIGNER || (address_from.name || 'Sender'),
        items: createdItems,
        eel_pfc: 'NOEEI_30_37_a', // safe for low-value / test; we can adjust later
        incoterm: 'DDU',
      },
    });

    customs_declaration = decl.object_id;
  }

  // 1) Shipment -> rates
  const shipment = await shippoFetch('/shipments/', {
    method: 'POST',
    body: {
      address_from,
      address_to,
      parcels: [parcel],
      async: false,
      metadata: `order:${order.orderId || order._id}`,

      ...(customs_declaration ? { customs_declaration } : {}),
    },
  });

  const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
  if (!rates.length) {
    const err = new Error('No Shippo rates returned (check carrier accounts + address).');
    err.shippo = { shipment };
    throw err;
  }

  let chosen = rates[0];

  // ✅ If admin selected a specific rateId, use it
  if (rateId) {
    const found = rates.find(r => String(r.object_id) === String(rateId));
    if (!found) {
      const err = new Error('Selected rate not found for this shipment.');
      err.shippo = { rateId, ratesCount: rates.length };
      throw err;
    }
    chosen = found;
  } else if (chooseRate === 'fastest') {
    // fastest: lowest estimated_days (fallback to cheapest)
    const withEta = rates.filter(r => r.estimated_days != null);
    chosen = (withEta.length ? withEta : rates)
      .slice()
      .sort((a, b) => {
        const da = a.estimated_days == null ? 9999 : Number(a.estimated_days);
        const db = b.estimated_days == null ? 9999 : Number(b.estimated_days);
        if (da !== db) return da - db;
        return Number(a.amount) - Number(b.amount);
      })[0];
  } else {
    // default cheapest
    chosen = rates.slice().sort((a, b) => Number(a.amount) - Number(b.amount))[0];
  }

  // 2) Buy label -> transaction
  let tx = await shippoFetch('/transactions/', {
    method: 'POST',
    body: {
      rate: chosen.object_id,
      label_file_type: process.env.SHIPPO_LABEL_FILE_TYPE || 'PDF',
      async: false,
      metadata: `order:${order.orderId || order._id}`,
    },
  });

  // 3) Poll if label_url isn’t ready yet
  if (!tx?.label_url) {
    tx = await pollTransactionUntilDone(tx);
  }

  // 4) If still no label_url, throw detailed error
  if (!tx?.label_url) {
    const status = tx?.status || tx?.object_status || 'UNKNOWN';
    const messages = tx?.messages || tx?.validation_results || null;

    const err = new Error('Shippo did not return a label_url.');
    err.shippo = { status, messages, transaction: tx, chosenRate: chosen };
    throw err;
  }

  // ✅ Build a carrier value that can match your Order enum (usually "USPS" / "UPS")
  const providerName = String(chosen?.provider || '').trim(); // e.g. "USPS"
  const carrierEnum =
    providerName.toUpperCase() === 'USPS' ? 'USPS' :
    providerName.toUpperCase() === 'UPS'  ? 'UPS'  :
    null;

  return {
    shipment,
    chosenRate: chosen,
    transaction: tx,

    // ✅ extra fields for saving safely in Mongo
    carrierEnum, // "USPS" / "UPS" / null
    carrierToken: providerName ? providerName.toLowerCase() : null, // "usps" / "ups"
  };
}

async function getRatesForOrder(order) {
  if (!order) throw new Error('Order is required');

  const address_from = buildFromAddress();
  let address_to = mapOrderToShippoToAddress(order);
  requireToFields(address_to);
  address_to = normalizeAddressTo(address_to);

  const parcel = buildParcel();

  const isInternational =
    String(address_from.country || '').toUpperCase() !== String(address_to.country || '').toUpperCase();

  let customs_declaration = undefined;

  if (isInternational) {
    const customsItems = buildCustomsItemsFromOrder(order);

    const createdItems = [];
    for (const ci of customsItems) {
      const item = await shippoFetch('/customs/items/', { method: 'POST', body: ci });
      createdItems.push(item.object_id);
    }

    const decl = await shippoFetch('/customs/declarations/', {
      method: 'POST',
      body: {
        contents_type: 'MERCHANDISE',
        non_delivery_option: 'RETURN',
        certify: true,
        certify_signer: process.env.SHIPPO_CUSTOMS_SIGNER || (address_from.name || 'Sender'),
        items: createdItems,
        eel_pfc: 'NOEEI_30_37_a',
        incoterm: 'DDU',
      },
    });

    customs_declaration = decl.object_id;
  }

  const shipment = await shippoFetch('/shipments/', {
    method: 'POST',
    body: {
      address_from,
      address_to,
      parcels: [parcel],
      async: false,
      metadata: `order:${order.orderId || order._id}`,
      ...(customs_declaration ? { customs_declaration } : {}),
    },
  });

  const rates = Array.isArray(shipment.rates) ? shipment.rates : [];
  return { shipment, rates };
}

module.exports = { createLabelForOrder, getRatesForOrder };
