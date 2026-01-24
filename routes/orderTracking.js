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

  // Do NOT treat legacy keys as Shippo
  if (COURIER_APIS[c]) return false;

  // Do NOT treat "OTHER" / "other" as Shippo
  if (c.toLowerCase() === 'other') return false;

  // Shippo tokens are lowercase and usually [a-z0-9_]
  if (c !== c.toLowerCase()) return false;
  if (!/^[a-z0-9_]+$/.test(c)) return false;

  return true;
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

  // map to your fulfillment pipeline
  let fulfillment = undefined;
  if (liveTracking.status === 'DELIVERED') fulfillment = 'DELIVERED';
  else if (liveTracking.status === 'IN_TRANSIT') fulfillment = 'IN_TRANSIT';
  else if (liveTracking.status === 'PROCESSING') fulfillment = 'PENDING';
  else if (liveTracking.status === 'DELAYED') fulfillment = 'EXCEPTION';
  else fulfillment = undefined;

  await Order.findByIdAndUpdate(realMongoId, {
    // ✅ live cache
    'shippingTracking.liveStatus': liveTracking.status,
    'shippingTracking.liveEvents': liveTracking.events,
    'shippingTracking.lastTrackingUpdate': now,
    'shippingTracking.estimatedDelivery': liveTracking.estimatedDelivery,

    // ✅ main status fields (what order history usually shows)
    'shippingTracking.status': liveTracking.status,
    ...(fulfillment ? { fulfillmentStatus: fulfillment } : {}),
    ...(liveTracking.status === 'DELIVERED' ? { status: 'DELIVERED' } : {}),
  }).catch(() => {});
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

    // ✅ IMPORTANT:
    // - Shippo tracking needs the token like "usps"
    // - PayPal needs the enum like "USPS"
    const carrierToken = String(st.carrierToken || '').trim(); // "usps"
    const carrierEnum = String(st.carrier || '').trim();       // "USPS"

    // Use token first, else fallback
    const carrierForTracking = carrierToken || carrierEnum;

    if (trackingNumber && carrierForTracking) {
      liveTracking = await fetchAnyLiveTracking({ carrier: carrierForTracking, trackingNumber });

      if (liveTracking) {
        // Cache your live tracking fields (what you already do)
        await cacheLiveTracking(req.params.orderId, liveTracking);
      }
    }

    return res.render('order-track', {
      layout: 'layout',
      title: 'Track Order',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
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

    if (!hasBusiness(req)) {
      req.flash('error', 'Only business accounts can update tracking.');
      return res.redirect('/users/login');
    }

    const order = await findOrderByParam(req.params.orderId, false);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    const carrier = String(req.body?.carrier || '').trim(); // shippo token OR legacy enum OR OTHER
    const carrierLabel = String(req.body?.carrierLabel || '').trim();
    const trackingNumber = String(req.body?.trackingNumber || '').trim();
    const trackingUrl = String(req.body?.trackingUrl || '').trim();
    const status = String(req.body?.status || '').trim();

    order.shippingTracking = order.shippingTracking || {};
    order.shippingTracking.carrier = carrier || order.shippingTracking.carrier || 'OTHER';
    order.shippingTracking.carrierLabel = carrierLabel || order.shippingTracking.carrierLabel || '';
    order.shippingTracking.trackingNumber = trackingNumber || '';
    order.shippingTracking.trackingUrl = trackingUrl || '';
    order.shippingTracking.status = status || order.shippingTracking.status || 'SHIPPED';

    // Auto-fetch live tracking (Shippo-first when carrier is a Shippo token)
    let liveTracking = null;
    if (trackingNumber && carrier && carrier.toLowerCase() !== 'other') {
      liveTracking = await fetchAnyLiveTracking({ carrier, trackingNumber });
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

    return res.redirect(`/orders/tracking/${order._id}`);
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
    const carrier = String(st.carrier || '').trim();

    if (!trackingNumber || !carrier) {
      return res.json({ ok: false, message: 'No tracking details saved yet.' });
    }

    const liveTracking = await fetchAnyLiveTracking({ carrier, trackingNumber });

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
