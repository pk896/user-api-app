// routes/publicCjOrderTracking.js
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const CjOrder = require('../models/CjOrder');
const ShopHeaderImage = require('../models/ShopHeaderImage');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase() || 'USD';

/*
 * Public CJ tracking lookup limiter.
 *
 * This protects customer email/order-number combinations from
 * repeated guessing without affecting checkout or admin routes.
 */
const publicCjTrackingLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,

  max: process.env.NODE_ENV === 'production' ? 20 : 200,

  standardHeaders: true,
  legacyHeaders: false,

  /*
   * Use express-rate-limit's default IP handling.
   * This safely supports IPv4 and IPv6 visitors.
   */
  handler(req, res) {
    return renderCjTrackingPage(req, res, {
      status: 429,

      form: {
        cjOrderNumber: normalize(req.body?.cjOrderNumber || req.query?.cjOrderNumber),

        email: normalize(req.body?.email || req.query?.email),
      },

      publicOrder: null,
      searched: true,

      errorMessage:
        'Too many CJ tracking attempts were made. Please wait a few minutes and try again.',
    });
  },
});

function normalize(value, maxLength = 500) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function normalizeEmail(value) {
  return normalize(value, 320).toLowerCase();
}

function normalizeCjOrderNumber(value) {
  return normalize(value, 100).toUpperCase();
}

function maskEmail(value) {
  const email = normalizeEmail(value);

  if (!email || !email.includes('@')) {
    return '';
  }

  const [name, domain] = email.split('@');

  if (!name || !domain) {
    return '';
  }

  const visibleLength = name.length <= 2 ? 1 : 2;

  const visibleName = name.slice(0, visibleLength);

  const hiddenName = '*'.repeat(Math.max(name.length - visibleLength, 3));

  return `${visibleName}${hiddenName}@${domain}`;
}

function niceDate(value) {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  try {
    return parsed.toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return parsed.toISOString();
  }
}

function prettyStatus(value) {
  const status = normalize(value, 100).toUpperCase();

  const labels = {
    PAYMENT_PENDING: 'Payment pending',
    PAID: 'Paid',
    CJ_ORDER_PENDING: 'Preparing supplier order',
    CJ_ORDER_CREATED: 'Supplier order created',
    PROCESSING: 'Processing',
    SHIPPED: 'Shipped',
    IN_TRANSIT: 'In transit',
    OUT_FOR_DELIVERY: 'Out for delivery',
    DELIVERED: 'Delivered',
    CANCELLED: 'Cancelled',
    RETURNED: 'Returned',
    FAILED: 'Action required',
    REFUNDED: 'Refunded',
    PARTIALLY_REFUNDED: 'Partially refunded',

    CREATED: 'Created',
    APPROVED: 'Approved',
    PENDING: 'Pending',
    COMPLETED: 'Completed',
    DECLINED: 'Declined',

    NOT_CREATED: 'Not created yet',
    SUCCESS: 'Created successfully',
  };

  return (
    labels[status] ||
    (status
      ? status
          .replace(/_/g, ' ')
          .toLowerCase()
          .replace(/^\w/, (letter) => letter.toUpperCase())
      : 'Pending')
  );
}

function statusClass(value) {
  const status = normalize(value, 100).toUpperCase();

  if (['DELIVERED', 'COMPLETED', 'SUCCESS'].includes(status)) {
    return 'success';
  }

  if (
    [
      'CJ_ORDER_CREATED',
      'PROCESSING',
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'APPROVED',
    ].includes(status)
  ) {
    return 'primary';
  }

  if (
    ['PAYMENT_PENDING', 'CJ_ORDER_PENDING', 'PENDING', 'CREATED', 'NOT_CREATED'].includes(status)
  ) {
    return 'warning';
  }

  if (['FAILED', 'DECLINED', 'CANCELLED', 'RETURNED'].includes(status)) {
    return 'danger';
  }

  if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(status)) {
    return 'secondary';
  }

  return 'secondary';
}

