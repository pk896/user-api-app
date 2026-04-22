// routes/adminOrdersViewApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const Order = require('../models/Order');
const Business = require('../models/Business');

const router = express.Router();

function safeStr(v, max = 300) {
  return String(v || '').trim().slice(0, max);
}

function toUpper(v) {
  return safeStr(v, 100).toUpperCase();
}

function moneyNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'object') {
    if (v.value != null) {
      const n = Number(v.value);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function resolveOrderCurrency(order) {
  return (
    safeStr(
      order?.amount?.currency ||
      order?.amount?.currency_code ||
      order?.total?.currency ||
      order?.total?.currency_code ||
      order?.breakdown?.itemTotal?.currency ||
      order?.breakdown?.itemTotal?.currency_code ||
      order?.breakdown?.taxTotal?.currency ||
      order?.breakdown?.taxTotal?.currency_code ||
      order?.breakdown?.shipping?.currency ||
      order?.breakdown?.shipping?.currency_code ||
      process.env.BASE_CURRENCY ||
      'USD',
      10
    ).toUpperCase() || 'USD'
  );
}

function escapeRegex(input) {
  return String(input || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeOrderStatus(order) {
  const s = toUpper(order?.status);
  const ps = toUpper(order?.paymentStatus);

  if (s === 'REFUNDED' || ps === 'REFUNDED') return 'REFUNDED';
  if (s === 'PARTIALLY_REFUNDED' || ps === 'PARTIALLY_REFUNDED') return 'PARTIALLY_REFUNDED';
  if (['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'].includes(s)) return 'COMPLETED';
  if (['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'].includes(ps)) return 'COMPLETED';

  return s || ps || 'UNKNOWN';
}

function buildReceiptNumber(order) {
  const orderId = safeStr(order?.orderId, 120);
  if (!orderId) return '';
  return `RCPT-${orderId}`;
}

function buildOrderSummary(order, businessMap) {
  const businessBuyerId = order?.businessBuyer ? String(order.businessBuyer) : '';
  const businessName = businessBuyerId ? (businessMap.get(businessBuyerId) || '') : '';

  const amountValue =
    moneyNumber(order?.amount?.value) ||
    moneyNumber(order?.amount) ||
    moneyNumber(order?.total?.value) ||
    moneyNumber(order?.total);

  const refundedTotal = moneyNumber(order?.refundedTotal);
  const captureId =
    safeStr(order?.paypal?.captureId, 120) ||
    safeStr(order?.captures?.[0]?.captureId, 120);

  return {
    _id: String(order?._id || ''),
    orderId: safeStr(order?.orderId, 120),
    receiptNumber: buildReceiptNumber(order),
    businessName,
    businessBuyerId,
    status: normalizeOrderStatus(order),
    paymentStatus: safeStr(order?.paymentStatus, 120),
    fulfillmentStatus: safeStr(order?.fulfillmentStatus, 120),
    amount: Number(amountValue.toFixed(2)),
    currency: resolveOrderCurrency(order),
    refundedTotal: Number(refundedTotal.toFixed(2)),
    refundedAt: order?.refundedAt || null,
    captureId,
    payerEmail: safeStr(order?.payer?.email, 160),
    createdAt: order?.createdAt || null,
    updatedAt: order?.updatedAt || null,
    receiptUrl: `/payment/receipt/${encodeURIComponent(order?.orderId || '')}`,
    viewUrl: `/admin-ui/order.html?id=${encodeURIComponent(order?.orderId || String(order?._id || ''))}`,
  };
}

/**
 * GET /api/admin/orders
 * Query params:
 *   q              -> searches orderId / receipt number / payer email
 *   businessName   -> searches buyer business name
 *   orderId        -> exact/partial orderId
 *   receiptNumber  -> exact/partial receipt number (RCPT-{orderId})
 *   status         -> all | completed | refunded | partially_refunded
 *   page           -> default 1
 *   limit          -> default 20 max 100
 */
router.get(
  '/orders',
  requireAdmin,
  requireAdminRole(['super_admin', 'orders_admin']),
  requireAdminPermission('orders.read'),
  async (req, res) => {
  try {
    const q = safeStr(req.query.q, 160);
    const businessName = safeStr(req.query.businessName, 160);
    const orderId = safeStr(req.query.orderId, 160);
    const receiptNumber = safeStr(req.query.receiptNumber, 160);
    const status = safeStr(req.query.status || 'all', 50).toLowerCase();
    const page = Math.max(1, Number(req.query.page || 1) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20) || 20));
    const skip = (page - 1) * limit;

    const mongoQuery = {};

    const statusList = [];
    if (status === 'completed') {
      statusList.push('COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED');
      mongoQuery.$or = [
        { status: { $in: statusList } },
        { paymentStatus: { $in: statusList.map((x) => x.toLowerCase()) } },
        { paymentStatus: { $in: statusList } },
      ];
    } else if (status === 'refunded') {
      mongoQuery.$or = [
        { status: 'REFUNDED' },
        { paymentStatus: 'refunded' },
        { paymentStatus: 'REFUNDED' },
      ];
    } else if (status === 'partially_refunded') {
      mongoQuery.$or = [
        { status: 'PARTIALLY_REFUNDED' },
        { paymentStatus: 'partially_refunded' },
        { paymentStatus: 'PARTIALLY_REFUNDED' },
      ];
    } else {
      mongoQuery.$or = [
        { status: { $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED'] } },
        { paymentStatus: { $in: ['paid', 'completed', 'captured', 'refunded', 'partially_refunded', 'REFUNDED', 'PARTIALLY_REFUNDED'] } },
      ];
    }

    const andParts = [];

    if (q) {
      const qRegex = new RegExp(escapeRegex(q), 'i');
      const receiptOrderId = q.replace(/^RCPT-/i, '').trim();

      andParts.push({
        $or: [
          { orderId: qRegex },
          { 'payer.email': qRegex },
          { 'paypal.captureId': qRegex },
          { 'captures.captureId': qRegex },
          ...(receiptOrderId ? [{ orderId: new RegExp(escapeRegex(receiptOrderId), 'i') }] : []),
        ],
      });
    }

    if (orderId) {
      andParts.push({
        orderId: new RegExp(escapeRegex(orderId), 'i'),
      });
    }

    if (receiptNumber) {
      const rawOrderId = receiptNumber.replace(/^RCPT-/i, '').trim();
      andParts.push({
        orderId: new RegExp(escapeRegex(rawOrderId), 'i'),
      });
    }

    if (businessName) {
      const businesses = await Business.find({
        name: new RegExp(escapeRegex(businessName), 'i'),
      })
        .select('_id name')
        .lean();

      const businessIds = businesses.map((b) => b._id);

      if (!businessIds.length) {
        return res.json({
          ok: true,
          page,
          limit,
          total: 0,
          pages: 0,
          orders: [],
        });
      }

      andParts.push({
        businessBuyer: { $in: businessIds },
      });
    }

    if (andParts.length) {
      mongoQuery.$and = andParts;
    }

    const [orders, total] = await Promise.all([
      Order.find(mongoQuery)
        .select([
          '_id',
          'orderId',
          'status',
          'paymentStatus',
          'fulfillmentStatus',
          'amount',
          'refundedTotal',
          'refundedAt',
          'payer.email',
          'paypal.captureId',
          'captures.captureId',
          'businessBuyer',
          'createdAt',
          'updatedAt',
        ].join(' '))
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(mongoQuery),
    ]);

    const businessIdsNeeded = [
      ...new Set(
        orders
          .map((o) => (o?.businessBuyer ? String(o.businessBuyer) : ''))
          .filter(Boolean)
      ),
    ];

    const businesses = businessIdsNeeded.length
      ? await Business.find({ _id: { $in: businessIdsNeeded } })
          .select('_id name')
          .lean()
      : [];

    const businessMap = new Map(
      businesses.map((b) => [String(b._id), safeStr(b.name, 200)])
    );

    const normalized = orders.map((order) => buildOrderSummary(order, businessMap));

    return res.json({
      ok: true,
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
      orders: normalized,
    });
  } catch (error) {
    console.error('❌ admin orders list error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load admin orders',
    });
  }
});

/**
 * GET /api/admin/orders/:id
 * id may be:
 *   - orderId
 *   - Mongo _id
 */
router.get(
  '/orders/:id',
  requireAdmin,
  requireAdminRole(['super_admin', 'orders_admin']),
  requireAdminPermission('orders.read'),
  async (req, res) => {
  try {
    const id = safeStr(req.params.id, 160);
    if (!id) {
      return res.status(400).json({ ok: false, message: 'Order id is required' });
    }

    let order = await Order.findOne({ orderId: id }).lean();

    if (!order && mongoose.isValidObjectId(id)) {
      order = await Order.findById(id).lean();
    }

    if (!order) {
      return res.status(404).json({
        ok: false,
        message: 'Order not found',
      });
    }

    let business = null;
    if (order.businessBuyer && mongoose.isValidObjectId(order.businessBuyer)) {
      business = await Business.findById(order.businessBuyer)
        .select('_id name email phone')
        .lean();
    }

    const currency = resolveOrderCurrency(order);

    const detailed = {
      _id: String(order._id),
      orderId: safeStr(order.orderId, 120),
      receiptNumber: buildReceiptNumber(order),
      status: normalizeOrderStatus(order),
      paymentStatus: safeStr(order.paymentStatus, 120),
      fulfillmentStatus: safeStr(order.fulfillmentStatus, 120),
      createdAt: order.createdAt || null,
      updatedAt: order.updatedAt || null,

      amount: {
        value: Number(moneyNumber(order?.amount?.value || order?.amount).toFixed(2)),
        currency,
      },

      breakdown: {
        itemTotal: order?.breakdown?.itemTotal || null,
        taxTotal: order?.breakdown?.taxTotal || null,
        shipping: order?.breakdown?.shipping || null,
      },

      refundedTotal: Number(moneyNumber(order?.refundedTotal).toFixed(2)),
      refundedAt: order?.refundedAt || null,
      refunds: Array.isArray(order.refunds) ? order.refunds : [],

      payer: order.payer || null,
      businessBuyer: business
        ? {
            _id: String(business._id),
            name: safeStr(business.name, 200),
            email: safeStr(business.email, 200),
            phone: safeStr(business.phone, 80),
          }
        : null,

      shipping: order.shipping || null,
      shippingTracking: order.shippingTracking || null,
      paypal: order.paypal || null,
      captures: Array.isArray(order.captures) ? order.captures : [],
      delivery: order.delivery || null,

      items: Array.isArray(order.items)
        ? order.items.map((item) => ({
            productId: safeStr(item?.productId, 120),
            name: safeStr(item?.name, 300),
            quantity: Number(item?.quantity || 0),
            imageUrl: safeStr(item?.imageUrl, 500),
            variants: item?.variants || {},
            price: item?.price || null,
            priceGross: item?.priceGross || null,
          }))
        : [],

      receiptUrl: `/payment/receipt/${encodeURIComponent(order.orderId || '')}`,
    };

    return res.json({
      ok: true,
      order: detailed,
    });
  } catch (error) {
    console.error('❌ admin order details error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load order details',
    });
  }
});

module.exports = router;