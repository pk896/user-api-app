// routes/sellerRecentOrdersCardApi.js
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

function moneyToNumber(m) {
  if (!m) return 0;
  if (typeof m === 'number') return m;
  if (typeof m === 'string') return Number(m) || 0;
  if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
  return 0;
}

function getSellerOrderAmount(order, productKeySet, productPriceByKey) {
  const items = Array.isArray(order?.items) ? order.items : [];
  let total = 0;

  for (const item of items) {
    const pid = String(item?.productId || item?.customId || item?.pid || item?.sku || '').trim();
    if (!pid || !productKeySet.has(pid)) continue;

    const qty = Number(item?.quantity || 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const itemUnitPrice = moneyToNumber(item?.priceGross) || moneyToNumber(item?.price);
    const fallbackPrice = Number(productPriceByKey.get(pid) || 0);
    const unitPrice = itemUnitPrice || fallbackPrice;

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) continue;

    total += qty * unitPrice;
  }

  return Number(total.toFixed(2));
}

// GET /api/seller/recent-orders-card
router.get('/recent-orders-card', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business?._id || !mongoose.isValidObjectId(business._id)) {
      return res.status(401).json({
        ok: false,
        message: 'Unauthorized',
      });
    }

    if (String(business.role || '').trim() !== 'seller') {
      return res.status(403).json({
        ok: false,
        message: 'Sellers only',
      });
    }

    const products = await Product.find({ business: business._id })
      .select('_id customId price')
      .lean();

    const productKeySet = new Set();
    const productPriceByKey = new Map();

    for (const product of products) {
      const price = Number(product?.price || 0);

      if (product?._id) {
        const objectIdKey = String(product._id).trim();
        if (objectIdKey) {
          productKeySet.add(objectIdKey);
          productPriceByKey.set(objectIdKey, price);
        }
      }

      if (product?.customId) {
        const customIdKey = String(product.customId).trim();
        if (customIdKey) {
          productKeySet.add(customIdKey);
          productPriceByKey.set(customIdKey, price);
        }
      }
    }

    const productKeys = Array.from(productKeySet);

    if (productKeys.length === 0) {
      return res.json({
        ok: true,
        orders: [],
      });
    }

    const orders = await Order.find({
      $or: [
        { 'items.productId': { $in: productKeys } },
        { 'items.customId': { $in: productKeys } },
        { 'items.pid': { $in: productKeys } },
        { 'items.sku': { $in: productKeys } },
      ],
    })
      .select('_id orderId status amount total createdAt items')
      .sort({ createdAt: -1, _id: -1 })
      .limit(10)
      .lean();

    const normalizedOrders = orders.map((order) => {
      const sellerAmount =
        getSellerOrderAmount(order, productKeySet, productPriceByKey) ||
        moneyToNumber(order?.amount) ||
        moneyToNumber(order?.total);

      return {
        _id: String(order?._id || ''),
        orderId: String(order?.orderId || ''),
        status: String(order?.status || 'PENDING'),
        amount: sellerAmount,
        createdAt: order?.createdAt || null,
      };
    });

    return res.json({
      ok: true,
      orders: normalizedOrders,
    });
  } catch (error) {
    console.error('❌ seller recent orders card api error:', error);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load recent orders',
    });
  }
});

module.exports = router;