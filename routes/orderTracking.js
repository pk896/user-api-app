// routes/orderTracking.js
'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');

let Order = null;
try {
  Order = require('../models/Order');
} catch (e) {
  Order = null;
}

/* ---------------------------------------
   Courier API configuration (FIXED)
   - No "this" usage (it was undefined)
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
          {
            Shipments: [trackingNumber],
            GetLastTrackingUpdateOnly: false,
          },
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
async function fetchLiveTracking(courier, trackingNumber) {
  if (!courier || !trackingNumber) return null;
  if (!COURIER_APIS[courier]) return null;

  try {
    const trackingData = await COURIER_APIS[courier].track(trackingNumber);
    return parseTrackingData(courier, trackingData);
  } catch (error) {
    console.error(`Error fetching ${courier} tracking:`, error?.response?.data || error.message);
    return null;
  }
}

function parseTrackingData(courier, data) {
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

function hasUser(req) {
  return Boolean(req.session?.user || req.user);
}

function hasBusiness(req) {
  return Boolean(req.session?.business);
}

/* ---------------------------------------
   ROUTES
   Mounted at: /orders/tracking
--------------------------------------- */

// GET: view tracking with live data
router.get('/:orderId', async (req, res, next) => {
  try {
    if (!Order) {
      req.flash('error', 'Order model not available.');
      return res.redirect('/orders');
    }

    const userOk = hasUser(req);
    const businessOk = hasBusiness(req);

    if (!userOk && !businessOk) {
      req.flash('error', 'Please log in to view order tracking.');
      return res.redirect('/users/login');
    }

    const order = await Order.findById(req.params.orderId).lean();
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    // Users can only see their own orders
    if (userOk && order.userId && req.session?.user?._id) {
      if (order.userId.toString() !== req.session.user._id.toString()) {
        req.flash('error', 'You are not allowed to view this order.');
        return res.redirect('/orders');
      }
    }

    let liveTracking = null;

    if (order.shippingTracking?.trackingNumber && order.shippingTracking?.carrier) {
      liveTracking = await fetchLiveTracking(
        order.shippingTracking.carrier,
        order.shippingTracking.trackingNumber,
      );

      // Cache live data (best-effort)
      if (liveTracking) {
        await Order.findByIdAndUpdate(req.params.orderId, {
          'shippingTracking.liveStatus': liveTracking.status,
          'shippingTracking.liveEvents': liveTracking.events,
          'shippingTracking.lastTrackingUpdate': new Date(),
          'shippingTracking.estimatedDelivery': liveTracking.estimatedDelivery,
        }).catch(() => {});
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
      success: req.flash('success') || [],
      error: req.flash('error') || [],
    });
  } catch (err) {
    next(err);
  }
});

// POST: update tracking (business only)
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

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    const { carrier, carrierLabel, trackingNumber, trackingUrl, status } = req.body;

    order.shippingTracking = order.shippingTracking || {};
    order.shippingTracking.carrier = carrier || order.shippingTracking.carrier || 'OTHER';
    order.shippingTracking.carrierLabel = carrierLabel || order.shippingTracking.carrierLabel || '';
    order.shippingTracking.trackingNumber = trackingNumber || '';
    order.shippingTracking.trackingUrl = trackingUrl || '';
    order.shippingTracking.status = status || order.shippingTracking.status || 'SHIPPED';

    // Auto-fetch live tracking
    if (trackingNumber && carrier && carrier !== 'OTHER') {
      const liveTracking = await fetchLiveTracking(carrier, trackingNumber);
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

    req.flash(
      'success',
      'Tracking updated.' + (order.shippingTracking.liveStatus ? ' Live tracking data fetched.' : ''),
    );

    return res.redirect(`/orders/tracking/${order._id}`);
  } catch (err) {
    next(err);
  }
});

// API: refresh tracking data (best for AJAX)
router.get('/:orderId/refresh', async (req, res) => {
  try {
    if (!Order) return res.status(500).json({ ok: false, message: 'Order model not available.' });

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, message: 'Order not found.' });

    if (order.shippingTracking?.trackingNumber && order.shippingTracking?.carrier) {
      const liveTracking = await fetchLiveTracking(
        order.shippingTracking.carrier,
        order.shippingTracking.trackingNumber,
      );

      if (liveTracking) {
        order.shippingTracking.liveStatus = liveTracking.status;
        order.shippingTracking.liveEvents = liveTracking.events;
        order.shippingTracking.lastTrackingUpdate = new Date();
        order.shippingTracking.estimatedDelivery = liveTracking.estimatedDelivery;

        await order.save();

        return res.json({ ok: true, liveTracking });
      }
    }

    return res.json({ ok: false, message: 'Could not refresh tracking data' });
  } catch (error) {
    console.error('Error refreshing tracking:', error?.response?.data || error.message);
    return res.status(500).json({ ok: false, message: 'Internal server error' });
  }
});

module.exports = router;
