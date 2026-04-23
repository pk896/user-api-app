// routes/sellerTrendOverviewApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const ProductStockHistory = require('../models/ProductStockHistory');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------
function getBiz(req) {
  return req.business || req.session?.business || null;
}

function moneyToNumber(m) {
  if (!m) return 0;
  if (typeof m === 'number') return m;
  if (typeof m === 'string') return Number(m) || 0;
  if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
  return 0;
}

function buildNonRefundedPaidMatch(extra = {}) {
  const RAW_PAID = Array.isArray(Order?.PAID_STATES)
    ? Order.PAID_STATES
    : ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];

  const PAID_STATES = Array.from(
    new Set(
      RAW_PAID.flatMap((s) => {
        const v = String(s || '').trim();
        if (!v) return [];
        const lower = v.toLowerCase();
        const title = lower.charAt(0).toUpperCase() + lower.slice(1);
        return [v, v.toUpperCase(), v.toLowerCase(), title];
      })
    )
  );

  const CANCEL_STATES = ['Cancelled', 'Canceled', 'CANCELLED', 'CANCELED', 'VOIDED', 'Voided'];
  const REFUND_STATES = ['Refunded', 'REFUNDED', 'PARTIALLY_REFUNDED', 'Partially Refunded', 'REFUND_SUBMITTED'];
  const REFUND_PAYMENT_STATUSES = ['refunded', 'partially_refunded', 'refund_submitted', 'refund_pending'];

  const base = {
    status: { $in: PAID_STATES },
    $and: [
      { status: { $nin: [...CANCEL_STATES, ...REFUND_STATES] } },
      { paymentStatus: { $nin: REFUND_PAYMENT_STATUSES } },
      { isRefunded: { $ne: true } },
      { refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED', 'COMPLETED'] } },
      { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] },
    ],
  };

  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const { _$and, ...rest } = extra || {};

  return {
    ...base,
    ...rest,
    $and: [...base.$and, ...extraAnd],
  };
}

function isRefundedItem(item) {
  if (!item) return false;
  if (item.isRefunded === true) return true;

  const rs = String(item.refundStatus || '').trim().toUpperCase();
  if (rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED' || rs === 'COMPLETED') {
    return true;
  }

  if (item.refundedAt) return true;
  return false;
}

function computeSellerSalesAmountFromOrder(order, productKeySet, productPriceByKey) {
  let total = 0;
  const items = Array.isArray(order?.items) ? order.items : [];

  for (const item of items) {
    if (isRefundedItem(item)) continue;

    const pid = String(item.productId || item.customId || item.pid || item.sku || '').trim();
    if (!pid || !productKeySet.has(pid)) continue;

    const qty = Number(item.quantity || 1);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const itemUnitPrice = moneyToNumber(item.price);
    const fallbackProductPrice = Number(productPriceByKey.get(pid) || 0);
    const unitPrice = itemUnitPrice || fallbackProductPrice;

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

    total += qty * unitPrice;
  }

  return total;
}

function getDayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getMonthKey(date) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; // YYYY-MM
}

function buildDayBuckets() {
  const labels = [];
  const keys = [];
  const now = new Date();

  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);

    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
    const label = d.toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', hour12: false });

    keys.push(key);
    labels.push(label);
  }

  return { keys, labels };
}

function buildMonthBuckets() {
  const labels = [];
  const keys = [];
  const now = new Date();

  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    d.setHours(0, 0, 0, 0);

    const key = getDayKey(d);
    const label = d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });

    keys.push(key);
    labels.push(label);
  }

  return { keys, labels };
}

function buildYearBuckets() {
  const labels = [];
  const keys = [];
  const now = new Date();

  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });

    keys.push(key);
    labels.push(label);
  }

  return { keys, labels };
}

function getRangeConfig(range) {
  const safeRange = ['day', 'month', 'year'].includes(String(range)) ? String(range) : 'month';
  const now = new Date();

  if (safeRange === 'day') {
    const start = new Date(now);
    start.setHours(start.getHours() - 23, 0, 0, 0);

    return {
      range: 'day',
      rangeLabel: 'Last 24 hours',
      start,
      bucketType: 'hour',
      ...buildDayBuckets(),
    };
  }

  if (safeRange === 'year') {
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    return {
      range: 'year',
      rangeLabel: 'Last 12 months',
      start,
      bucketType: 'month',
      ...buildYearBuckets(),
    };
  }

  const start = new Date(now);
  start.setDate(start.getDate() - 29);
  start.setHours(0, 0, 0, 0);

  return {
    range: 'month',
    rangeLabel: 'Last 30 days',
    start,
    bucketType: 'day',
    ...buildMonthBuckets(),
  };
}

