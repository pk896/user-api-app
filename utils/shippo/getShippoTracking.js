// utils/shippo/getShippoTracking.js
'use strict';

const { fetch } = require('undici');

const SHIPPO_BASE = 'https://api.goshippo.com';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

// ✅ safer fetch: handles non-JSON error bodies + timeout
async function shippoFetch(path, { timeoutMs = 15000 } = {}) {
  const token = mustEnv('SHIPPO_TOKEN');

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const r = await fetch(`${SHIPPO_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `ShippoToken ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    const text = await r.text().catch(() => '');
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      const detailText = Array.isArray(data?.detail)
        ? JSON.stringify(data.detail)
        : (typeof data?.detail === 'object' && data?.detail !== null)
        ? JSON.stringify(data.detail)
        : data?.detail;

      const messageText = Array.isArray(data?.message)
        ? JSON.stringify(data.message)
        : (typeof data?.message === 'object' && data?.message !== null)
        ? JSON.stringify(data.message)
        : data?.message;

      const msg =
        detailText ||
        messageText ||
        (typeof data?.raw === 'string' && data.raw.trim() ? data.raw.slice(0, 180) : '') ||
        `Shippo error (${r.status})`;

      const err = new Error(msg);
      err.status = r.status;
      err.shippo = data;
      throw err;
    }

    return data;
  } finally {
    clearTimeout(t);
  }
}

function mapShippoStatus(s) {
  const status = String(s || '').toUpperCase();

  // ✅ Only return values allowed by your Order model:
  // ['PENDING','PROCESSING','SHIPPED','IN_TRANSIT','DELIVERED','CANCELLED']

  if (status === 'DELIVERED') return 'DELIVERED';
  if (status === 'TRANSIT') return 'IN_TRANSIT';
  if (status === 'PRE_TRANSIT') return 'PROCESSING';

  // Shippo can return: UNKNOWN, RETURNED, FAILURE
  if (status === 'RETURNED') return 'CANCELLED';
  if (status === 'FAILURE') return 'PROCESSING';
  if (status === 'UNKNOWN') return 'PROCESSING';

  // Safe fallback
  return 'PROCESSING';
}

function normalizeShippoTrack(track) {
  const trackingStatus = track?.tracking_status || null;
  const history = Array.isArray(track?.tracking_history) ? track.tracking_history : [];

  // ✅ Sort history by date so "latest" is actually latest
  const historySorted = history.slice().sort((a, b) => {
    const da = new Date(a?.status_date || a?.object_updated || a?.object_created || 0).getTime();
    const db = new Date(b?.status_date || b?.object_updated || b?.object_created || 0).getTime();
    return da - db;
  });

  const events = historySorted.map((ev) => ({
    status: mapShippoStatus(ev?.status),
    rawStatus: ev?.status || 'UNKNOWN',
    details: ev?.status_details || '',
    date: ev?.status_date || ev?.object_updated || ev?.object_created || null,
    location: ev?.location || null,
  }));

  const last = (historySorted.length ? historySorted[historySorted.length - 1] : trackingStatus) || null;

  return {
    status: mapShippoStatus(last?.status),
    events,
    estimatedDelivery: track?.eta || null,
    lastUpdate: last?.status_date || last?.object_updated || new Date().toISOString(),
    raw: track,
  };
}

// ✅ Main function you will call from your tracking route
async function getShippoTracking(carrier, trackingNumber) {
  const c = String(carrier || '').trim();
  const t = String(trackingNumber || '').trim();

  if (!c) throw new Error('Missing Shippo carrier token (e.g. "usps").');
  if (!t) throw new Error('Missing tracking number.');

  const track = await shippoFetch(
    `/tracks/${encodeURIComponent(c)}/${encodeURIComponent(t)}`
  );

  return normalizeShippoTrack(track);
}

module.exports = { getShippoTracking };
