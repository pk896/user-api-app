// routes/publicOrderTracking.js
'use strict';

const express = require('express');
const router = express.Router();

const Order = require('../models/Order');
const ShopHeaderImage = require('../models/ShopHeaderImage');

const BASE_CURRENCY = String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';

function normalize(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return normalize(value).toLowerCase();
}

function maskEmail(email) {
  const clean = normalizeEmail(email);
  if (!clean || !clean.includes('@')) return '';

  const [name, domain] = clean.split('@');
  const visibleName = name.slice(0, 2);
  return `${visibleName}${'*'.repeat(Math.max(name.length - 2, 2))}@${domain}`;
}

function niceDate(value) {
  if (!value) return '';

  try {
    return new Date(value).toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value || '');
  }
}

function prettyStatus(value) {
  const status = normalize(value).toUpperCase();

  const map = {
    PENDING: 'Pending',
    PAID: 'Paid',
    PROCESSING: 'Processing',
    PACKING: 'Packing',
    LABEL_CREATED: 'Label created',
    SHIPPED: 'Shipped',
    IN_TRANSIT: 'In transit',
    OUT_FOR_DELIVERY: 'Out for delivery',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    COMPLETED: 'Completed',
    REFUNDED: 'Refunded',
    PARTIALLY_REFUNDED: 'Partially refunded',
  };

  return map[status] || (status ? status.replace(/_/g, ' ') : 'Pending');
}

function statusClass(value) {
  const status = normalize(value).toUpperCase();

  if (status === 'DELIVERED' || status === 'COMPLETED') {
    return 'success';
  }

  if (
    status === 'SHIPPED' ||
    status === 'IN_TRANSIT' ||
    status === 'OUT_FOR_DELIVERY' ||
    status === 'LABEL_CREATED'
  ) {
    return 'primary';
  }

  if (status === 'CANCELLED' || status === 'REFUNDED') {
    return 'danger';
  }

  return 'secondary';
}

function buildCarrierTrackingUrl(carrierToken, trackingNumber) {
  const carrier = normalize(carrierToken).toLowerCase();
  const number = encodeURIComponent(normalize(trackingNumber));

  if (!carrier || !number) return '';

  if (carrier === 'usps') {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${number}`;
  }

  if (carrier === 'ups') {
    return `https://www.ups.com/track?tracknum=${number}`;
  }

  if (carrier === 'fedex') {
    return `https://www.fedex.com/fedextrack/?trknbr=${number}`;
  }

  if (carrier.includes('dhl')) {
    return `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${number}`;
  }

  return '';
}

function publicOrderView(order) {
  if (!order) return null;

  const tracking = order.shippingTracking || {};
  const carrierToken = tracking.carrierToken || order.shippo?.carrier || tracking.carrier || '';
  const trackingNumber = tracking.trackingNumber || '';

  const trackingUrl =
    normalize(tracking.trackingUrl) ||
    buildCarrierTrackingUrl(carrierToken, trackingNumber);

  const events = Array.isArray(tracking.liveEvents)
    ? tracking.liveEvents.slice(0, 8).map((event) => ({
        status: prettyStatus(event.status || event.tracking_status || ''),
        details: normalize(event.details || event.message || event.rawStatus || ''),
        location: event.location || null,
        date:
          niceDate(
            event.datetime ||
            event.date ||
            event.status_date ||
            event.event_datetime ||
            event.timestamp
          ) || '',
      }))
    : [];

  return {
    orderId: order.orderId || '',
    createdAt: niceDate(order.createdAt),
    updatedAt: niceDate(order.updatedAt),

    customerEmail: maskEmail(order.payer?.email || order.shipping?.email || ''),

    paymentStatus: prettyStatus(order.paymentStatus || order.status),
    fulfillmentStatus: prettyStatus(order.fulfillmentStatus || tracking.status),
    trackingStatus: prettyStatus(tracking.liveStatus || tracking.status || order.fulfillmentStatus),

    paymentStatusClass: statusClass(order.paymentStatus || order.status),
    fulfillmentStatusClass: statusClass(order.fulfillmentStatus || tracking.status),
    trackingStatusClass: statusClass(tracking.liveStatus || tracking.status || order.fulfillmentStatus),

    carrier: tracking.carrierLabel || tracking.carrier || order.shippo?.chosenRate?.provider || '',
    service: order.shippo?.chosenRate?.service || order.delivery?.name || '',
    trackingNumber,
    trackingUrl,

    estimatedDelivery: niceDate(tracking.estimatedDelivery),
    lastTrackingUpdate: niceDate(tracking.lastTrackingUpdate || tracking.lastUpdate),

    items: Array.isArray(order.items)
      ? order.items.map((item) => ({
          name: item.name || 'Product',
          quantity: Number(item.quantity || 0),
          imageUrl: item.imageUrl || '',
          size: item.variants?.size || '',
          color: item.variants?.color || '',
        }))
      : [],

    events,
  };
}

async function getShopHeaderImage() {
  try {
    return await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();
  } catch {
    return null;
  }
}

router.get('/store/order-tracking', async (req, res) => {
  const shopHeaderImage = await getShopHeaderImage();

  return res.render('store/order-tracking', {
    layout: 'layouts/store',
    title: 'Track Your Order',
    shopHeaderImage,
    baseCurrency: BASE_CURRENCY,
    form: {
      orderId: normalize(req.query.orderId),
      email: normalize(req.query.email),
    },
    publicOrder: null,
    searched: false,
    errorMessage: '',
  });
});

router.post('/store/order-tracking', async (req, res) => {
  const shopHeaderImage = await getShopHeaderImage();

  const orderId = normalize(req.body.orderId);
  const email = normalizeEmail(req.body.email);

  if (!orderId || !email) {
    return res.status(400).render('store/order-tracking', {
      layout: 'layouts/store',
      title: 'Track Your Order',
      shopHeaderImage,
      baseCurrency: BASE_CURRENCY,
      form: { orderId, email },
      publicOrder: null,
      searched: true,
      errorMessage: 'Please enter your order number and email address.',
    });
  }

  const order = await Order.findOne({
    orderId,
    $or: [
      { 'payer.email': email },
      { 'shipping.email': email },
    ],
  })
    .select([
      'orderId',
      'status',
      'paymentStatus',
      'fulfillmentStatus',
      'payer.email',
      'shipping.email',
      'shippingTracking',
      'shippo.carrier',
      'shippo.chosenRate',
      'delivery',
      'items.name',
      'items.quantity',
      'items.imageUrl',
      'items.variants',
      'createdAt',
      'updatedAt',
    ].join(' '))
    .lean();

  if (!order) {
    return res.status(404).render('store/order-tracking', {
      layout: 'layouts/store',
      title: 'Track Your Order',
      shopHeaderImage,
      baseCurrency: BASE_CURRENCY,
      form: { orderId, email },
      publicOrder: null,
      searched: true,
      errorMessage: 'We could not find an order matching that order number and email.',
    });
  }

  return res.render('store/order-tracking', {
    layout: 'layouts/store',
    title: 'Track Your Order',
    shopHeaderImage,
    baseCurrency: BASE_CURRENCY,
    form: { orderId, email },
    publicOrder: publicOrderView(order),
    searched: true,
    errorMessage: '',
  });
});

module.exports = router;
