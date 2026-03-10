// routes/sellerInventoryApi.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const Product = require('../models/Product');
const ProductStockHistory = require('../models/ProductStockHistory');
const requireBusiness = require('../middleware/requireBusiness');

const router = express.Router();

function getBusinessId(req) {
  return (
    req.session?.business?._id ||
    req.session?.business?.id ||
    req.business?._id ||
    req.user?._id ||
    null
  );
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function endOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

function buildLast7Days() {
  const days = [];
  const now = new Date();

  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);

    days.push({
      start: startOfDay(d),
      end: endOfDay(d),
      label: d.toLocaleDateString('en-US', { weekday: 'short' }),
    });
  }

  return days;
}

router.get('/inventory-value', requireBusiness, async (req, res) => {
  try {
    const businessId = getBusinessId(req);

    if (!businessId) {
      return res.status(401).json({
        success: false,
        message: 'Business session not found.',
      });
    }

    if (!mongoose.Types.ObjectId.isValid(businessId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid business id.',
      });
    }

    const businessObjectId = new mongoose.Types.ObjectId(businessId);

    const products = await Product.find({ business: businessObjectId })
      .select('_id price stock')
      .lean();

    const totalProducts = products.length;
    const totalUnits = products.reduce((sum, product) => sum + Number(product.stock || 0), 0);
    const inventoryValue = products.reduce(
      (sum, product) => sum + Number(product.stock || 0) * Number(product.price || 0),
      0,
    );

    const days = buildLast7Days();
    const oldestDayStart = days[0].start;

    const productIds = products.map((product) => product._id);

    let stockHistoryEntries = [];

    if (productIds.length > 0) {
      stockHistoryEntries = await ProductStockHistory.find({
        business: businessObjectId,
        product: { $in: productIds },
        createdAt: { $gte: oldestDayStart },
      })
        .select('product delta createdAt')
        .sort({ createdAt: 1 })
        .lean();
    }

    const historyByProductId = new Map();

    for (const entry of stockHistoryEntries) {
      const productId = String(entry.product);

      if (!historyByProductId.has(productId)) {
        historyByProductId.set(productId, []);
      }

      historyByProductId.get(productId).push({
        delta: Number(entry.delta || 0),
        createdAt: new Date(entry.createdAt),
      });
    }

    const historyData = days.map((day) => {
      let dayInventoryValue = 0;

      for (const product of products) {
        const productId = String(product._id);
        const currentStock = Number(product.stock || 0);
        const currentPrice = Number(product.price || 0);
        const productHistory = historyByProductId.get(productId) || [];

        let stockAtEndOfDay = currentStock;

        for (const historyEntry of productHistory) {
          if (historyEntry.createdAt > day.end) {
            stockAtEndOfDay -= Number(historyEntry.delta || 0);
          }
        }

        if (stockAtEndOfDay < 0) {
          stockAtEndOfDay = 0;
        }

        dayInventoryValue += stockAtEndOfDay * currentPrice;
      }

      return Number(dayInventoryValue.toFixed(2));
    });

    return res.json({
      success: true,
      data: {
        inventoryValue: Number(inventoryValue.toFixed(2)),
        totalProducts,
        totalUnits,
        history: {
          labels: days.map((day) => day.label),
          data: historyData,
        },
      },
    });
  } catch (err) {
    console.error('❌ Failed to fetch seller inventory value:', err);

    return res.status(500).json({
      success: false,
      message: 'Failed to fetch inventory value.',
    });
  }
});

module.exports = router;