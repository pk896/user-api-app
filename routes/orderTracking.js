// routes/orderTracking.js
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const axios = require('axios');

// Courier API configuration
const COURIER_APIS = {
  COURIER_GUY: {
    name: 'The Courier Guy',
    apiKey: process.env.COURIER_GUY_API_KEY,
    baseUrl: 'https://api.thecourierguy.co.za',
    track: async (trackingNumber) => {
      try {
        const response = await axios.get(`${this.baseUrl}/tracking/${trackingNumber}`, {
          headers: { 'Authorization': `Bearer ${this.apiKey}` }
        });
        return response.data;
      } catch (error) {
        console.error('Courier Guy API error:', error);
        return null;
      }
    }
  },
  FASTWAY: {
    name: 'Fastway Couriers',
    baseUrl: 'https://api.fastway.org',
    track: async (trackingNumber) => {
      try {
        // Fastway usually uses a simple HTTP GET
        const response = await axios.get(`${this.baseUrl}/v1/track/${trackingNumber}`);
        return response.data;
      } catch (error) {
        console.error('Fastway API error:', error);
        return null;
      }
    }
  },
  // Add other couriers as needed
  ARAMEX: {
    name: 'Aramex',
    baseUrl: 'https://ws.aramex.com',
    track: async (trackingNumber) => {
      try {
        // Aramex uses SOAP, but we can use a simplified approach
        const response = await axios.post(`${this.baseUrl}/tracking`, {
          Shipments: [trackingNumber],
          GetLastTrackingUpdateOnly: false
        });
        return response.data;
      } catch (error) {
        console.error('Aramex API error:', error);
        return null;
      }
    }
  }
};

// Function to fetch real-time tracking data
async function fetchLiveTracking(courier, trackingNumber) {
  if (!COURIER_APIS[courier]) {
    return null;
  }

  try {
    const trackingData = await COURIER_APIS[courier].track(trackingNumber);
    return parseTrackingData(courier, trackingData);
  } catch (error) {
    console.error(`Error fetching ${courier} tracking:`, error);
    return null;
  }
}

// Parse different courier API responses into standardized format
function parseTrackingData(courier, data) {
  const standardized = {
    status: 'UNKNOWN',
    events: [],
    estimatedDelivery: null,
    lastUpdate: new Date()
  };

  switch (courier) {
    case 'COURIER_GUY':
      if (data && data.TrackingResults) {
        standardized.status = mapStatus(data.TrackingResults[0]?.Status);
        standardized.events = data.TrackingResults[0]?.TrackingEvents || [];
        standardized.estimatedDelivery = data.TrackingResults[0]?.EstimatedDeliveryDate;
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
        standardized.estimatedDelivery = result?.EstimatedDeliveryDate;
      }
      break;
  }

  return standardized;
}

// Map courier-specific statuses to standardized ones
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

// GET: view tracking with live data
router.get('/:orderId/track', async (req, res, next) => {
  try {
    const hasUser = !!req.session?.user;
    const hasBusiness = !!req.session?.business;

    if (!hasUser && !hasBusiness) {
      req.flash('error', 'Please log in to view order tracking.');
      return res.redirect('/users/login');
    }

    const order = await Order.findById(req.params.orderId).lean();
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    // Basic safety: users can only see their own orders
    if (hasUser && order.userId && order.userId.toString() !== req.session.user._id) {
      req.flash('error', 'You are not allowed to view this order.');
      return res.redirect('/orders');
    }

    let liveTracking = null;
    // Fetch live tracking data if available
    if (order.shippingTracking?.trackingNumber && order.shippingTracking?.carrier) {
      liveTracking = await fetchLiveTracking(
        order.shippingTracking.carrier,
        order.shippingTracking.trackingNumber
      );
      
      // Cache the live data for a short period (5 minutes)
      if (liveTracking) {
        await Order.findByIdAndUpdate(req.params.orderId, {
          'shippingTracking.liveStatus': liveTracking.status,
          'shippingTracking.liveEvents': liveTracking.events,
          'shippingTracking.lastTrackingUpdate': new Date(),
          'shippingTracking.estimatedDelivery': liveTracking.estimatedDelivery
        });
      }
    }

    res.render('order-track', {
      layout: 'layout',
      title: 'Track Order',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      order,
      liveTracking,
      isBusiness: hasBusiness,
      isUser: hasUser,
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    next(err);
  }
});

// POST: update tracking (business only) - Updated to include auto-fetch
router.post('/:orderId/track', async (req, res, next) => {
  try {
    const hasBusiness = !!req.session?.business;

    if (!hasBusiness) {
      req.flash('error', 'Only business accounts can update tracking.');
      return res.redirect('/users/login');
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders');
    }

    const {
      carrier,
      carrierLabel,
      trackingNumber,
      trackingUrl,
      status,
    } = req.body;

    if (!order.shippingTracking) {
      order.shippingTracking = {};
    }

    order.shippingTracking.carrier = carrier || order.shippingTracking.carrier || 'OTHER';
    order.shippingTracking.carrierLabel = carrierLabel || order.shippingTracking.carrierLabel || '';
    order.shippingTracking.trackingNumber = trackingNumber || '';
    order.shippingTracking.trackingUrl = trackingUrl || '';
    order.shippingTracking.status = status || order.shippingTracking.status || 'SHIPPED';

    // Auto-fetch live tracking when tracking number is provided
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

    req.flash('success', 'Tracking updated.' + (order.shippingTracking.liveStatus ? ' Live tracking data fetched.' : ''));
    res.redirect(`/orders/${order._id}/track`);
  } catch (err) {
    next(err);
  }
});

// API endpoint to refresh tracking data
router.get('/:orderId/refresh-tracking', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.shippingTracking?.trackingNumber && order.shippingTracking?.carrier) {
      const liveTracking = await fetchLiveTracking(
        order.shippingTracking.carrier,
        order.shippingTracking.trackingNumber
      );

      if (liveTracking) {
        order.shippingTracking.liveStatus = liveTracking.status;
        order.shippingTracking.liveEvents = liveTracking.events;
        order.shippingTracking.lastTrackingUpdate = new Date();
        order.shippingTracking.estimatedDelivery = liveTracking.estimatedDelivery;
        
        await order.save();
        
        return res.json({
          success: true,
          liveTracking,
          message: 'Tracking data refreshed'
        });
      }
    }

    res.json({ success: false, message: 'Could not refresh tracking data' });
  } catch (error) {
    console.error('Error refreshing tracking:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;