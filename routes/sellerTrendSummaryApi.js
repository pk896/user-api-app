// routes/sellerTrendSummaryApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBiz(req) {
  return req.business || req.session?.business || null;
}

function buildPaidStates() {
  const rawPaid = Array.isArray(Order?.PAID_STATES)
    ? Order.PAID_STATES
    : ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];

  return Array.from(
    new Set(
      rawPaid.flatMap((state) => {
        const v = String(state || '').trim();
        if (!v) return [];

        const lower = v.toLowerCase();
        const title = lower.charAt(0).toUpperCase() + lower.slice(1);

        return [v, v.toUpperCase(), v.toLowerCase(), title];
      })
    )
  );
}

function buildNonRefundedPaidMatch(extra = {}) {
  const paidStates = buildPaidStates();

  const cancelStates = ['Cancelled', 'Canceled', 'CANCELLED', 'CANCELED', 'VOIDED', 'Voided'];
  const refundStates = [
    'Refunded',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'Partially Refunded',
    'REFUND_SUBMITTED'
  ];
  const refundPaymentStatuses = [
    'refunded',
    'partially_refunded',
    'refund_submitted',
    'refund_pending'
  ];

  const base = {
    status: { $in: paidStates },
    $and: [
      { status: { $nin: [...cancelStates, ...refundStates] } },
      { paymentStatus: { $nin: refundPaymentStatuses } },
      { isRefunded: { $ne: true } },
      { refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED', 'COMPLETED'] } },
      { $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }] }
    ]
  };

  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const { $and: _ignoredAnd, ...rest } = extra || {};

  return {
    ...base,
    ...rest,
    $and: [...base.$and, ...extraAnd]
  };
}

function isRefundedItem(item) {
  if (!item) return false;
  if (item.isRefunded === true) return true;

  const refundStatus = String(item.refundStatus || '').trim().toUpperCase();
  if (
    refundStatus === 'REFUNDED' ||
    refundStatus === 'FULL' ||
    refundStatus === 'FULLY_REFUNDED' ||
    refundStatus === 'COMPLETED'
  ) {
    return true;
  }

  if (item.refundedAt) return true;

  return false;
}

function getMatchedSellerItems(order, productKeySet) {
  const items = Array.isArray(order?.items) ? order.items : [];

  return items.filter((item) => {
    const pid = String(item?.productId || item?.customId || item?.pid || item?.sku || '').trim();
    return pid && productKeySet.has(pid);
  });
}

function getDayKey(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

router.get('/trend-summary', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business?._id || !mongoose.isValidObjectId(business._id)) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }

    if (String(business.role || '').trim() !== 'seller') {
      return res.status(403).json({ ok: false, message: 'Sellers only' });
    }

    const start = new Date();
    start.setDate(start.getDate() - 29);
    start.setHours(0, 0, 0, 0);

    // 1) load seller products
    const products = await Product.find({ business: business._id })
      .select('_id customId')
      .lean();

    const productKeySet = new Set();

    for (const product of products) {
      if (product?.customId) {
        const customId = String(product.customId).trim();
        if (customId) productKeySet.add(customId);
      }

      if (product?._id) {
        const objectId = String(product._id).trim();
        if (objectId) productKeySet.add(objectId);
      }
    }

    const productKeys = Array.from(productKeySet);

    if (productKeys.length === 0) {
      return res.json({
        ok: true,
        summary: {
          salesLast30Days: 0,
          refundsLast30Days: 0,
          ordersLast30Days: 0,
          lastSalesPeakLast30Days: 0
        }
      });
    }

    const idMatchOr = [
      { 'items.productId': { $in: productKeys } },
      { 'items.customId': { $in: productKeys } },
      { 'items.pid': { $in: productKeys } },
      { 'items.sku': { $in: productKeys } }
    ];

    // 2) paid, non-refunded seller orders in last 30 days
    const paidOrders = await Order.find(
      buildNonRefundedPaidMatch({
        createdAt: { $gte: start },
        $or: idMatchOr
      })
    )
      .select('createdAt items')
      .lean();

    let salesLast30Days = 0;
    let ordersLast30Days = 0;
    const salesPerDay = new Map();

    for (const order of paidOrders) {
      const matchedItems = getMatchedSellerItems(order, productKeySet);

      let orderSoldQty = 0;

      for (const item of matchedItems) {
        if (isRefundedItem(item)) continue;

        const qty = Number(item?.quantity || 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        orderSoldQty += qty;
      }

      if (orderSoldQty > 0) {
        salesLast30Days += orderSoldQty;
        ordersLast30Days += 1;

        const dayKey = getDayKey(order.createdAt);
        salesPerDay.set(dayKey, Number(salesPerDay.get(dayKey) || 0) + orderSoldQty);
      }
    }

    const lastSalesPeakLast30Days =
      salesPerDay.size > 0 ? Math.max(...Array.from(salesPerDay.values())) : 0;

    // 3) refunds in last 30 days for seller products
    const refundOrders = await Order.find({
      $and: [
        { $or: idMatchOr },
        {
          $or: [
            { refundedAt: { $gte: start } },
            { 'refunds.createdAt': { $gte: start } },
            { 'items.refundedAt': { $gte: start } },
            { status: { $in: ['Refunded', 'REFUNDED', 'PARTIALLY_REFUNDED', 'Partially Refunded'] } },
            { paymentStatus: { $in: ['refunded', 'partially_refunded', 'refund_submitted', 'refund_pending'] } }
          ]
        }
      ]
    })
      .select('refundedAt refunds items status paymentStatus')
      .lean();

    let refundsLast30Days = 0;

    for (const order of refundOrders) {
      const matchedItems = getMatchedSellerItems(order, productKeySet);

      for (const item of matchedItems) {
        if (!isRefundedItem(item)) continue;

        const qty = Number(item?.quantity || 0);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const itemRefundedAt = item?.refundedAt ? new Date(item.refundedAt) : null;
        const orderRefundedAt = order?.refundedAt ? new Date(order.refundedAt) : null;
        const refundRows = Array.isArray(order?.refunds) ? order.refunds : [];

        const refundInRange =
          (itemRefundedAt && itemRefundedAt >= start) ||
          (orderRefundedAt && orderRefundedAt >= start) ||
          refundRows.some((row) => row?.createdAt && new Date(row.createdAt) >= start);

        if (!refundInRange) continue;

        refundsLast30Days += qty;
      }
    }

    return res.json({
      ok: true,
      summary: {
        salesLast30Days,
        refundsLast30Days,
        ordersLast30Days,
        lastSalesPeakLast30Days
      }
    });
  } catch (error) {
    console.error('❌ seller trend summary api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load seller trend summary'
    });
  }
});

module.exports = router;