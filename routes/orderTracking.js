// routes/orderTracking.js
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');

const { getShippoTracking } = require('../utils/shippo/getShippoTracking');

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  Order = null;
}

const mongoose = require('mongoose');

// ------------------------------------------------------
// Enum-safe mapping (prevents ValidationError on enums)
// ------------------------------------------------------
function _norm(v) {
  return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function getTrackingStatusEnumValues(orderDoc) {
  const p =
    orderDoc?.schema?.path('shippingTracking.status') ||
    orderDoc?.constructor?.schema?.path('shippingTracking.status');
  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function getFulfillmentEnumValues(orderDoc) {
  const p =
    orderDoc?.schema?.path('fulfillmentStatus') ||
    orderDoc?.constructor?.schema?.path('fulfillmentStatus');
  return Array.isArray(p?.enumValues) ? p.enumValues : [];
}

function mapToEnum(desired, enumValues) {
  const want = _norm(desired);
  if (!want) return null;

  // exact match by normalized
  for (const ev of enumValues) {
    if (_norm(ev) === want) return ev;
  }

  // safe fallbacks
  const fallbackOrder = [
    'DELIVERED',
    'OUT_FOR_DELIVERY',
    'IN_TRANSIT',
    'SHIPPED',
    'LABEL_CREATED',
    'PROCESSING',
    'PENDING',
    'UNKNOWN',
  ];

  for (const fb of fallbackOrder) {
    for (const ev of enumValues) {
      if (_norm(ev) === _norm(fb)) return ev;
    }
  }

  return null;
}

// map live tracking -> fulfillmentStatus (best effort)
function liveStatusToFulfillment(liveStatus) {
  const s = String(liveStatus || '').toUpperCase();
  if (s === 'DELIVERED') return 'DELIVERED';
  if (s === 'OUT_FOR_DELIVERY') return 'SHIPPED';
  if (s === 'IN_TRANSIT') return 'SHIPPED';
  if (s === 'PROCESSING') return 'LABEL_CREATED';
  if (s === 'CANCELLED') return 'CANCELLED';
  return null;
}

async function findOrderByParam(param, lean = false) {
  const p = String(param || '').trim();

  // If it's a valid ObjectId => lookup by _id
  if (mongoose.isValidObjectId(p)) {
    return lean ? Order.findById(p).lean() : Order.findById(p);
  }

  // Otherwise try lookup by your PayPal orderId field
  // (this matches your Order schema field "orderId")
  return lean
    ? Order.findOne({ orderId: p }).lean()
    : Order.findOne({ orderId: p });
}

/* ---------------------------------------
   Legacy Courier APIs (fallback)
   NOTE: Kept for backward compatibility with old orders.
--------------------------------------- */
const COURIER_APIS = {
  COURIER_GUY: {
    name: 'The Courier Guy',
    apiKey: process.env.COURIER_GUY_API_KEY,
    baseUrl: 'https://api.thecourierguy.co.za',
    async track(trackingNumber) {
      try {
        const url = `${this.baseUrl}/tracking/${encodeURIComponent(trackingNumber)}`;
        const response = await axios.get(url, {
          headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
          timeout: 15000,
        });
        return response.data;
      } catch (error) {
        console.error('Courier Guy API error:', error?.response?.data || error.message);
        return null;
      }
    },
  },

  FASTWAY: {
    name: 'Fastway Couriers',
    baseUrl: 'https://api.fastway.org',
    async track(trackingNumber) {
      try {
        const url = `${this.baseUrl}/v1/track/${encodeURIComponent(trackingNumber)}`;
        const response = await axios.get(url, { timeout: 15000 });
        return response.data;
      } catch (error) {
        console.error('Fastway API error:', error?.response?.data || error.message);
        return null;
      }
    },
  },

  ARAMEX: {
    name: 'Aramex',
    baseUrl: 'https://ws.aramex.com',
    async track(trackingNumber) {
      try {
        const url = `${this.baseUrl}/tracking`;
        const response = await axios.post(
          url,
          { Shipments: [trackingNumber], GetLastTrackingUpdateOnly: false },
          { timeout: 15000 },
        );
        return response.data;
      } catch (error) {
        console.error('Aramex API error:', error?.response?.data || error.message);
        return null;
      }
    },
  },
};

/* ---------------------------------------
   Helpers
--------------------------------------- */
function hasUser(req) {
  return Boolean(req.session?.user || req.user);
}

function hasBusiness(req) {
  return Boolean(req.session?.business);
}

function hasAdmin(req) {
  return Boolean(req.session?.admin);
}
function isShippoCarrierToken(carrier) {
  // Shippo carrier tokens are typically lowercase strings like:
  // "ups", "usps", "fedex", "dhl_express"
  const c = String(carrier || '').trim();
  if (!c) return false;

  if (COURIER_APIS[String(c).toUpperCase()]) return false;

  // Do NOT treat "OTHER" / "other" as Shippo
  if (c.toLowerCase() === 'other') return false;

  // Shippo tokens are lowercase and usually [a-z0-9_]
  if (c !== c.toLowerCase()) return false;
  if (!/^[a-z0-9_]+$/.test(c)) return false;

  return true;
}

function normalizeCarrierForSchema(rawCarrier) {
  const raw = String(rawCarrier || '').trim();
  if (!raw) return { carrierEnum: 'OTHER', carrierToken: '', carrierLabelAuto: '' };

  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();

  // Shippo token -> enum mapping
  const tokenToEnum = {
    ups: 'UPS',
    usps: 'USPS',
    fedex: 'FEDEX',
    dhl_express: 'DHL',
    dhl: 'DHL',
  };

  // If user selected a Shippo token in the dropdown
  if (tokenToEnum[lower]) {
    const token = lower === 'dhl' ? 'dhl_express' : lower; // normalize
    return { carrierEnum: tokenToEnum[lower], carrierToken: token, carrierLabelAuto: tokenToEnum[lower] };
  }

  // If they posted an enum already (USPS/UPS/FEDEX/DHL/OTHER)
  if (['USPS', 'UPS', 'FEDEX', 'DHL', 'OTHER'].includes(upper)) {
    // Optional: also set a token for Shippo integrated ones
    const enumToToken = { USPS: 'usps', UPS: 'ups', FEDEX: 'fedex', DHL: 'dhl_express' };
    return { carrierEnum: upper, carrierToken: enumToToken[upper] || '', carrierLabelAuto: upper };
  }

  // Legacy courier keys
  if (COURIER_APIS[upper]) {
    return { carrierEnum: upper, carrierToken: '', carrierLabelAuto: COURIER_APIS[upper].name || upper };
  }

  // Unknown -> store as OTHER (safe)
  return { carrierEnum: 'OTHER', carrierToken: '', carrierLabelAuto: raw };
}

// ------------------------------------------------------
// If old orders only saved enum (e.g. "USPS") but not token ("usps"),
// convert enum -> Shippo token so live tracking works.
// ------------------------------------------------------
function carrierEnumToShippoToken(carrierEnum) {
  const upper = String(carrierEnum || '').trim().toUpperCase();
  const map = {
    USPS: 'usps',
    UPS: 'ups',
    FEDEX: 'fedex',
    DHL: 'dhl_express',
  };
  return map[upper] || '';
}

function isShippoTestKey() {
  return String(process.env.SHIPPO_TOKEN || '').startsWith('shippo_test_');
}

function mapStatus(courierStatus) {
  if (!courierStatus) return 'UNKNOWN';

  const status = courierStatus.toString().toLowerCase();

  if (status.includes('delivered') || status.includes('completed')) return 'DELIVERED';
  if (status.includes('out for delivery') || status.includes('on vehicle')) return 'OUT_FOR_DELIVERY';
  if (status.includes('in transit') || status.includes('in transportation')) return 'IN_TRANSIT';
  if (status.includes('picked up') || status.includes('collected')) return 'PICKED_UP';
  if (status.includes('exception') || status.includes('delay')) return 'DELAYED';
  if (status.includes('pending') || status.includes('processing')) return 'PROCESSING';

  return 'UNKNOWN';
}

function parseLegacyTrackingData(courier, data) {
  const standardized = {
    status: 'UNKNOWN',
    events: [],
    estimatedDelivery: null,
    lastUpdate: new Date(),
  };

  switch (courier) {
    case 'COURIER_GUY':
      if (data && data.TrackingResults) {
        standardized.status = mapStatus(data.TrackingResults[0]?.Status);
        standardized.events = data.TrackingResults[0]?.TrackingEvents || [];
        standardized.estimatedDelivery = data.TrackingResults[0]?.EstimatedDeliveryDate || null;
      }
      break;

    case 'FASTWAY':
      if (data && data.tracking_results) {
        standardized.status = mapStatus(data.tracking_results.status);
        standardized.events = data.tracking_results.events || [];
      }
      break;

    case 'ARAMEX':
      if (data && data.TrackingResults) {
        const result = data.TrackingResults[0];
        standardized.status = mapStatus(result?.UpdateCode);
        standardized.events = result?.TrackingEvents || [];
        standardized.estimatedDelivery = result?.EstimatedDeliveryDate || null;
      }
      break;
  }

  return standardized;
}

async function fetchLegacyLiveTracking(courier, trackingNumber) {
  if (!courier || !trackingNumber) return null;
  if (!COURIER_APIS[courier]) return null;

  try {
    const trackingData = await COURIER_APIS[courier].track(trackingNumber);
    return parseLegacyTrackingData(courier, trackingData);
  } catch (error) {
    console.error(`Error fetching ${courier} tracking:`, error?.response?.data || error.message);
    return null;
  }
}

/**
 * ✅ Shippo-first: if carrier is a Shippo token => use Shippo
 * else fallback to legacy couriers.
 */
async function fetchAnyLiveTracking({ carrier, trackingNumber }) {
  const c = String(carrier || '').trim();
  const t = String(trackingNumber || '').trim();
  if (!c || !t) return null;

  // Shippo path
  if (isShippoCarrierToken(c)) {
    try {
      return await getShippoTracking(c, t);
    } catch (e) {
      console.error('Shippo tracking error:', e?.message || e);
      return null;
    }
  }

  // Legacy path
  return await fetchLegacyLiveTracking(c, t);
}

async function cacheLiveTracking(orderIdOrOrderIdField, liveTracking) {
  if (!Order || !orderIdOrOrderIdField || !liveTracking) return;

  // Find by _id OR by orderId, then update by real Mongo _id
  const found = await findOrderByParam(orderIdOrOrderIdField, true).catch(() => null);
  const realMongoId = found?._id ? String(found._id) : null;
  if (!realMongoId) return;

  const now = new Date();

  // ✅ enum-safe mapping (prevents ValidationError)
  const trackingEnums = getTrackingStatusEnumValues(Order);
  const fulfillEnums  = getFulfillmentEnumValues(Order);

  const safeTrackingStatus =
    mapToEnum(liveTracking.status, trackingEnums) || mapToEnum('UNKNOWN', trackingEnums);

  const fulfillmentWanted = liveStatusToFulfillment(liveTracking.status);
  const safeFulfillment = fulfillmentWanted ? mapToEnum(fulfillmentWanted, fulfillEnums) : null;

  const update = {
    // ✅ live cache
    'shippingTracking.liveStatus': liveTracking.status,
    'shippingTracking.liveEvents': liveTracking.events,
    'shippingTracking.lastTrackingUpdate': now,
    'shippingTracking.estimatedDelivery': liveTracking.estimatedDelivery,

    // ✅ schema-safe status
    'shippingTracking.status': safeTrackingStatus,
  };

  if (safeFulfillment) update.fulfillmentStatus = safeFulfillment;
  if (String(liveTracking.status || '').toUpperCase() === 'DELIVERED') update.status = 'DELIVERED';

  await Order.findByIdAndUpdate(realMongoId, update).catch(() => {});
}

/* ---------------------------------------
   ROUTES (mounted at /orders/tracking)
--------------------------------------- */

// GET: view tracking page
router.get('/:orderId', async (req, res, next) => {
  try {
    if (!Order) {
      req.flash('error', 'Order model not available.');
      return res.redirect('/orders');
    }

    const userOk = hasUser(req);
    const businessOk = hasBusiness(req);
    const adminOk = hasAdmin(req);

    if (!userOk && !businessOk && !adminOk) {
      req.flash('error', 'Please log in to view order tracking.');
      // If they were trying from admin area, send them to admin login, otherwise users login.
      const backToAdmin = String(req.get('referer') || '').includes('/admin');
      return res.redirect(backToAdmin ? '/admin/login' : '/users/login');
    }

    const order = await findOrderByParam(req.params.orderId, true);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    // Users can only see their own orders (admins bypass)
    if (!adminOk && userOk && order.userId && req.session?.user?._id) {
      if (String(order.userId) !== String(req.session.user._id)) {
        req.flash('error', 'You are not allowed to view this order.');
        return res.redirect('/orders');
      }
    }

    let liveTracking = null;

    const st = order.shippingTracking || {};
    const trackingNumber = String(st.trackingNumber || '').trim();

    const carrierToken = String(st.carrierToken || '').trim(); // "usps"
    const carrierEnum  = String(st.carrier || '').trim();      // "USPS"

    // ✅ Use Shippo token first; if missing, convert enum -> token (old orders)
    const carrierForTracking =
      carrierToken ||
      carrierEnumToShippoToken(carrierEnum) ||
      carrierEnum; // last fallback (legacy couriers might still use it)


    if (trackingNumber && carrierForTracking) {
      liveTracking = await fetchAnyLiveTracking({ carrier: carrierForTracking, trackingNumber });

      if (liveTracking) {
        // Cache your live tracking fields (what you already do)
        await cacheLiveTracking(req.params.orderId, liveTracking);
      }
    }

    return res.render('tracking', {
      layout: 'layout',
      title: 'Track Order',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      baseUrl: req.baseUrl,
      order,
      liveTracking,
      isBusiness: businessOk,
      isUser: userOk,
      isAdmin: adminOk,
      success: req.flash('success') || [],
      error: req.flash('error') || [],
    });
  } catch (err) {
    next(err);
  }
});

// POST: update tracking (business only)
// IMPORTANT: EJS form action must post to /orders/tracking/:orderId
router.post('/:orderId', async (req, res, next) => {
  try {
    if (!Order) {
      req.flash('error', 'Order model not available.');
      return res.redirect('/orders');
    }

    if (!hasBusiness(req) && !hasAdmin(req)) {
      req.flash('error', 'Only business or admin accounts can update tracking.');
      return res.redirect('/users/login');
    }

    const order = await findOrderByParam(req.params.orderId, false);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    const rawCarrier = String(req.body?.carrier || '').trim(); // can be "usps" OR "USPS" OR "COURIER_GUY"
    const carrierLabel = String(req.body?.carrierLabel || '').trim();
    const trackingNumber = String(req.body?.trackingNumber || '').trim();
    const trackingUrl = String(req.body?.trackingUrl || '').trim();
    const status = String(req.body?.status || '').trim();

    const normalized = normalizeCarrierForSchema(rawCarrier);

    order.shippingTracking = order.shippingTracking || {};

    // ✅ Keep enum in .carrier (what your schema expects)
    order.shippingTracking.carrier = normalized.carrierEnum || order.shippingTracking.carrier || 'OTHER';

    // ✅ Keep Shippo token in .carrierToken (for Shippo tracking)
    order.shippingTracking.carrierToken = normalized.carrierToken || order.shippingTracking.carrierToken || '';

    // ✅ Label (user wins, else auto label)
    order.shippingTracking.carrierLabel =
      carrierLabel ||
      normalized.carrierLabelAuto ||
      order.shippingTracking.carrierLabel ||
      '';

    order.shippingTracking.trackingNumber = trackingNumber || '';
    order.shippingTracking.trackingUrl = trackingUrl || '';
    const trackingEnums = getTrackingStatusEnumValues(order);
    const safeStatus = mapToEnum(status || order.shippingTracking.status || 'SHIPPED', trackingEnums);
    if (safeStatus) order.shippingTracking.status = safeStatus;

    // Auto-fetch live tracking (Shippo-first when carrier is a Shippo token)
    let liveTracking = null;

    const carrierForTracking = String(
      order.shippingTracking.carrierToken || order.shippingTracking.carrier || ''
    ).trim();

    if (trackingNumber && carrierForTracking && carrierForTracking.toLowerCase() !== 'other') {
      // ✅ If using Shippo TEST key, don’t try to track USPS/UPS/etc (Shippo only allows "shippo" test carrier)
      if (isShippoTestKey() && isShippoCarrierToken(carrierForTracking) && carrierForTracking !== 'shippo') {
        liveTracking = null;
      } else {
        liveTracking = await fetchAnyLiveTracking({ carrier: carrierForTracking, trackingNumber });
      }

      if (liveTracking) {
        order.shippingTracking.liveStatus = liveTracking.status;
        order.shippingTracking.liveEvents = liveTracking.events;
        order.shippingTracking.lastTrackingUpdate = new Date();
        order.shippingTracking.estimatedDelivery = liveTracking.estimatedDelivery;
      }
    }

    const now = new Date();
    if (!order.shippingTracking.shippedAt && order.shippingTracking.status !== 'PENDING') {
      order.shippingTracking.shippedAt = now;
    }
    if (order.shippingTracking.status === 'DELIVERED' && !order.shippingTracking.deliveredAt) {
      order.shippingTracking.deliveredAt = now;
    }

    await order.save();

    req.flash('success', 'Tracking updated.' + (liveTracking ? ' Live tracking data fetched.' : ''));

    return res.redirect(`${req.baseUrl}/${order._id}`);
  } catch (err) {
    next(err);
  }
});

// GET: refresh live tracking (AJAX)
router.get('/:orderId/refresh', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    // ✅ protect refresh too (same rule as page)
    const userOk = hasUser(req);
    const businessOk = hasBusiness(req);
    const adminOk = hasAdmin(req);

    if (!userOk && !businessOk && !adminOk) {
      return res.status(401).json({ ok: false, message: 'Please log in.' });
    }

    const order = await findOrderByParam(req.params.orderId, false);
    if (!order) return res.status(404).json({ ok: false, message: 'Order not found.' });

    // Users can only refresh their own orders (admins bypass)
    if (!adminOk && userOk && order.userId && req.session?.user?._id) {
      if (String(order.userId) !== String(req.session.user._id)) {
        return res.status(403).json({ ok: false, message: 'Not allowed.' });
      }
    }

    const st = order.shippingTracking || {};
    const trackingNumber = String(st.trackingNumber || '').trim();
    const carrierForTracking = String(
      st.carrierToken ||
      carrierEnumToShippoToken(st.carrier) ||
      st.carrier ||
      ''
    ).trim();

    if (!trackingNumber || !carrierForTracking) {
      return res.json({ ok: false, message: 'No tracking details saved yet.' });
    }

    if (isShippoTestKey() && isShippoCarrierToken(carrierForTracking) && carrierForTracking !== 'shippo') {
      return res.json({ ok: false, message: 'Shippo test key cannot live-track USPS/UPS/FedEx/DHL. Use a live key or Shippo test tracking numbers.' });
    }

    const liveTracking = await fetchAnyLiveTracking({ carrier: carrierForTracking, trackingNumber });

    if (liveTracking) {
      order.shippingTracking.liveStatus = liveTracking.status;
      order.shippingTracking.liveEvents = liveTracking.events;
      order.shippingTracking.lastTrackingUpdate = new Date();
      order.shippingTracking.estimatedDelivery = liveTracking.estimatedDelivery;

      await order.save();

      return res.json({ ok: true, liveTracking });
    }

    return res.json({ ok: false, message: 'Could not refresh tracking data' });
  } catch (error) {
    console.error('Error refreshing tracking:', error?.response?.data || error.message);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

module.exports = router;