function trackingProgressStep(value) {
  const status = normalize(value, 100).toUpperCase();

  if (status === 'DELIVERED') {
    return 5;
  }

  if (status === 'OUT_FOR_DELIVERY') {
    return 4;
  }

  if (status === 'IN_TRANSIT' || status === 'SHIPPED') {
    return 3;
  }

  if (status === 'PROCESSING' || status === 'CJ_ORDER_CREATED') {
    return 2;
  }

  return 1;
}

function getTrackingNumber(order) {
  return normalize(order?.tracking?.trackingNumber || order?.supplierOrder?.trackingNumber, 300);
}

function getTrackingUrl(order) {
  const value = normalize(order?.tracking?.trackingUrl || order?.supplierOrder?.trackingUrl, 2000);

  /*
   * Only expose normal HTTPS tracking links.
   * Do not print arbitrary schemes from database content.
   */
  return /^https:\/\//i.test(value) ? value : '';
}

function estimatedDeliveryText(order) {
  const exactDate = niceDate(order?.tracking?.estimatedDelivery);

  if (exactDate) {
    return exactDate;
  }

  const estimate = normalize(order?.selectedShipping?.deliveryEstimate, 200);

  if (estimate) {
    return estimate;
  }

  return 'Waiting for a delivery estimate';
}

function publicTrackingEvents(order) {
  const events = Array.isArray(order?.tracking?.events) ? order.tracking.events : [];

  return events
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left?.occurredAt || 0).getTime();

      const rightTime = new Date(right?.occurredAt || 0).getTime();

      return rightTime - leftTime;
    })
    .slice(0, 12)
    .map((event) => ({
      status: prettyStatus(event?.status),

      description: normalize(event?.description, 1000),

      location: normalize(event?.location, 300),

      occurredAt: niceDate(event?.occurredAt) || 'Time not available',
    }));
}

function publicOrderView(order) {
  if (!order) {
    return null;
  }

  const trackingStatus = order?.tracking?.status || order?.fulfillmentStatus || order?.status;

  const supplierStatus = order?.supplierOrder?.createStatus || 'NOT_CREATED';

  const trackingNumber = getTrackingNumber(order);

  const trackingUrl = getTrackingUrl(order);

  return {
    cjOrderNumber: normalize(order.cjOrderNumber, 100),

    customerEmail: maskEmail(
      order.customerEmail || order?.deliveryAddress?.email || order?.payer?.email,
    ),

    createdAt: niceDate(order.createdAt),
    updatedAt: niceDate(order.updatedAt),
    paidAt: niceDate(order.paidAt),

    paymentStatus: prettyStatus(order.paymentStatus),

    paymentStatusClass: statusClass(order.paymentStatus),

    fulfillmentStatus: prettyStatus(order.fulfillmentStatus),

    fulfillmentStatusClass: statusClass(order.fulfillmentStatus),

    supplierOrderStatus: prettyStatus(supplierStatus),

    supplierOrderStatusClass: statusClass(supplierStatus),

    trackingStatus: prettyStatus(trackingStatus),

    trackingStatusClass: statusClass(trackingStatus),

    trackingProgressStep: trackingProgressStep(trackingStatus),

    carrier: normalize(
      order?.tracking?.carrierName ||
        order?.supplierOrder?.logisticsName ||
        order?.selectedShipping?.logisticsName,
      300,
    ),

    service: normalize(order?.selectedShipping?.logisticsName, 300),

    deliveryEstimate: estimatedDeliveryText(order),

    trackingNumber,
    trackingUrl,

    lastTrackingUpdate: niceDate(
      order?.tracking?.lastSyncedAt || order?.supplierOrder?.lastSyncedAt || order.updatedAt,
    ),

    destinationCountryCode: normalize(
      order?.selectedShipping?.destinationCountryCode || order?.deliveryAddress?.countryCode,
      2,
    ).toUpperCase(),

    items: Array.isArray(order.items)
      ? order.items.map((item) => ({
          name: normalize(item?.name, 500) || 'CJ product',

          variantName: normalize(item?.variantName, 500),

          quantity: Math.max(0, Number(item?.quantity || 0)),

          imageUrl: normalize(item?.imageUrl, 2000),
        }))
      : [],

    events: publicTrackingEvents(order),
  };
}

