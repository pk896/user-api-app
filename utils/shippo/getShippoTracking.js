// utils/shippo/getShippoTracking.js
'use strict';

const { fetch } = require('undici');

const SHIPPO_BASE = 'https://api.goshippo.com';

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

async function shippoFetch(path) {
  const token = mustEnv('SHIPPO_TOKEN');

  const r = await fetch(`${SHIPPO_BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `ShippoToken ${token}`,
      Accept: 'application/json',
    },
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

function mapShippoStatus(s) {
  const status = String(s || '').toUpperCase();

  // Shippo enum: UNKNOWN, PRE_TRANSIT, TRANSIT, DELIVERED, RETURNED, FAILURE :contentReference[oaicite:3]{index=3}
  if (status === 'DELIVERED') return 'DELIVERED';
  if (status === 'TRANSIT') return 'IN_TRANSIT';
  if (status === 'PRE_TRANSIT') return 'PROCESSING';
  if (status === 'RETURNED') return 'RETURNED';
  if (status === 'FAILURE') return 'DELAYED';

  return 'UNKNOWN';
}

function normalizeShippoTrack(track) {
  const trackingStatus = track?.tracking_status || null;
  const history = Array.isArray(track?.tracking_history) ? track.tracking_history : [];

  const events = history.map((ev) => ({
    status: mapShippoStatus(ev?.status),
    rawStatus: ev?.status || 'UNKNOWN',
    details: ev?.status_details || '',
    date: ev?.status_date || ev?.object_updated || ev?.object_created || null,
    location: ev?.location || null,
  }));

  const last = (history.length ? history[history.length - 1] : trackingStatus) || null;

  return {
    status: mapShippoStatus(last?.status),
    events,
    estimatedDelivery: track?.eta || null,          // Shippo "eta" :contentReference[oaicite:4]{index=4}
    lastUpdate: last?.status_date || last?.object_updated || new Date(),
    raw: track, // keep original if you want to render more details
  };
}

// ✅ Main function you will call from your tracking route
async function getShippoTracking(carrier, trackingNumber) {
  if (!carrier) throw new Error('Missing Shippo carrier token (e.g. "usps").');
  if (!trackingNumber) throw new Error('Missing tracking number.');

  // GET /tracks/{carrier}/{tracking_number} :contentReference[oaicite:5]{index=5}
  const track = await shippoFetch(`/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`);
  return normalizeShippoTrack(track);
}

module.exports = { getShippoTracking };