function getBucketKey(date, bucketType) {
  const d = new Date(date);

  if (bucketType === 'hour') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:00`;
  }

  if (bucketType === 'month') {
    return getMonthKey(d);
  }

  return getDayKey(d);
}

// -------------------------------------------------------
// GET /api/seller/trend-overview?range=day|month|year
// -------------------------------------------------------
router.get('/trend-overview', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business?._id || !mongoose.isValidObjectId(business._id)) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    if (String(business.role || '').trim() !== 'seller') {
      return res.status(403).json({ ok: false, message: 'Sellers only' });
    }

    const { range, rangeLabel, start, bucketType, keys, labels } = getRangeConfig(req.query.range);

    // ---------------------------------------------------
    // 1) Load seller products
    // ---------------------------------------------------
    const products = await Product.find({ business: business._id })
      .select('_id customId price')
      .lean();

    const productKeySet = new Set();
    const productPriceByKey = new Map();

    for (const product of products) {
      const price = Number(product?.price || 0);

      if (product?.customId) {
        const customId = String(product.customId).trim();
        if (customId) {
          productKeySet.add(customId);
          productPriceByKey.set(customId, price);
        }
      }

      if (product?._id) {
        const objectId = String(product._id).trim();
        if (objectId) {
          productKeySet.add(objectId);
          productPriceByKey.set(objectId, price);
        }
      }
    }

    const productKeys = Array.from(productKeySet);

    // prepare result maps
    const salesMap = new Map(keys.map((key) => [key, 0]));
    const stockMap = new Map(keys.map((key) => [key, 0]));

    // ---------------------------------------------------
    // 2) Sales trend = money amount, not order count
    // ---------------------------------------------------
    if (productKeys.length > 0) {
      const idMatchOr = [
        { 'items.productId': { $in: productKeys } },
        { 'items.customId': { $in: productKeys } },
        { 'items.pid': { $in: productKeys } },
        { 'items.sku': { $in: productKeys } },
      ];

      const orderMatch = buildNonRefundedPaidMatch({
        createdAt: { $gte: start },
        $or: idMatchOr,
      });

      const orders = await Order.find(orderMatch)
        .select('createdAt items')
        .lean();

      for (const order of orders) {
        const salesAmount = computeSellerSalesAmountFromOrder(order, productKeySet, productPriceByKey);
        if (salesAmount <= 0) continue;

        const bucketKey = getBucketKey(order.createdAt, bucketType);
        if (!salesMap.has(bucketKey)) continue;

        salesMap.set(bucketKey, Number((salesMap.get(bucketKey) + salesAmount).toFixed(2)));
      }
    }

    // ---------------------------------------------------
    // 3) Stock movement trend = sum of delta
    // ---------------------------------------------------
    const stockHistory = await ProductStockHistory.find({
      business: business._id,
      createdAt: { $gte: start },
    })
      .select('createdAt delta')
      .lean();

    for (const entry of stockHistory) {
      const delta = Number(entry?.delta || 0);
      const bucketKey = getBucketKey(entry.createdAt, bucketType);

      if (!stockMap.has(bucketKey)) continue;
      stockMap.set(bucketKey, Number((stockMap.get(bucketKey) + delta).toFixed(2)));
    }

    // ---------------------------------------------------
    // 4) Final arrays
    // ---------------------------------------------------
    const sales = keys.map((key) => Number((salesMap.get(key) || 0).toFixed(2)));
    const stock = keys.map((key) => Number((stockMap.get(key) || 0).toFixed(2)));

    return res.json({
      ok: true,
      currency:
        String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
        'USD',
      range,
      rangeLabel,
      chart: {
        labels,
        sales,
        stock,
      },
    });
  } catch (error) {
    console.error('❌ seller trend overview api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load seller trend overview',
    });
  }
});

module.exports = router;