async function getShopHeaderImage() {
  try {
    return await ShopHeaderImage.findOne({
      active: true,
    })
      .sort({
        updatedAt: -1,
      })
      .lean();
  } catch (error) {
    console.warn('[Public CJ tracking] Header image failed:', error?.message || error);

    return null;
  }
}

async function renderCjTrackingPage(
  req,
  res,
  { status = 200, form = {}, publicOrder = null, searched = false, errorMessage = '' } = {},
) {
  const shopHeaderImage = await getShopHeaderImage();

  return res.status(status).render('cj/order-tracking', {
    layout: 'layouts/store',
    title: 'Track Your CJ Order',

    storeDepartment: 'cj',
    productSource: 'CJ',

    shopHeaderImage,
    baseCurrency: BASE_CURRENCY,

    form: {
      cjOrderNumber: normalize(form.cjOrderNumber, 100),

      email: normalize(form.email, 320),
    },

    publicOrder,
    searched,
    errorMessage,
  });
}

router.get('/store/cj-order-tracking', async (req, res) => {
  return renderCjTrackingPage(req, res, {
    form: {
      cjOrderNumber: req.query?.cjOrderNumber,

      email: req.query?.email,
    },

    publicOrder: null,
    searched: false,
    errorMessage: '',
  });
});

router.post('/store/cj-order-tracking', publicCjTrackingLimiter, async (req, res) => {
  const cjOrderNumber = normalizeCjOrderNumber(req.body?.cjOrderNumber);

  const email = normalizeEmail(req.body?.email);

  const form = {
    cjOrderNumber,
    email,
  };

  if (!cjOrderNumber || !email) {
    return renderCjTrackingPage(req, res, {
      status: 400,
      form,
      publicOrder: null,
      searched: true,

      errorMessage: 'Please enter your CJ order number and the email address used during checkout.',
    });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderCjTrackingPage(req, res, {
      status: 400,
      form,
      publicOrder: null,
      searched: true,

      errorMessage: 'Please enter a valid checkout email address.',
    });
  }

  try {
    const order = await CjOrder.findOne({
      department: 'CJ',

      cjOrderNumber,

      $or: [
        {
          customerEmail: email,
        },

        {
          'deliveryAddress.email': email,
        },

        {
          'payer.email': email,
        },
      ],
    })
      .select(
        [
          'department',
          'cjOrderNumber',
          'customerEmail',
          'status',
          'paymentStatus',
          'fulfillmentStatus',

          'items.name',
          'items.variantName',
          'items.quantity',
          'items.imageUrl',

          'deliveryAddress.email',
          'deliveryAddress.countryCode',

          'selectedShipping.logisticsName',
          'selectedShipping.deliveryEstimate',
          'selectedShipping.destinationCountryCode',

          'payer.email',

          'supplierOrder.createStatus',
          'supplierOrder.trackingNumber',
          'supplierOrder.trackingUrl',
          'supplierOrder.logisticsName',
          'supplierOrder.lastSyncedAt',

          'tracking.status',
          'tracking.trackingNumber',
          'tracking.trackingUrl',
          'tracking.carrierName',
          'tracking.estimatedDelivery',
          'tracking.events',
          'tracking.lastSyncedAt',

          'paidAt',
          'createdAt',
          'updatedAt',
        ].join(' '),
      )
      .lean();

    if (!order) {
      /*
       * Keep this message generic so the response does not reveal
       * whether the order number or the email was the incorrect value.
       */
      return renderCjTrackingPage(req, res, {
        status: 404,
        form,
        publicOrder: null,
        searched: true,

        errorMessage: 'We could not find a CJ order matching that order number and email address.',
      });
    }

    return renderCjTrackingPage(req, res, {
      form,
      publicOrder: publicOrderView(order),

      searched: true,
      errorMessage: '',
    });
  } catch (error) {
    console.error('[Public CJ tracking] Lookup failed:', error?.stack || error);

    return renderCjTrackingPage(req, res, {
      status: 500,
      form,
      publicOrder: null,
      searched: true,

      errorMessage: 'CJ order tracking is temporarily unavailable. Please try again shortly.',
    });
  }
});

module.exports = router;
