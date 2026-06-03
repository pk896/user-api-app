// routes/businessAuth.js
'use strict';

const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const Business = require('../models/Business');
const Product = require('../models/Product'); // seller products - keep for seller/buyer flows
const SupplierProduct = require('../models/SupplierProduct');
const SupplyRequest = require('../models/SupplyRequest');
const _DeliveryOption = require('../models/DeliveryOption');
const requireBusiness = require('../middleware/requireBusiness');
const redirectIfLoggedIn = require('../middleware/redirectIfLoggedIn');
const BusinessResetToken = require('../models/BusinessResetToken');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');
const { sendMail } = require('../utils/mailer');
const mongoose = require('mongoose');
const Order = require('../models/Order');

const router = express.Router();
const Payout = require('../models/Payout');
const { getSellerAvailableCents } = require('../utils/payouts/getSellerAvailableCents');

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || '')
    .trim()
    .toUpperCase() || 'USD';

function formatBusinessMoney(amount) {
  const n = Number(amount || 0);

  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: BASE_CURRENCY,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(n);

    if (BASE_CURRENCY === 'ZAR') {
      return formatted.replace(/^ZAR\s?/, 'R');
    }

    return formatted;
  } catch {
    return `${BASE_CURRENCY} ${n.toFixed(2)}`;
  }
}

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — business logo uploads will fail.');
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const businessLogoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG/JPG/WEBP/GIF/BMP images are allowed'));
    cb(null, true);
  },
});

const buildS3ImageUrl = (key) => `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

function extFromFilename(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? 'bin' : name.substring(dot + 1);
}

function randomBusinessLogoKey(ext) {
  return `business-logos/${uuidv4()}.${ext}`;
}

async function uploadBusinessLogoToS3(file) {
  const { originalname, buffer, mimetype } = file;
  const ext = extFromFilename(originalname);
  const key = randomBusinessLogoKey(ext);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    }),
  );

  return buildS3ImageUrl(key);
}

async function deleteS3ImageByUrl(imageUrl) {
  try {
    if (!imageUrl || !imageUrl.includes('.amazonaws.com/')) return;
    const key = imageUrl.split('.amazonaws.com/')[1];
    if (!key) return;

    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
  } catch (err) {
    console.warn('⚠️ Failed to delete business logo from S3:', err.message);
  }
}

// Normalize emails (main business email)
function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

// Normalize PayPal email (same rules as normal email)
function normalizePaypalEmail(v) {
  return String(v || '')
    .trim()
    .replace(/\s+/g, '')
    .toLowerCase();
}

// Loose but safe email check (good enough for PayPal email field)
function isValidEmailLoose(v) {
  const s = String(v || '').trim();
  if (!s) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

/**
 * ✅ Apply PayPal payouts fields consistently (checkbox + email).
 * Rules:
 * - If payoutsEnabled = false => payouts.enabled=false (email may be kept if valid OR cleared if empty)
 * - If payoutsEnabled = true  => paypalEmail MUST exist + be valid, and payouts.enabled=true
 * - Touch updatedAt only if something actually changed
 *
 * @param {Object} businessDoc Mongoose doc
 * @param {string} paypalEmailRaw raw email input
 * @param {boolean} payoutsEnabled whether checkbox is ON
 */
function applyPaypalPayouts(businessDoc, paypalEmailRaw, payoutsEnabled) {
  const norm = normalizePaypalEmail(paypalEmailRaw);

  businessDoc.payouts = businessDoc.payouts || {};

  const prevEmail = String(businessDoc.payouts.paypalEmail || '')
    .trim()
    .toLowerCase();
  const prevEnabled = Boolean(businessDoc.payouts.enabled);

  const wantEnabled = Boolean(payoutsEnabled);

  // ✅ If checkbox ON -> email required + must be valid
  if (wantEnabled) {
    if (!norm) {
      return { ok: false, error: 'Please enter your PayPal email to enable payouts.' };
    }
    if (!isValidEmailLoose(norm)) {
      return { ok: false, error: 'PayPal email must be a valid email address.' };
    }

    const changed = prevEmail !== norm || prevEnabled !== true;

    businessDoc.payouts.paypalEmail = norm;
    businessDoc.payouts.enabled = true;
    if (changed) businessDoc.payouts.updatedAt = new Date();

    return { ok: true, paypalEmail: norm, enabled: true };
  }

  // ✅ Checkbox OFF -> payouts disabled
  // If they typed an email, validate format (optional), and store it (useful for later enabling)
  if (norm && !isValidEmailLoose(norm)) {
    return { ok: false, error: 'PayPal email must be a valid email address.' };
  }

  // If empty: remove field for cleanliness
  if (!norm) {
    const changed = prevEnabled !== false || prevEmail !== '';
    businessDoc.payouts.paypalEmail = undefined;
    businessDoc.payouts.enabled = false;
    if (changed) businessDoc.payouts.updatedAt = new Date();
    return { ok: true, paypalEmail: null, enabled: false };
  }

  // Checkbox OFF but email provided (store email, keep enabled false)
  const changed = prevEmail !== norm || prevEnabled !== false;

  businessDoc.payouts.paypalEmail = norm;
  businessDoc.payouts.enabled = false;
  if (changed) businessDoc.payouts.updatedAt = new Date();

  return { ok: true, paypalEmail: norm, enabled: false };
}

function pickField(body, dottedPath, fallback = '') {
  // dottedPath example: "representative.fullName"
  const direct = body?.[dottedPath];
  if (direct !== undefined) return String(direct).trim();

  const parts = dottedPath.split('.');
  let cur = body;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return String(fallback).trim();
    cur = cur[p];
  }
  return String(cur ?? fallback).trim();
}

const LOW_STOCK_THRESHOLD = 10;
const SUPPLIER_LOW_STOCK_THRESHOLD = 15;

function startOfDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth(date = new Date()) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function monthKey(date) {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function monthLabelFromKey(key) {
  const [year, month] = String(key || '').split('-');
  const d = new Date(Number(year), Number(month) - 1, 1);

  return d.toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
  });
}

function lastMonthKeys(count = 7) {
  const now = startOfMonth(new Date());
  const keys = [];

  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setMonth(now.getMonth() - i);
    keys.push(monthKey(d));
  }

  return keys;
}

async function buildSupplierMainChartData(supplierId) {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));
  const keys = lastMonthKeys(7);

  const firstKey = keys[0];
  const [firstYear, firstMonth] = firstKey.split('-');
  const fromDate = new Date(Number(firstYear), Number(firstMonth) - 1, 1);

  const now = new Date();

  const last30Start = new Date(now);
  last30Start.setDate(last30Start.getDate() - 29);
  last30Start.setHours(0, 0, 0, 0);

  const current7Start = startOfDaysAgo(7);
  const previous14Start = startOfDaysAgo(14);

  // ✅ Main chart data: keep the existing 7-month chart flow.
  // This avoids disturbing the chart that is already working.
  const importedRows = await SupplyRequest.aggregate([
    {
      $match: {
        supplier: supplierObjectId,
        status: 'approved',
        createdAt: { $gte: fromDate },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        },

        // Purple line: approved imported products/requests
        importedProducts: { $sum: 1 },

        // Green line: approved imported seller stock/requested qty
        importedStock: { $sum: '$requestedQuantity' },
      },
    },
  ]);

  const importedProductsMap = new Map();
  const importedStockMap = new Map();

  importedRows.forEach((row) => {
    const key = `${row._id.year}-${String(row._id.month).padStart(2, '0')}`;

    importedProductsMap.set(key, Number(row.importedProducts || 0));
    importedStockMap.set(key, Number(row.importedStock || 0));
  });

  // ✅ Summary 1:
  // Total requested quantity in the last 30 days.
  // We exclude cancelled requests because they are no longer active business demand.
  const requestedLast30Rows = await SupplyRequest.aggregate([
    {
      $match: {
        supplier: supplierObjectId,
        status: { $ne: 'cancelled' },
        createdAt: { $gte: last30Start },
      },
    },
    {
      $group: {
        _id: null,
        totalRequestedQty: { $sum: '$requestedQuantity' },
      },
    },
  ]);

  const requestedQtyLast30 = Number(requestedLast30Rows[0]?.totalRequestedQty || 0);

  // ✅ Summary 2 + 3:
  // Imported seller products and their current seller stock in the last 30 days.
  // This uses Product records imported from wholesale.
  const importedLast30Rows = await Product.aggregate([
    {
      $match: {
        sourceType: 'wholesale_import',
        sourceSupplier: supplierObjectId,
        $expr: {
          $gte: [{ $ifNull: ['$importedAt', '$createdAt'] }, last30Start],
        },
      },
    },
    {
      $group: {
        _id: null,
        importedProductsLast30: { $sum: 1 },
        importedSellerStockLast30: { $sum: { $ifNull: ['$stock', 0] } },
      },
    },
  ]);

  const importedProductsLast30 = Number(importedLast30Rows[0]?.importedProductsLast30 || 0);
  const importedSellerStockLast30 = Number(importedLast30Rows[0]?.importedSellerStockLast30 || 0);

  // ✅ Summary 4:
  // Business growth = current 7 days imported seller stock vs previous 7 days imported seller stock.
  // If previous week was 0 and current week has stock, we show 100% growth.
  const growthRows = await Product.aggregate([
    {
      $match: {
        sourceType: 'wholesale_import',
        sourceSupplier: supplierObjectId,
        $expr: {
          $gte: [{ $ifNull: ['$importedAt', '$createdAt'] }, previous14Start],
        },
      },
    },
    {
      $project: {
        stock: { $ifNull: ['$stock', 0] },
        importedDate: { $ifNull: ['$importedAt', '$createdAt'] },
      },
    },
    {
      $group: {
        _id: null,
        current7Stock: {
          $sum: {
            $cond: [{ $gte: ['$importedDate', current7Start] }, '$stock', 0],
          },
        },
        previous7Stock: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $gte: ['$importedDate', previous14Start] },
                  { $lt: ['$importedDate', current7Start] },
                ],
              },
              '$stock',
              0,
            ],
          },
        },
      },
    },
  ]);

  const current7Stock = Number(growthRows[0]?.current7Stock || 0);
  const previous7Stock = Number(growthRows[0]?.previous7Stock || 0);

  let businessGrowthPercent = 0;

  if (previous7Stock > 0) {
    businessGrowthPercent = ((current7Stock - previous7Stock) / previous7Stock) * 100;
  } else if (previous7Stock === 0 && current7Stock > 0) {
    businessGrowthPercent = 100;
  }

  businessGrowthPercent = Number(businessGrowthPercent.toFixed(1));

  return {
    labels: keys.map(monthLabelFromKey),
    importedProducts: keys.map((key) => importedProductsMap.get(key) || 0),
    importedStock: keys.map((key) => importedStockMap.get(key) || 0),

    // Keep old name safe because the chart/footer may still read it.
    requestedQty: keys.map((key) => importedProductsMap.get(key) || 0),

    // ✅ New real 30-day footer summary.
    summary: {
      requestedQtyLast30,
      importedSellerStockLast30,
      importedProductsLast30,
      businessGrowthPercent,
      current7Stock,
      previous7Stock,
    },
  };
}

function normalizeSupplierProductForCard(product, extra = {}) {
  return {
    _id: product?._id,
    customId: product?.customId || '',
    name: product?.name || 'Wholesale Product',
    imageUrl: product?.imageUrl || '',
    category: product?.category || 'Uncategorized',
    wholesalePrice: Number(product?.wholesalePrice || 0),
    availableQuantity: Number(product?.availableQuantity || 0),
    unit: product?.unit || 'units',
    status: product?.status || 'active',

    // ✅ Generic qty field used by existing EJS cards
    qty: Number(extra.qty || 0),

    // ✅ Real selling fields for the Top Selling card
    soldQty: Number(extra.soldQty || extra.qty || 0),
    soldRevenue: Number(extra.soldRevenue || 0),
    soldOrders: Number(extra.soldOrders || 0),
    sellerProductCount: Number(extra.sellerProductCount || 0),

    // ✅ Growth fields for Fastest Growing card
    currentWeeklySold: Number(extra.currentWeeklySold || 0),
    previousWeeklySold: Number(extra.previousWeeklySold || 0),
    weeklyGrowthPercent: Number(extra.weeklyGrowthPercent || 0),

    currentMonthlySold: Number(extra.currentMonthlySold || 0),
    previousMonthlySold: Number(extra.previousMonthlySold || 0),
    monthlyGrowthPercent: Number(extra.monthlyGrowthPercent || 0),

    // Keep old names safe for older EJS code
    previousQty: Number(extra.previousQty || extra.previousWeeklySold || 0),
    growth: Number(extra.growth || extra.currentWeeklySold || 0),
  };
}

async function computeSupplierWholesaleDashboardData(supplierId) {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));

  // ✅ Supplier products only. NO Product model here.
  const products = await SupplierProduct.find({ supplier: supplierObjectId })
    .select(
      '_id customId name imageUrl category wholesalePrice availableQuantity unit status createdAt updatedAt',
    )
    .sort({ updatedAt: -1, createdAt: -1 })
    .lean();

  const activeProducts = products.filter((p) => p.status !== 'archived');

  const totalProducts = activeProducts.length;

  const totalStock = activeProducts.reduce((sum, p) => {
    return sum + (Number(p.availableQuantity) || 0);
  }, 0);

  const inStock = activeProducts.filter((p) => {
    return (Number(p.availableQuantity) || 0) > 0;
  }).length;

  const lowStockProductsRaw = activeProducts
    .filter((p) => {
      const qty = Number(p.availableQuantity) || 0;
      return qty > 0 && qty <= SUPPLIER_LOW_STOCK_THRESHOLD;
    })
    .sort((a, b) => {
      const qtyA = Number(a.availableQuantity || 0);
      const qtyB = Number(b.availableQuantity || 0);

      if (qtyA !== qtyB) return qtyA - qtyB;

      return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    });

  const lowStock = lowStockProductsRaw.length;

  const outOfStockProductsRaw = activeProducts
    .filter((p) => {
      return (Number(p.availableQuantity) || 0) <= 0;
    })
    .sort((a, b) => {
      return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    });

  const outOfStock = outOfStockProductsRaw.length;

  const inventoryValue = activeProducts.reduce((sum, p) => {
    const price = Number(p.wholesalePrice) || 0;
    const qty = Number(p.availableQuantity) || 0;
    return sum + price * qty;
  }, 0);

  // ✅ Low stock products from SupplierProduct.availableQuantity.
  // ✅ Shows the lowest 10 products, ordered by smallest available stock first.
  const supplierLowStockProducts = lowStockProductsRaw.slice(0, 10).map((p) =>
    normalizeSupplierProductForCard(p, {
      qty: Number(p.availableQuantity || 0),
    }),
  );

  // ✅ Out of stock products from SupplierProduct.availableQuantity.
  // ✅ Shows the latest 10 products with 0 stock.
  const supplierOutOfStockProducts = outOfStockProductsRaw.slice(0, 10).map((p) =>
    normalizeSupplierProductForCard(p, {
      qty: 0,
    }),
  );

  // ✅ Top selling = REAL SOLD STOCK from seller products imported from this supplier.
  // Do NOT use SupplyRequest.requestedQuantity here.
  // Flow:
  // 1. Find seller Product docs imported from this supplier.
  // 2. Match paid orders containing those imported seller products.
  // 3. Sum sold item quantities back to the original SupplierProduct.
  const importedSellerProducts = await Product.find({
    sourceType: 'wholesale_import',
    sourceSupplier: supplierObjectId,
    sourceSupplierProduct: { $ne: null },
  })
    .select(
      '_id customId name imageUrl category price stock soldCount soldOrders business sourceSupplierProduct',
    )
    .lean();

  const importedProductKeys = [
    ...new Set(
      importedSellerProducts
        .flatMap((product) => [
          String(product._id || '').trim(),
          String(product.customId || '').trim(),
        ])
        .filter(Boolean),
    ),
  ];

  const importedProductByKey = new Map();

  importedSellerProducts.forEach((product) => {
    const idKey = String(product._id || '').trim();
    const customKey = String(product.customId || '').trim();

    if (idKey) importedProductByKey.set(idKey, product);
    if (customKey) importedProductByKey.set(customKey, product);
  });

  const topSellingBySupplierProductId = new Map();

  if (importedProductKeys.length) {
    const orderItemMatch = [
      { 'items.productId': { $in: importedProductKeys } },
      { 'items.customId': { $in: importedProductKeys } },
      { 'items.pid': { $in: importedProductKeys } },
      { 'items.sku': { $in: importedProductKeys } },
    ];

    const paidOrderMatch = buildNonRefundedPaidMatch(Order, {
      $or: orderItemMatch,
    });

    const paidOrders = await Order.find(paidOrderMatch)
      .select('items createdAt status paymentStatus refundStatus isRefunded refundedAt')
      .lean();

    paidOrders.forEach((order) => {
      if (isSupplierRefundedOrder(order)) return;

      const items = Array.isArray(order.items) ? order.items : [];

      items.forEach((item) => {
        if (item?.isRefunded === true) return;
        if (
          String(item?.refundStatus || '')
            .toUpperCase()
            .includes('REFUND')
        )
          return;

        const itemKey = String(
          item?.productId || item?.customId || item?.pid || item?.sku || '',
        ).trim();

        if (!itemKey || !importedProductByKey.has(itemKey)) return;

        const importedProduct = importedProductByKey.get(itemKey);
        const supplierProductId = String(importedProduct?.sourceSupplierProduct || '').trim();

        if (!supplierProductId) return;

        const qty = Number(item?.quantity || item?.qty || 0);
        if (!Number.isFinite(qty) || qty <= 0) return;

        const unitPrice = getSupplierSoldCardUnitPrice(item) || Number(importedProduct.price || 0);
        const lineRevenue = unitPrice * qty;

        if (!topSellingBySupplierProductId.has(supplierProductId)) {
          topSellingBySupplierProductId.set(supplierProductId, {
            supplierProductId,
            soldQty: 0,
            soldRevenue: 0,
            soldOrders: 0,
            sellerProductIds: new Set(),
            orderIds: new Set(),
          });
        }

        const row = topSellingBySupplierProductId.get(supplierProductId);

        row.soldQty += qty;
        row.soldRevenue += lineRevenue;

        const importedProductId = String(importedProduct._id || '').trim();
        if (importedProductId) row.sellerProductIds.add(importedProductId);

        const orderId = String(order._id || order.orderId || '').trim();
        if (orderId) row.orderIds.add(orderId);
      });
    });
  }

  const topSellingStats = Array.from(topSellingBySupplierProductId.values())
    .map((row) => ({
      supplierProductId: row.supplierProductId,
      soldQty: Number(row.soldQty || 0),
      soldRevenue: Number(Number(row.soldRevenue || 0).toFixed(2)),
      soldOrders: row.orderIds.size,
      sellerProductCount: row.sellerProductIds.size,
    }))
    .filter((row) => row.soldQty > 0)
    .sort((a, b) => b.soldQty - a.soldQty || b.soldRevenue - a.soldRevenue)
    .slice(0, 10);

  const topProductIds = topSellingStats
    .map((row) => row.supplierProductId)
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));

  const topProductDocs = topProductIds.length
    ? await SupplierProduct.find({
        _id: { $in: topProductIds },
        supplier: supplierObjectId,
      })
        .select('_id customId name imageUrl category wholesalePrice availableQuantity unit status')
        .lean()
    : [];

  const topProductsById = new Map(topProductDocs.map((product) => [String(product._id), product]));

  const supplierTopSellingProducts = topSellingStats
    .map((row) => {
      const product = topProductsById.get(String(row.supplierProductId));
      if (!product) return null;

      return normalizeSupplierProductForCard(product, {
        qty: row.soldQty,
        soldQty: row.soldQty,
        soldRevenue: row.soldRevenue,
        soldOrders: row.soldOrders,
        sellerProductCount: row.sellerProductCount,
      });
    })
    .filter(Boolean);

  // ✅ Fastest growing = REAL SOLD STOCK from imported seller products.
  // Do NOT use SupplyRequest.requestedQuantity here.
  // Weekly Growth = current 7 days sold stock vs previous 7 days sold stock.
  // Monthly Growth = current 30 days sold stock vs previous 30 days sold stock.
  const current7Start = startOfDaysAgo(7);
  const previous7Start = startOfDaysAgo(14);

  const current30Start = startOfDaysAgo(30);
  const previous30Start = startOfDaysAgo(60);

  const calculateSoldGrowthPercent = (currentQty, previousQty) => {
    const current = Number(currentQty || 0);
    const previous = Number(previousQty || 0);

    if (previous > 0) {
      return Number((((current - previous) / previous) * 100).toFixed(1));
    }

    if (previous === 0 && current > 0) {
      return 100;
    }

    return 0;
  };

  const supplierProductsById = new Map(
    activeProducts.map((product) => [String(product._id), product]),
  );

  const fastestGrowingBySupplierProductId = new Map();

  if (importedProductKeys.length) {
    const orderItemMatch = [
      { 'items.productId': { $in: importedProductKeys } },
      { 'items.customId': { $in: importedProductKeys } },
      { 'items.pid': { $in: importedProductKeys } },
      { 'items.sku': { $in: importedProductKeys } },
    ];

    const paidOrderMatch = buildNonRefundedPaidMatch(Order, {
      createdAt: { $gte: previous30Start },
      $or: orderItemMatch,
    });

    const paidOrdersForGrowth = await Order.find(paidOrderMatch)
      .select('items createdAt status paymentStatus refundStatus isRefunded refundedAt')
      .lean();

    paidOrdersForGrowth.forEach((order) => {
      if (isSupplierRefundedOrder(order)) return;

      const orderDate = order?.createdAt ? new Date(order.createdAt) : null;
      if (!orderDate || Number.isNaN(orderDate.getTime())) return;

      const items = Array.isArray(order.items) ? order.items : [];

      items.forEach((item) => {
        if (item?.isRefunded === true) return;
        if (
          String(item?.refundStatus || '')
            .toUpperCase()
            .includes('REFUND')
        )
          return;

        const itemKey = String(
          item?.productId || item?.customId || item?.pid || item?.sku || '',
        ).trim();

        if (!itemKey || !importedProductByKey.has(itemKey)) return;

        const importedProduct = importedProductByKey.get(itemKey);
        const supplierProductId = String(importedProduct?.sourceSupplierProduct || '').trim();

        if (!supplierProductId) return;

        const qty = Number(item?.quantity || item?.qty || 0);
        if (!Number.isFinite(qty) || qty <= 0) return;

        if (!fastestGrowingBySupplierProductId.has(supplierProductId)) {
          fastestGrowingBySupplierProductId.set(supplierProductId, {
            supplierProductId,
            currentWeeklySold: 0,
            previousWeeklySold: 0,
            currentMonthlySold: 0,
            previousMonthlySold: 0,
          });
        }

        const row = fastestGrowingBySupplierProductId.get(supplierProductId);

        // ✅ Current 7 days
        if (orderDate >= current7Start) {
          row.currentWeeklySold += qty;
        }

        // ✅ Previous 7 days
        if (orderDate >= previous7Start && orderDate < current7Start) {
          row.previousWeeklySold += qty;
        }

        // ✅ Current 30 days
        if (orderDate >= current30Start) {
          row.currentMonthlySold += qty;
        }

        // ✅ Previous 30 days
        if (orderDate >= previous30Start && orderDate < current30Start) {
          row.previousMonthlySold += qty;
        }
      });
    });
  }

  const supplierFastestGrowingProducts = Array.from(fastestGrowingBySupplierProductId.values())
    .map((row) => {
      const product = supplierProductsById.get(String(row.supplierProductId));
      if (!product) return null;

      const weeklyGrowthPercent = calculateSoldGrowthPercent(
        row.currentWeeklySold,
        row.previousWeeklySold,
      );

      const monthlyGrowthPercent = calculateSoldGrowthPercent(
        row.currentMonthlySold,
        row.previousMonthlySold,
      );

      return normalizeSupplierProductForCard(product, {
        qty: row.currentWeeklySold,
        currentWeeklySold: row.currentWeeklySold,
        previousWeeklySold: row.previousWeeklySold,
        weeklyGrowthPercent,

        currentMonthlySold: row.currentMonthlySold,
        previousMonthlySold: row.previousMonthlySold,
        monthlyGrowthPercent,

        previousQty: row.previousWeeklySold,
        growth: row.currentWeeklySold - row.previousWeeklySold,
      });
    })
    .filter(Boolean)
    .filter((product) => {
      return (
        Number(product.currentWeeklySold || 0) > 0 || Number(product.currentMonthlySold || 0) > 0
      );
    })
    .sort((a, b) => {
      const weeklyA = Number(a.weeklyGrowthPercent || 0);
      const weeklyB = Number(b.weeklyGrowthPercent || 0);

      if (weeklyA !== weeklyB) return weeklyB - weeklyA;

      const currentWeeklyA = Number(a.currentWeeklySold || 0);
      const currentWeeklyB = Number(b.currentWeeklySold || 0);

      if (currentWeeklyA !== currentWeeklyB) return currentWeeklyB - currentWeeklyA;

      const monthlyA = Number(a.monthlyGrowthPercent || 0);
      const monthlyB = Number(b.monthlyGrowthPercent || 0);

      return monthlyB - monthlyA;
    })
    .slice(0, 10);

  // ✅ Supplier Performance Overview
  // This replaces the fake "Traffic & Sales" CoreUI demo section.
  // It shows real supplier request status, product health, and top requesting sellers.
  const requestStatusRows = await SupplyRequest.aggregate([
    {
      $match: {
        supplier: supplierObjectId,
      },
    },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        requestedQty: { $sum: '$requestedQuantity' },
      },
    },
  ]);

  const requestStatusSummary = {
    pending: {
      label: 'Pending',
      count: 0,
      requestedQty: 0,
      badgeClass: 'bg-warning',
      textClass: 'text-warning',
      progressClass: 'bg-warning',
    },
    approved: {
      label: 'Approved',
      count: 0,
      requestedQty: 0,
      badgeClass: 'bg-success',
      textClass: 'text-success',
      progressClass: 'bg-success',
    },
    rejected: {
      label: 'Rejected',
      count: 0,
      requestedQty: 0,
      badgeClass: 'bg-danger',
      textClass: 'text-danger',
      progressClass: 'bg-danger',
    },
    cancelled: {
      label: 'Cancelled',
      count: 0,
      requestedQty: 0,
      badgeClass: 'bg-secondary',
      textClass: 'text-body-secondary',
      progressClass: 'bg-secondary',
    },
  };

  requestStatusRows.forEach((row) => {
    const key = String(row._id || '').trim().toLowerCase();

    if (!requestStatusSummary[key]) return;

    requestStatusSummary[key].count = Number(row.count || 0);
    requestStatusSummary[key].requestedQty = Number(row.requestedQty || 0);
  });

  const requestStatusTotal = Object.values(requestStatusSummary).reduce((sum, row) => {
    return sum + Number(row.count || 0);
  }, 0);

  const topRequestingSellerRows = await SupplyRequest.aggregate([
    {
      $match: {
        supplier: supplierObjectId,
      },
    },
    {
      $group: {
        _id: '$seller',
        totalRequests: { $sum: 1 },
        totalRequestedQty: { $sum: '$requestedQuantity' },
        approvedRequests: {
          $sum: {
            $cond: [{ $eq: ['$status', 'approved'] }, 1, 0],
          },
        },
        approvedQty: {
          $sum: {
            $cond: [{ $eq: ['$status', 'approved'] }, '$requestedQuantity', 0],
          },
        },
        pendingRequests: {
          $sum: {
            $cond: [{ $eq: ['$status', 'pending'] }, 1, 0],
          },
        },
        pendingQty: {
          $sum: {
            $cond: [{ $eq: ['$status', 'pending'] }, '$requestedQuantity', 0],
          },
        },
        rejectedRequests: {
          $sum: {
            $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0],
          },
        },
        lastRequestAt: { $max: '$createdAt' },
      },
    },
    {
      $sort: {
        approvedQty: -1,
        totalRequestedQty: -1,
        totalRequests: -1,
        lastRequestAt: -1,
      },
    },
    { $limit: 5 },
  ]);

  const topSellerIds = topRequestingSellerRows.map((row) => row._id).filter(Boolean);

  const topSellerDocs = topSellerIds.length
    ? await Business.find({ _id: { $in: topSellerIds } })
        .select('_id name email role logoUrl')
        .lean()
    : [];

  const topSellerById = new Map(
    topSellerDocs.map((seller) => [String(seller._id), seller]),
  );

  const topRequestingSellers = topRequestingSellerRows.map((row, index) => {
    const seller = topSellerById.get(String(row._id)) || {};

    return {
      rank: index + 1,
      sellerId: String(row._id || ''),
      sellerName: seller.name || 'Seller account',
      sellerEmail: seller.email || '',
      sellerRole: seller.role || 'seller',
      totalRequests: Number(row.totalRequests || 0),
      totalRequestedQty: Number(row.totalRequestedQty || 0),
      approvedRequests: Number(row.approvedRequests || 0),
      approvedQty: Number(row.approvedQty || 0),
      pendingRequests: Number(row.pendingRequests || 0),
      pendingQty: Number(row.pendingQty || 0),
      rejectedRequests: Number(row.rejectedRequests || 0),
      lastRequestAt: row.lastRequestAt || null,
    };
  });

  const productHealthSummary = {
    totalProducts: products.length,
    activeProducts: activeProducts.length,
    draftProducts: products.filter((product) => product.status === 'draft').length,
    pausedProducts: products.filter((product) => product.status === 'paused').length,
    archivedProducts: products.filter((product) => product.status === 'archived').length,
    inStock,
    lowStock,
    outOfStock,
    totalStock,
    inventoryValue,
  };

  const supplierPerformanceOverview = {
    requestStatusSummary,
    requestStatusTotal,
    productHealthSummary,
    topRequestingSellers,
  };

  // ✅ Seller Location Interest
  // This shows where sellers are located when they import this supplier's products.
  // Data source:
  // - Product.sourceType = wholesale_import
  // - Product.sourceSupplier = this supplier
  // - Product.business = seller business
  // - Business.country / Business.state / Business.city
  const sellerLocationIds = [
    ...new Set(
      importedSellerProducts
        .map((product) => String(product.business || '').trim())
        .filter((id) => mongoose.isValidObjectId(id)),
    ),
  ].map((id) => new mongoose.Types.ObjectId(id));

  const sellerLocationDocs = sellerLocationIds.length
    ? await Business.find({ _id: { $in: sellerLocationIds } })
        .select('_id name email country countryCode state city')
        .lean()
    : [];

  const sellerLocationById = new Map(
    sellerLocationDocs.map((seller) => [String(seller._id), seller]),
  );

  function cleanLocationValue(value, fallback = 'Not specified') {
    const cleaned = String(value || '').trim();
    return cleaned || fallback;
  }

  function buildLocationRanking(locationKey) {
    const rowsByLocation = new Map();

    importedSellerProducts.forEach((product) => {
      const sellerId = String(product.business || '').trim();
      const seller = sellerLocationById.get(sellerId);

      if (!seller) return;

      const locationName = cleanLocationValue(seller[locationKey]);

      if (!rowsByLocation.has(locationName)) {
        rowsByLocation.set(locationName, {
          name: locationName,
          importedProducts: 0,
          importedStock: 0,
          sellerIds: new Set(),
          lastImportedAt: null,
        });
      }

      const row = rowsByLocation.get(locationName);

      const currentStock = Number(product.stock || 0);
      const soldStock = Number(product.soldCount || 0);
      const estimatedImportedStock = currentStock + soldStock;

      row.importedProducts += 1;
      row.importedStock += Number.isFinite(estimatedImportedStock) ? estimatedImportedStock : currentStock;
      row.sellerIds.add(sellerId);

      const importedDate = product.importedAt || product.createdAt || product.updatedAt || null;
      if (importedDate) {
        const date = new Date(importedDate);
        if (!Number.isNaN(date.getTime())) {
          if (!row.lastImportedAt || date > new Date(row.lastImportedAt)) {
            row.lastImportedAt = date;
          }
        }
      }
    });

    return Array.from(rowsByLocation.values())
      .map((row) => ({
        name: row.name,
        importedProducts: Number(row.importedProducts || 0),
        importedStock: Number(row.importedStock || 0),
        sellerCount: row.sellerIds.size,
        lastImportedAt: row.lastImportedAt,
      }))
      .sort((a, b) => {
        if (Number(b.importedStock || 0) !== Number(a.importedStock || 0)) {
          return Number(b.importedStock || 0) - Number(a.importedStock || 0);
        }

        if (Number(b.importedProducts || 0) !== Number(a.importedProducts || 0)) {
          return Number(b.importedProducts || 0) - Number(a.importedProducts || 0);
        }

        return Number(b.sellerCount || 0) - Number(a.sellerCount || 0);
      })
      .slice(0, 10);
  }

  const supplierLocationInterest = {
    countries: buildLocationRanking('country'),
    provinces: buildLocationRanking('state'),
    cities: buildLocationRanking('city'),
  };  

  return {
    products: activeProducts,

    totals: {
      totalProducts,
      totalStock,
      inStock,
      lowStock,
      outOfStock,
    },

    inventoryValue,

    supplierTopSellingProducts,
    supplierLowStockProducts,
    supplierOutOfStockProducts,
    supplierFastestGrowingProducts,

    // ✅ Real replacement for the fake Traffic & Sales section
    supplierPerformanceOverview,

    // ✅ Last section above footer: where sellers are importing from
    supplierLocationInterest,
  };
}

function getSupplierSoldCardOrderItemKey(item) {
  return String(item?.productId || item?.customId || item?.pid || item?.sku || '').trim();
}

function getSupplierSoldCardOrderItemQty(item) {
  const qty = Number(item?.quantity || item?.qty || 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function getSupplierSoldCardMoneyValue(value) {
  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'object') {
    return getSupplierSoldCardMoneyValue(value.value ?? value.amount ?? value.price ?? 0);
  }

  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : 0;
}

function getSupplierSoldCardUnitPrice(item) {
  return getSupplierSoldCardMoneyValue(
    item?.priceGross?.value ?? item?.price?.value ?? item?.price ?? item?.unitPrice ?? 0,
  );
}

async function buildSupplierSoldCardData(supplierId) {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));

  const importedSellerProducts = await Product.find({
    sourceType: 'wholesale_import',
    sourceSupplier: supplierObjectId,
  })
    .select('_id customId name price sourceSupplier sourceSupplierProduct sourceSupplyRequest')
    .lean();

  const importedProductKeys = [
    ...new Set(
      importedSellerProducts
        .flatMap((product) => [
          String(product._id || '').trim(),
          String(product.customId || '').trim(),
        ])
        .filter(Boolean),
    ),
  ];

  const productByKey = new Map();

  importedSellerProducts.forEach((product) => {
    const idKey = String(product._id || '').trim();
    const customKey = String(product.customId || '').trim();

    if (idKey) productByKey.set(idKey, product);
    if (customKey) productByKey.set(customKey, product);
  });

  const emptyLabels = [];
  const emptyData = [];

  const soldStart = new Date();
  soldStart.setDate(soldStart.getDate() - 6);
  soldStart.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(soldStart);
    d.setDate(soldStart.getDate() + i);

    emptyLabels.push(
      d.toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );

    emptyData.push(0);
  }

  if (!importedProductKeys.length) {
    return {
      totalSoldStock: 0,
      totalSalesRevenue: 0,
      chart: {
        labels: emptyLabels,
        data: emptyData,
      },
    };
  }

  const orderItemMatch = [
    { 'items.productId': { $in: importedProductKeys } },
    { 'items.customId': { $in: importedProductKeys } },
    { 'items.pid': { $in: importedProductKeys } },
    { 'items.sku': { $in: importedProductKeys } },
  ];

  const paidOrderMatch = buildNonRefundedPaidMatch(Order, {
    $or: orderItemMatch,
  });

  const paidOrders = await Order.find(paidOrderMatch)
    .select('items createdAt status paymentStatus refundStatus isRefunded refundedAt')
    .lean();

  let totalSoldStock = 0;
  let totalSalesRevenue = 0;

  const soldMovementMap = new Map();

  paidOrders.forEach((order) => {
    const items = Array.isArray(order.items) ? order.items : [];
    const orderDate = order.createdAt ? new Date(order.createdAt) : null;
    const orderDayKey =
      orderDate && orderDate >= soldStart ? orderDate.toISOString().slice(0, 10) : '';

    items.forEach((item) => {
      if (item?.isRefunded === true) return;
      if (
        String(item?.refundStatus || '')
          .toUpperCase()
          .includes('REFUND')
      )
        return;

      const itemKey = getSupplierSoldCardOrderItemKey(item);
      if (!itemKey || !productByKey.has(itemKey)) return;

      const qty = getSupplierSoldCardOrderItemQty(item);
      if (qty <= 0) return;

      const importedProduct = productByKey.get(itemKey) || {};
      const unitPrice =
        getSupplierSoldCardUnitPrice(item) || Number(importedProduct.price || 0) || 0;

      totalSoldStock += qty;
      totalSalesRevenue += unitPrice * qty;

      if (orderDayKey) {
        soldMovementMap.set(orderDayKey, (soldMovementMap.get(orderDayKey) || 0) + qty);
      }
    });
  });

  const labels = [];
  const data = [];

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(soldStart);
    d.setDate(soldStart.getDate() + i);

    const key = d.toISOString().slice(0, 10);

    labels.push(
      d.toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );

    data.push(soldMovementMap.get(key) || 0);
  }

  return {
    totalSoldStock,
    totalSalesRevenue: Number(totalSalesRevenue.toFixed(2)),
    chart: {
      labels,
      data,
    },
  };
}

function centsToAmount(cents) {
  const n = Number(cents || 0);
  return Number.isFinite(n) ? Number((n / 100).toFixed(2)) : 0;
}

function supplierPayoutDayKey(date) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10);
}

async function buildSupplierPayoutCardData(supplierId) {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));
  const currency = BASE_CURRENCY;

  const eligibleCents = await getSellerAvailableCents(supplierObjectId, currency);

  const paidStart = new Date();
  paidStart.setDate(paidStart.getDate() - 6);
  paidStart.setHours(0, 0, 0, 0);

  const labels = [];
  const emptyData = [];

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(paidStart);
    d.setDate(paidStart.getDate() + i);

    labels.push(
      d.toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );

    emptyData.push(0);
  }

  const latestRows = await Payout.aggregate([
    {
      $match: {
        currency,
        items: {
          $elemMatch: {
            businessId: supplierObjectId,
            status: 'SENT',
          },
        },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.businessId': supplierObjectId,
        'items.status': 'SENT',
        'items.currency': currency,
      },
    },
    { $sort: { 'items.paidAt': -1, updatedAt: -1, createdAt: -1 } },
    { $limit: 1 },
    {
      $project: {
        _id: 0,
        amountCents: '$items.amountCents',
        paidAt: '$items.paidAt',
        receiver: '$items.receiver',
        status: '$items.status',
      },
    },
  ]);

  const latestPaid = latestRows[0] || null;

  const movementRows = await Payout.aggregate([
    {
      $match: {
        currency,
        items: {
          $elemMatch: {
            businessId: supplierObjectId,
            status: 'SENT',
            paidAt: { $gte: paidStart },
          },
        },
      },
    },
    { $unwind: '$items' },
    {
      $match: {
        'items.businessId': supplierObjectId,
        'items.status': 'SENT',
        'items.currency': currency,
        'items.paidAt': { $gte: paidStart },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$items.paidAt',
          },
        },
        totalCents: { $sum: '$items.amountCents' },
      },
    },
  ]);

  const movementMap = new Map(
    movementRows.map((row) => [String(row._id), centsToAmount(row.totalCents)]),
  );

  const data = [];

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(paidStart);
    d.setDate(paidStart.getDate() + i);

    const key = supplierPayoutDayKey(d);
    data.push(movementMap.get(key) || 0);
  }

  return {
    eligiblePayoutAmount: centsToAmount(eligibleCents),
    latestPaidAmount: centsToAmount(latestPaid?.amountCents || 0),
    latestPaidAt: latestPaid?.paidAt || null,
    currency,
    chart: {
      labels,
      data: data.length ? data : emptyData,
    },
  };
}

function isSupplierRefundedOrder(order) {
  const status = String(order?.status || '')
    .trim()
    .toUpperCase();
  const paymentStatus = String(order?.paymentStatus || '')
    .trim()
    .toLowerCase();

  const refundedTotal = Number(order?.refundedTotal || 0);
  const refunds = Array.isArray(order?.refunds) ? order.refunds : [];

  return (
    status === 'REFUNDED' ||
    status === 'PARTIALLY_REFUNDED' ||
    paymentStatus === 'refunded' ||
    paymentStatus === 'partially_refunded' ||
    refunds.length > 0 ||
    refundedTotal > 0 ||
    Boolean(order?.refundedAt)
  );
}

function getSupplierRefundOrderDate(order) {
  if (order?.refundedAt) return new Date(order.refundedAt);

  const refunds = Array.isArray(order?.refunds) ? order.refunds : [];
  const refundDates = refunds
    .map((refund) => (refund?.createdAt ? new Date(refund.createdAt) : null))
    .filter((date) => date && !Number.isNaN(date.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  if (refundDates.length) return refundDates[0];

  if (order?.updatedAt) return new Date(order.updatedAt);
  if (order?.createdAt) return new Date(order.createdAt);

  return new Date();
}

async function buildSupplierRefundCardData(supplierId) {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));

  const importedSellerProducts = await Product.find({
    sourceType: 'wholesale_import',
    sourceSupplier: supplierObjectId,
  })
    .select('_id customId name sourceSupplier sourceSupplierProduct sourceSupplyRequest')
    .lean();

  const importedProductKeys = [
    ...new Set(
      importedSellerProducts
        .flatMap((product) => [
          String(product._id || '').trim(),
          String(product.customId || '').trim(),
        ])
        .filter(Boolean),
    ),
  ];

  const productByKey = new Map();

  importedSellerProducts.forEach((product) => {
    const idKey = String(product._id || '').trim();
    const customKey = String(product.customId || '').trim();

    if (idKey) productByKey.set(idKey, product);
    if (customKey) productByKey.set(customKey, product);
  });

  const refundStart = new Date();
  refundStart.setDate(refundStart.getDate() - 6);
  refundStart.setHours(0, 0, 0, 0);

  const labels = [];
  const emptyData = [];

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(refundStart);
    d.setDate(refundStart.getDate() + i);

    labels.push(
      d.toLocaleDateString(undefined, {
        weekday: 'short',
      }),
    );

    emptyData.push(0);
  }

  if (!importedProductKeys.length) {
    return {
      totalRefundedOrders: 0,
      totalRefundedProducts: 0,
      totalRefundedStock: 0,
      chart: {
        labels,
        data: emptyData,
      },
    };
  }

  const orderItemMatch = [
    { 'items.productId': { $in: importedProductKeys } },
    { 'items.customId': { $in: importedProductKeys } },
    { 'items.pid': { $in: importedProductKeys } },
    { 'items.sku': { $in: importedProductKeys } },
  ];

  const refundedOrderMatch = {
    $and: [
      { $or: orderItemMatch },
      {
        $or: [
          { 'items.refundStatus': { $in: ['PARTIAL', 'REFUNDED'] } },
          { 'items.refundedQuantity': { $gt: 0 } },
          { status: { $in: ['REFUNDED', 'PARTIALLY_REFUNDED', 'Refunded', 'Partially Refunded'] } },
          {
            paymentStatus: {
              $in: ['refunded', 'partially_refunded', 'REFUNDED', 'PARTIALLY_REFUNDED'],
            },
          },
          { refunds: { $exists: true, $ne: [] } },
          { refundedAt: { $exists: true, $ne: null } },
          { refundedTotal: { $nin: ['0', '0.00', '', null] } },
        ],
      },
    ],
  };

  const refundedOrders = await Order.find(refundedOrderMatch)
    .select('items status paymentStatus refunds refundedTotal refundedAt createdAt updatedAt')
    .lean();

  let totalRefundedOrders = 0;
  let totalRefundedProducts = 0;
  let totalRefundedStock = 0;

  const refundedMovementMap = new Map();

  refundedOrders.forEach((order) => {
    if (!isSupplierRefundedOrder(order)) return;

    const items = Array.isArray(order.items) ? order.items : [];

    let orderHasSupplierRefundItem = false;
    let supplierRefundQtyForOrder = 0;
    let supplierExactItemRefundFound = false;
    let latestItemRefundDate = null;

    items.forEach((item) => {
      const itemKey = getSupplierSoldCardOrderItemKey(item);
      if (!itemKey || !productByKey.has(itemKey)) return;

      const originalQty = getSupplierSoldCardOrderItemQty(item);
      if (originalQty <= 0) return;

      const itemRefundStatus = String(item?.refundStatus || 'NONE')
        .trim()
        .toUpperCase();
      const itemRefundedQty = Number(item?.refundedQuantity || 0);

      // ✅ Best case: new item-level fields exist.
      if (
        itemRefundStatus === 'REFUNDED' ||
        itemRefundStatus === 'PARTIAL' ||
        itemRefundedQty > 0 ||
        item?.refundedAt
      ) {
        const safeRefundedQty = Math.min(
          originalQty,
          Math.max(0, Number.isFinite(itemRefundedQty) ? itemRefundedQty : 0),
        );

        const qtyToCount =
          safeRefundedQty > 0 ? safeRefundedQty : itemRefundStatus === 'REFUNDED' ? originalQty : 0;

        if (qtyToCount > 0) {
          supplierExactItemRefundFound = true;
          orderHasSupplierRefundItem = true;
          supplierRefundQtyForOrder += qtyToCount;

          if (item?.refundedAt) {
            const d = new Date(item.refundedAt);
            if (!Number.isNaN(d.getTime())) {
              if (!latestItemRefundDate || d > latestItemRefundDate) {
                latestItemRefundDate = d;
              }
            }
          }
        }

        return;
      }

      // ✅ Fallback for old orders:
      // If order is refunded but old items have no item refund fields,
      // count the supplier imported product quantity inside that refunded order.
      orderHasSupplierRefundItem = true;
      supplierRefundQtyForOrder += originalQty;
    });

    if (!orderHasSupplierRefundItem || supplierRefundQtyForOrder <= 0) return;

    totalRefundedOrders += 1;
    totalRefundedProducts += supplierRefundQtyForOrder;
    totalRefundedStock += supplierRefundQtyForOrder;

    const refundDate =
      supplierExactItemRefundFound && latestItemRefundDate
        ? latestItemRefundDate
        : getSupplierRefundOrderDate(order);

    const refundDayKey =
      refundDate && refundDate >= refundStart ? refundDate.toISOString().slice(0, 10) : '';

    if (refundDayKey) {
      refundedMovementMap.set(
        refundDayKey,
        (refundedMovementMap.get(refundDayKey) || 0) + supplierRefundQtyForOrder,
      );
    }
  });

  const data = [];

  for (let i = 0; i < 7; i += 1) {
    const d = new Date(refundStart);
    d.setDate(refundStart.getDate() + i);

    const key = d.toISOString().slice(0, 10);
    data.push(refundedMovementMap.get(key) || 0);
  }

  return {
    totalRefundedOrders,
    totalRefundedProducts,
    totalRefundedStock,
    chart: {
      labels,
      data,
    },
  };
}

// -------------------------------------------------------
// ✅ Helper: exclude refunded / cancelled orders everywhere
// ✅ Keep this because seller KPI + analytics still use it
// -------------------------------------------------------
function buildNonRefundedPaidMatch(OrderModel, extra = {}) {
  const RAW_PAID = Array.isArray(OrderModel?.PAID_STATES)
    ? OrderModel.PAID_STATES
    : ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];

  const PAID_STATES = Array.from(
    new Set(
      RAW_PAID.flatMap((s) => {
        const v = String(s || '').trim();
        if (!v) return [];

        const lower = v.toLowerCase();
        const title = lower.charAt(0).toUpperCase() + lower.slice(1);

        return [v, v.toUpperCase(), v.toLowerCase(), title];
      }),
    ),
  );

  const CANCEL_STATES = ['Cancelled', 'Canceled', 'CANCELLED', 'CANCELED', 'VOIDED', 'Voided'];

  const REFUND_STATES = [
    'Refunded',
    'REFUNDED',
    'PARTIALLY_REFUNDED',
    'Partially Refunded',
    'REFUND_SUBMITTED',
  ];

  const REFUND_PAYMENT_STATUSES = [
    'refunded',
    'partially_refunded',
    'refund_submitted',
    'refund_pending',
  ];

  const base = {
    status: { $in: PAID_STATES },

    $and: [
      { status: { $nin: [...CANCEL_STATES, ...REFUND_STATES] } },
      { paymentStatus: { $nin: REFUND_PAYMENT_STATUSES } },

      { isRefunded: { $ne: true } },
      { refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED', 'COMPLETED'] } },

      {
        $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }],
      },
    ],
  };

  const extraAnd = Array.isArray(extra.$and) ? extra.$and : [];
  const rest = { ...(extra || {}) };
  delete rest.$and;

  return {
    ...base,
    ...rest,
    $and: [...base.$and, ...extraAnd],
  };
}

// -------------------------------------------------------
// Helper: resolve base URL (Render-safe)
// -------------------------------------------------------
function resolveBaseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '');
  if (env) return env;

  // fallback to current request host
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  return `${proto}://${req.get('host')}`;
}

function getBiz(req) {
  // prefer DB-trusted object set by requireBusiness
  return req.business || req.session?.business || null;
}

function getBizId(req) {
  const b = getBiz(req);
  return b?._id ? String(b._id) : '';
}

// -------------------------------------------------------
// Helper: send business verification email (USES sendMail)
// -------------------------------------------------------
async function sendBusinessVerificationEmail(business, token, req) {
  const baseUrl = resolveBaseUrl(req);
  const verifyUrl = `${baseUrl}/business/verify-email/${encodeURIComponent(token)}`;

  const to = business.email;
  const subject = '✅ Verify your business email - Unicoporate';

  const text = [
    `Hi ${escapeHtml(business.name || 'there')},`,
    '',
    'Please verify your business email to activate your dashboard:',
    verifyUrl,
    '',
    'This link expires in 24 hours.',
    'If you did not create this account, you can ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0F172A;line-height:1.55">
      <h2 style="margin:0 0 8px;color:#7C3AED">Verify your email</h2>
      <p>Hi <strong>${escapeHtml(business.name || 'there')}</strong>,</p>
      <p>Please verify your business email to activate your dashboard.</p>
      <p style="margin:16px 0;">
        <a href="${verifyUrl}"
           style="display:inline-block;padding:12px 16px;background:#2563EB;color:#ffffff;
                  text-decoration:none;border-radius:10px;font-weight:800;font-size:14px;">
          Verify my email →
        </a>
      </p>
      <p style="font-size:12px;color:#64748B">
        Or copy and paste this link:<br/>
        <span style="word-break:break-all">${verifyUrl}</span>
      </p>
      <p style="font-size:12px;color:#64748B">This link expires in 24 hours.</p>
    </div>
  `;

  return sendMail({
    to,
    subject,
    text,
    html,
    replyTo: process.env.SUPPORT_INBOX || undefined,
  });
}

// -------------------------------------------------------
// Helper: send business reset password email (WORKING)
// -------------------------------------------------------
async function sendBusinessResetEmail(business, token, req) {
  const baseUrl = resolveBaseUrl(req);
  const resetUrl = `${baseUrl}/business/password/reset/${encodeURIComponent(token)}`;

  const to = business.email;
  const subject = 'Reset your business password';

  const text = [
    `Hi ${escapeHtml(business.name || 'there')},`,
    '',
    'We received a request to reset the password for your business account.',
    'If you made this request, open the link below to set a new password:',
    resetUrl,
    '',
    'This link will expire in 1 hour.',
    'If you did not request a password reset, you can safely ignore this email.',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;color:#0F172A;line-height:1.55">
      <h2 style="margin:0 0 8px;color:#7C3AED">Reset your business password</h2>
      <p>Hi <strong>${escapeHtml(business.name || 'there')}</strong>,</p>
      <p>We received a request to reset the password for your business account.</p>
      <p style="margin:16px 0;">
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 16px;background:#2563EB;color:#ffffff;
                  text-decoration:none;border-radius:10px;font-weight:800;font-size:14px;">
          Reset my password →
        </a>
      </p>
      <p style="font-size:12px;color:#64748B">
        Or copy and paste this link into your browser:<br/>
        <span style="word-break:break-all">${resetUrl}</span>
      </p>
      <p style="font-size:12px;color:#64748B">
        This link will expire in 1 hour. If you did not request this, you can ignore this email.
      </p>
    </div>
  `;

  // ✅ ALWAYS send via your central mailer
  return sendMail({
    to,
    subject,
    text,
    html,
    replyTo: process.env.SUPPORT_INBOX || undefined,
  });
}

// Mask email like p*****i@o*****.com
function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return email;

  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];

  const parts = domain.split('.');
  const domName = parts[0] || '';
  const domRest = parts.slice(1).join('.') || '';

  const maskedDomain =
    domName.length <= 2
      ? (domName[0] || '*') + '*'
      : domName[0] + '*'.repeat(Math.max(1, domName.length - 2)) + domName[domName.length - 1];

  return `${maskedName}@${maskedDomain}${domRest ? '.' + domRest : ''}`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// -------------------------------------------------------
// Helper: computeSupplierKpis (used by supplier + seller)
// ✅ EXCLUDES refunded/cancelled orders AND refunded items
// ✅ Uses buildNonRefundedPaidMatch(OrderModel, extra) (must exist ONCE above)
// -------------------------------------------------------
async function computeSupplierKpis(businessId) {
  // 1) Load products for this business (supplier/seller)
  const products = await Product.find({ business: businessId })
    .select('stock customId price soldCount name category imageUrl _id')
    .lean();

  const totalProducts = products.length;
  const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
  const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
  const lowStock = products.filter((p) => {
    const s = Number(p.stock) || 0;
    return s > 0 && s <= LOW_STOCK_THRESHOLD;
  }).length;
  const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

  let soldLast30 = 0;
  let revenueLast30 = 0;

  const perProductMap = new Map();

  // Build a quick lookup for product details (avoid products.find in a loop)
  const productIdSet = new Set();
  const productsByKey = new Map();

  for (const p of products) {
    if (p.customId) {
      const k = String(p.customId).trim();
      if (k) {
        productIdSet.add(k);
        productsByKey.set(k, p);
      }
    }
    // also allow matching by _id if your order items store ObjectId strings
    const oid = String(p._id || '').trim();
    if (oid) {
      productIdSet.add(oid);
      productsByKey.set(oid, p);
    }
  }

  const supplierIds = Array.from(productIdSet);

  // Prefer using Order docs for last 30 days
  if (Order && supplierIds.length) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const idMatchOr = [
      { 'items.productId': { $in: supplierIds } },
      { 'items.customId': { $in: supplierIds } },
      { 'items.pid': { $in: supplierIds } },
      { 'items.sku': { $in: supplierIds } },
    ];

    // ✅ Exclude refunded/cancelled orders using the shared helper
    const match = buildNonRefundedPaidMatch(Order, {
      createdAt: { $gte: since },
      $or: idMatchOr,
    });

    const recentOrders = await Order.find(match)
      .select('items amount total createdAt status refundStatus isRefunded refundedAt')
      .lean();

    // Money helpers (handles MoneySchema or number/string)
    const moneyToNumber = (m) => {
      if (!m) return 0;
      if (typeof m === 'number') return m;
      if (typeof m === 'string') return Number(m) || 0;
      if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
      return 0;
    };

    for (const o of recentOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      if (!items.length) continue;

      // ✅ Add revenue ONLY for this business's items that are NOT refunded
      for (const it of items) {
        // ✅ item-level refund skip (safe even if your schema doesn't have these fields)
        if (it && it.isRefunded === true) continue;
        if (String(it?.refundStatus || '').toUpperCase() === 'REFUNDED') continue;

        const pid = String(it.productId ?? it.customId ?? it.pid ?? it.sku ?? '').trim();
        if (!pid) continue;
        if (!productIdSet.has(pid)) continue;

        const qty = Number(it.quantity || 1);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const prod = productsByKey.get(pid) || {};
        const unitPrice = Number(prod.price || moneyToNumber(it.price) || 0);
        const lineRevenue = unitPrice * qty;

        soldLast30 += qty;
        revenueLast30 += lineRevenue;

        if (!perProductMap.has(pid)) {
          perProductMap.set(pid, {
            productId: pid,
            name: prod.name || it.name || '(unknown)',
            imageUrl: prod.imageUrl || '',
            category: prod.category || '',
            price: unitPrice,
            qty: 0,
            estRevenue: 0,
          });
        }

        const stat = perProductMap.get(pid);
        stat.qty += qty;
        stat.estRevenue += lineRevenue;
      }
    }
  }

  // Fallback: lifetime counters on Product (soldCount)
  // NOTE: This cannot perfectly exclude refunds because Product.soldCount is lifetime.
  // Use it only when there are NO recent paid orders at all.
  if (soldLast30 === 0 && revenueLast30 === 0) {
    for (const p of products) {
      const qty = Number(p.soldCount || 0);
      if (!qty) continue;

      const price = Number(p.price || 0);
      soldLast30 += qty;
      revenueLast30 += qty * price;

      const pid = p.customId ? String(p.customId).trim() : String(p._id || '').trim();
      if (!pid) continue;

      const existing = perProductMap.get(pid) || {
        productId: pid,
        name: p.name || '(unknown)',
        imageUrl: p.imageUrl || '',
        category: p.category || '',
        price,
        qty: 0,
        estRevenue: 0,
      };

      existing.qty += qty;
      existing.estRevenue += qty * price;
      perProductMap.set(pid, existing);
    }
  }

  const perProduct = Array.from(perProductMap.values()).sort((a, b) => b.qty - a.qty);

  const perProductTotalQty = perProduct.reduce((sum, p) => sum + (Number(p.qty) || 0), 0);
  const perProductEstRevenue = perProduct.reduce((sum, p) => sum + (Number(p.estRevenue) || 0), 0);

  return {
    totalProducts,
    totalStock,
    inStock,
    lowStock,
    outOfStock,
    soldLast30,
    revenueLast30: Number(Number(revenueLast30 || 0).toFixed(2)),
    perProduct,
    perProductTotalQty,
    perProductEstRevenue: Number(perProductEstRevenue.toFixed(2)),
  };
}

router.get('/signup', redirectIfLoggedIn, async (req, res) => {
  let shopHeaderImage = null;

  try {
    const ShopHeaderImage = require('../models/ShopHeaderImage');

    shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();

    const businessesCount = await Business.countDocuments({});

    const countriesAgg = await Business.aggregate([
      {
        $project: {
          country: {
            $trim: { input: { $ifNull: ['$country', ''] } },
          },
        },
      },
      { $match: { country: { $ne: '' } } },
      { $group: { _id: { $toLower: '$country' } } },
      { $count: 'total' },
    ]);

    const countriesCount = countriesAgg[0]?.total || 0;

    res.render('business-signup', {
      title: 'Business Sign Up',
      active: 'business-signup',
      errors: [],
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      businessesCount,
      countriesCount,
      shopHeaderImage,
    });
  } catch (err) {
    console.error('❌ GET /business/signup stats error:', err);

    res.render('business-signup', {
      title: 'Business Sign Up',
      active: 'business-signup',
      errors: [],
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      businessesCount: 0,
      countriesCount: 0,
      shopHeaderImage,
    });
  }
});

/* ----------------------------------------------------------
 * 📬 Verify Pending Page
 * -------------------------------------------------------- */
router.get('/verify-pending', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified) {
      return res.redirect('/business/dashboard');
    }

    res.render('business-verify-pending', {
      title: 'Verify your email',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ verify-pending error:', err);
    req.flash('error', 'Failed to load verification page.');
    res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * 🔁 Resend verification email (POST)
 * -------------------------------------------------------- */
router.post('/verify/resend', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId);
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (business.isVerified) {
      req.flash('success', 'Your email is already verified.');
      return res.redirect('/business/dashboard');
    }

    // ✅ 60s cooldown (prevents spam + “refuse” confusion)
    const lastSent = business.verificationEmailSentAt
      ? new Date(business.verificationEmailSentAt).getTime()
      : 0;
    const now = Date.now();
    const cooldownMs = 60 * 1000;

    if (lastSent && now - lastSent < cooldownMs) {
      const secs = Math.ceil((cooldownMs - (now - lastSent)) / 1000);
      req.flash('warning', `Please wait ${secs}s before resending another verification email.`);
      return res.redirect('/business/verify-pending');
    }

    const token = crypto.randomBytes(32).toString('hex');
    business.emailVerificationToken = token;
    business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    business.verificationEmailSentAt = new Date();
    await business.save();

    try {
      await sendBusinessVerificationEmail(business, token, req);
      req.flash('success', `A new verification link was sent to ${business.email}.`);
    } catch (mailErr) {
      console.error(
        '❌ Resend verification email failed:',
        mailErr?.response?.body || mailErr?.message || mailErr,
      );
      req.flash('error', 'Could not send verification email. Please try again later.');
    }

    return res.redirect('/business/verify-pending');
  } catch (err) {
    console.error('❌ verify/resend error:', err);
    req.flash('error', 'Failed to resend verification email.');
    return res.redirect('/business/verify-pending');
  }
});

/* ----------------------------------------------------------
 * ✅ Verify email link  /business/verify-email/:token
 * -------------------------------------------------------- */
router.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;
    if (!token) {
      req.flash('error', 'Invalid verification link.');
      return res.redirect('/business/login');
    }

    const business = await Business.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() },
    });

    if (!business) {
      req.flash(
        'error',
        'This verification link is invalid or has expired. Please log in and request a new one.',
      );
      return res.redirect('/business/login');
    }

    business.isVerified = true;
    business.emailVerifiedAt = new Date();
    business.emailVerificationToken = undefined;
    business.emailVerificationExpires = undefined;
    await business.save();

    if (req.session && req.session.business) {
      req.session.business.isVerified = true;
    } else {
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: true,
      };
    }

    req.flash('success', '✅ Your email has been verified. Welcome to your dashboard.');
    return res.redirect('/business/dashboard');
  } catch (err) {
    console.error('❌ verify-email error:', err);
    req.flash('error', 'Failed to verify email. Please try again.');
    res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * ✉️ GET: Change email page
 * -------------------------------------------------------- */
router.get('/change-email', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // If already verified, you can decide what you want.
    // For now: still allow change email (useful if they want to switch).
    return res.render('business-change-email', {
      title: 'Change Email',
      active: 'business-change-email',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ change-email GET error:', err);
    req.flash('error', 'Could not open change email page.');
    return res.redirect('/business/verify-pending');
  }
});

/* ----------------------------------------------------------
 * ✉️ POST: Change email + resend verification
 * -------------------------------------------------------- */
router.post(
  '/change-email',
  requireBusiness,
  [
    body('newEmail').isEmail().withMessage('Please enter a valid email address.'),
    body('password').notEmpty().withMessage('Password is required.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/business/change-email');
    }

    try {
      const bizId = req.session.business?._id;
      const newEmail = String(req.body.newEmail || '')
        .trim()
        .toLowerCase();
      const password = String(req.body.password || '');

      const business = await Business.findById(bizId);
      if (!business) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      // ✅ Check password
      const ok = await bcrypt.compare(password, business.password);
      if (!ok) {
        req.flash('error', 'Incorrect password.');
        return res.redirect('/business/change-email');
      }

      // ✅ No change?
      const currentEmail = String(business.email || '')
        .trim()
        .toLowerCase();
      if (newEmail === currentEmail) {
        req.flash('info', 'That is already your current email.');
        return res.redirect('/business/change-email');
      }

      // ✅ Make sure email isn't taken by another business
      const exists = await Business.findOne({ email: newEmail, _id: { $ne: business._id } }).lean();
      if (exists) {
        req.flash('error', 'That email is already used by another business account.');
        return res.redirect('/business/change-email');
      }

      // ✅ Update email + force re-verify
      const token = crypto.randomBytes(32).toString('hex');
      business.email = newEmail;
      business.isVerified = false;
      business.emailVerificationToken = token;
      business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
      business.verificationEmailSentAt = new Date();
      await business.save();

      // ✅ keep session in sync
      if (!req.session.business) req.session.business = {};
      req.session.business.email = business.email;
      req.session.business.isVerified = false;

      // ✅ send verification to the NEW email
      try {
        await sendBusinessVerificationEmail(business, token, req);
        req.flash(
          'success',
          `Verification email sent to ${business.email}. Please check your inbox.`,
        );
      } catch (mailErr) {
        console.error('❌ Change-email send failed:', mailErr);
        req.flash(
          'error',
          'Email updated, but we could not send the verification email. Try Resend.',
        );
      }

      return res.redirect('/business/verify-pending');
    } catch (err) {
      console.error('❌ change-email POST error:', err);
      req.flash('error', 'Failed to change email. Please try again.');
      return res.redirect('/business/change-email');
    }
  },
);

/* ----------------------------------------------------------
 * 📨 POST: Business Signup (with email verification)
 * ✅ Matches your Business schema (payouts sub-schema default)
 * ✅ Uses applyPaypalPayouts(business, paypalEmail, payoutsOn)
 * ✅ Handles Mongo unique email (11000) correctly
 * ✅ FIX: Supports BOTH nested inputs and dotted inputs (representative.fullName)
 * ✅ FIX: Uses the TOP pickField() (so no eslint "unused" / no duplicate function)
 * -------------------------------------------------------- */
router.post(
  '/signup',
  redirectIfLoggedIn,
  businessLogoUpload.single('logo'),
  [
    body('name').trim().notEmpty().withMessage('Business name is required'),

    body('email').trim().isEmail().withMessage('Valid email is required').bail().normalizeEmail(),

    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),

    body('role')
      .isIn(['seller', 'supplier', 'buyer'])
      .withMessage('Role must be seller, supplier, or buyer'),

    // ✅ Business registration details
    body('officialNumber').trim().notEmpty().withMessage('Business number is required'),

    body('officialNumberType')
      .optional({ checkFalsy: true })
      .isIn(['CIPC_REG', 'VAT', 'TIN', 'OTHER'])
      .withMessage('Business number type is invalid'),

    // Business contact/location
    body('phone').trim().notEmpty().withMessage('Phone number is required'),
    body('country').trim().notEmpty().withMessage('Country name is required'),

    body('logo').custom((_, { req }) => {
      if (!req.file) {
        throw new Error('Business logo is required');
      }
      return true;
    }),

    // Shippo-ready business address fields
    body('countryCode')
      .trim()
      .notEmpty()
      .withMessage('Country code is required')
      .bail()
      .isLength({ min: 2, max: 2 })
      .withMessage('Country code must be 2 letters (ISO 2), e.g., ZA, US')
      .bail()
      .customSanitizer((v) =>
        String(v || '')
          .trim()
          .toUpperCase(),
      ),

    body('city').trim().notEmpty().withMessage('City is required'),

    body('state')
      .optional({ checkFalsy: true })
      .trim()
      .custom((v, { req }) => {
        const cc = String(req.body.countryCode || '')
          .trim()
          .toUpperCase();
        if (cc === 'US' && !String(v || '').trim()) {
          throw new Error('State is required for US addresses');
        }
        return true;
      }),

    body('postalCode').trim().notEmpty().withMessage('Postal code is required'),

    body('addressLine1').trim().notEmpty().withMessage('Street address (line 1) is required'),

    body('addressLine2').optional({ checkFalsy: true }).trim(),

    // ✅ PayPal email optional but if provided must be valid
    body('paypalEmail')
      .optional({ checkFalsy: true })
      .customSanitizer((v) =>
        String(v || '')
          .trim()
          .replace(/\s+/g, '')
          .toLowerCase(),
      )
      .isEmail()
      .withMessage('PayPal email must be a valid email address'),

    // ✅ payoutsEnabled can be "1"/"0" or "on" (checkbox)
    body('payoutsEnabled')
      .optional({ checkFalsy: true })
      .customSanitizer((v) => {
        const s = String(v ?? '')
          .trim()
          .toLowerCase();
        if (s === 'on' || s === 'true') return '1';
        if (s === 'off' || s === 'false') return '0';
        if (s === '1' || s === '0') return s;
        return s;
      })
      .isIn(['0', '1'])
      .withMessage('Invalid payoutsEnabled value'),

    // ✅ Authorized Representative (validator checks dotted name; pickField supports both dotted + nested)
    body('representative.fullName').custom((_, { req }) => {
      const v = pickField(req.body, 'representative.fullName', '');
      if (!v) throw new Error('Authorized representative full name is required');
      return true;
    }),

    body('representative.phone').custom((_, { req }) => {
      const v = pickField(req.body, 'representative.phone', '');
      if (!v) throw new Error('Authorized representative cellphone number is required');
      return true;
    }),

    body('representative.idNumber').custom((_, { req }) => {
      const v = pickField(req.body, 'representative.idNumber', '');
      if (!v) throw new Error('Authorized representative ID number is required');
      return true;
    }),

    // Terms agreement
    body('terms').equals('on').withMessage('You must accept the terms and conditions'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    const renderSignup = (statusCode, extra = {}) => {
      // ✅ rebuild representative object for the EJS even if inputs were dotted
      const repForView = {
        fullName: pickField(req.body, 'representative.fullName', ''),
        phone: pickField(req.body, 'representative.phone', ''),
        idNumber: pickField(req.body, 'representative.idNumber', ''),
      };

      return res.status(statusCode).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,

        errors: extra.errors || (errors.isEmpty() ? [] : errors.array()),

        // preserve submitted values
        ...req.body,
        representative: repForView,

        ...extra,
      });
    };

    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the highlighted errors.');
      return renderSignup(400);
    }

    try {
      const {
        name,
        email,
        password,
        role,
        officialNumber,
        officialNumberType,
        phone,
        countryCode,
        city,
        state,
        postalCode,
        addressLine1,
        addressLine2,
        payoutsEnabled, // "1"/"0"/"on"
      } = req.body;

      // ✅ pull representative from either dotted or nested style
      const repFullName = pickField(req.body, 'representative.fullName', '');
      const repPhone = pickField(req.body, 'representative.phone', '');
      const repIdNumber = pickField(req.body, 'representative.idNumber', '');

      const emailNorm = normalizeEmail(email);

      // ✅ payouts toggle
      const peRaw = payoutsEnabled;
      const payoutsOn = Array.isArray(peRaw)
        ? peRaw.includes('1') || peRaw.includes('on') || peRaw.includes('true')
        : ['1', 'on', 'true', 'yes'].includes(
            String(peRaw || '')
              .trim()
              .toLowerCase(),
          );

      // ✅ paypalEmail may be missing if the input was disabled on the client
      const paypalFromBodyExists = Object.prototype.hasOwnProperty.call(
        req.body || {},
        'paypalEmail',
      );
      const paypalEmailRaw = paypalFromBodyExists ? String(req.body.paypalEmail || '').trim() : '';

      // ✅ quick duplicate check (DB unique index is still the final authority)
      const existing = await Business.findOne({ email: emailNorm }).select('_id').lean();
      if (existing) {
        req.flash('error', 'An account with that email already exists.');
        return renderSignup(409, {
          errors: [{ msg: 'Email already in use', param: 'email' }],
        });
      }

      if (!req.file) {
        req.flash('error', 'Business logo is required.');
        return renderSignup(400, {
          errors: [{ msg: 'Business logo is required', param: 'logo' }],
        });
      }

      let logoUrl = '';

      try {
        logoUrl = await uploadBusinessLogoToS3(req.file);
      } catch (err) {
        console.error('❌ Business logo upload failed:', err);
        req.flash('error', 'Business logo upload failed. Please try again.');
        return renderSignup(400, {
          errors: [{ msg: 'Business logo upload failed', param: 'logo' }],
        });
      }

      const hashed = await bcrypt.hash(String(password), 12);

      // ✅ Email verification token + expiry
      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // ✅ internal business id
      const internalBusinessId = `BIZ-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

      const business = new Business({
        name: String(name || '').trim(),
        email: emailNorm,
        password: hashed,
        role,

        internalBusinessId,

        officialNumber: String(officialNumber || '').trim(),
        officialNumberType: officialNumberType || 'OTHER',

        phone: String(phone || '').trim(),

        /**
         * ✅ Shippo-ready structured fields
         */
        countryCode: String(countryCode || '')
          .trim()
          .toUpperCase(),
        city: String(city || '').trim(),
        state: String(state || '').trim(),
        postalCode: String(postalCode || '').trim(),
        addressLine1: String(addressLine1 || '').trim(),
        addressLine2: String(addressLine2 || '').trim(),

        /**
         * ✅ Backwards-compatible legacy fields (do NOT break other parts of your app)
         * - country: store ISO2 code
         * - address: combine line1 + line2 for older screens that display business.address
         */
        country: String(req.body.country || '').trim(), // ✅ human readable (legacy)
        address: `${String(addressLine1 || '').trim()}${addressLine2 ? `, ${String(addressLine2).trim()}` : ''}`, // ✅ legacy

        representative: {
          fullName: repFullName,
          phone: repPhone,
          idNumber: repIdNumber,
        },

        logoUrl,

        // email verification fields
        isVerified: false,
        emailVerificationToken: token,
        emailVerificationExpires: expiry,
        verificationEmailSentAt: new Date(),

        // business verification block
        verification: {
          status: 'pending',
          method: 'manual',
          provider: 'manual',
          updatedAt: new Date(),
        },

        welcomeEmailSentAt: null,
        officialNumberVerifiedEmailSentAt: null,
        officialNumberRejectedEmailSentAt: null,
      });

      // ✅ The ONLY place we set payouts during signup:
      const applied = applyPaypalPayouts(business, paypalEmailRaw, payoutsOn);
      if (!applied || applied.ok !== true) {
        const msg = applied?.error || 'Invalid PayPal email.';
        req.flash('error', msg);
        return renderSignup(400, {
          errors: [{ msg, param: 'paypalEmail' }],
        });
      }

      // ✅ Save with duplicate-key handling for schema unique email
      try {
        await business.save();
      } catch (e) {
        await deleteS3ImageByUrl(logoUrl);

        if (e && e.code === 11000 && (e?.keyPattern?.email || e?.keyValue?.email)) {
          req.flash('error', 'An account with that email already exists.');
          return renderSignup(409, {
            errors: [{ msg: 'Email already in use', param: 'email' }],
          });
        }
        throw e;
      }

      // ✅ Session setup (keep payouts in session for immediate UI use)
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: business.isVerified,
        payouts: {
          enabled: business.payouts?.enabled === true,
          paypalEmail: business.payouts?.paypalEmail || '',
        },
      };

      // ✅ Send verification email
      try {
        await sendBusinessVerificationEmail(business, token, req);
        req.flash(
          'success',
          `🎉 Welcome ${business.name}! Check your inbox at ${business.email} to verify your email.`,
        );
      } catch (mailErr) {
        console.error(
          '❌ Failed to send business verification email:',
          mailErr?.response?.body || mailErr?.message || mailErr,
        );
        req.flash(
          'error',
          'Your account was created but we could not send a verification email. Please use “Resend verification” from the verification page.',
        );
      }

      return res.redirect('/business/verify-pending');
    } catch (err) {
      console.error('❌ Signup error:', err);
      req.flash('error', 'Server error during signup. Please try again.');
      return res.status(500).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        errors: [{ msg: 'Server error' }],
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        ...req.body,
        representative: {
          fullName: pickField(req.body, 'representative.fullName', ''),
          phone: pickField(req.body, 'representative.phone', ''),
          idNumber: pickField(req.body, 'representative.idNumber', ''),
        },
      });
    }
  },
);

/* ----------------------------------------------------------
 * 🔐 GET: Business Login
 * -------------------------------------------------------- */
router.get('/login', redirectIfLoggedIn, async (req, res) => {
  let shopHeaderImage = null;

  try {
    const ShopHeaderImage = require('../models/ShopHeaderImage');

    shopHeaderImage = await ShopHeaderImage.findOne({ active: true })
      .sort({ updatedAt: -1 })
      .lean();
  } catch (err) {
    console.warn('⚠️ Failed to load shopHeaderImage for business login:', err.message);
  }

  res.render('business-login', {
    title: 'Business Login',
    active: 'business-login',
    errors: [],
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
    shopHeaderImage,
  });
});

/* ----------------------------------------------------------
 * 🔑 POST: Business Login  (with verification check)
 * -------------------------------------------------------- */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    console.log('✅ Business login attempt:', {
      hasSession: !!req.session,
      hasBiz: !!req.session?.business,
    });
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the errors and try again.');
      return res.status(400).render('business-login', {
        title: 'Business Login',
        active: 'business-login',
        errors: errors.array(),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }

    try {
      const { email, password } = req.body;
      const emailNorm = normalizeEmail(email);
      const business = await Business.findOne({ email: emailNorm });

      if (!business || !(await bcrypt.compare(password, business.password))) {
        req.flash('error', '❌ Invalid email or password.');
        return res.status(401).render('business-login', {
          title: 'Business Login',
          active: 'business-login',
          errors: [{ msg: 'Invalid email or password' }],
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
        isVerified: business.isVerified,
      };

      req.session.businessId = business._id.toString();

      // If not verified: resend link + send to verify page
      if (!business.isVerified) {
        const lastSent = business.verificationEmailSentAt
          ? new Date(business.verificationEmailSentAt).getTime()
          : 0;

        const cooldownMs = 60 * 1000;
        if (lastSent && Date.now() - lastSent < cooldownMs) {
          const secs = Math.ceil((cooldownMs - (Date.now() - lastSent)) / 1000);
          req.flash(
            'warning',
            `Please wait ${secs}s before requesting another verification email.`,
          );
          return req.session.save(() => res.redirect('/business/verify-pending'));
        }

        const now = new Date();
        let token = business.emailVerificationToken;
        const expired =
          !business.emailVerificationExpires ||
          business.emailVerificationExpires.getTime() < Date.now();

        if (!token || expired) {
          token = crypto.randomBytes(32).toString('hex');
          business.emailVerificationToken = token;
          business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
        business.verificationEmailSentAt = now;
        await business.save();

        try {
          await sendBusinessVerificationEmail(business, token, req);
          req.flash(
            'success',
            `We sent a fresh verification link to ${business.email}. Please verify your email to access your dashboard.`,
          );
        } catch (mailErr) {
          console.error('❌ Failed to send login verification email:', mailErr);
          req.flash(
            'error',
            'We could not send a verification email right now. Please try again later or contact support.',
          );
        }

        return req.session.save(() => res.redirect('/business/verify-pending'));
      }

      // Already verified
      req.flash('success', `✅ Welcome back, ${business.name}!`);

      // ✅ decide redirect target FIRST
      let redirectTo = '/business/login';
      switch (business.role) {
        case 'seller':
          redirectTo = '/business/dashboards/seller-dashboard';
          break;
        case 'supplier':
          redirectTo = '/business/dashboards/supplier-dashboard';
          break;
        case 'buyer':
          redirectTo = '/business/dashboards/buyer-dashboard';
          break;
        default:
          req.flash('error', 'Invalid business role.');
          redirectTo = '/business/login';
          break;
      }

      // ✅ CRITICAL: SAVE session before redirect so MongoStore persists it
      return req.session.save((err2) => {
        if (err2) {
          console.error('❌ session save error:', err2);
          req.flash('error', 'Login failed. Try again.');
          return res.redirect('/business/login');
        }

        console.log('✅ Business session saved OK:', req.session.business);
        return res.redirect(redirectTo);
      });
    } catch (err) {
      console.error('❌ Login error:', err);
      req.flash('error', '❌ Login failed. Please try again later.');
      return res.status(500).render('business-login', {
        title: 'Business Login',
        errors: [{ msg: 'Server error' }],
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }
  },
);

/* ----------------------------------------------------------
 * 🏦 Bank Details (GET)
 * -------------------------------------------------------- */
router.get('/profile/edit-bank', requireBusiness, async (req, res) => {
  try {
    const businessId = req.business?._id;

    if (!businessId || !mongoose.isValidObjectId(businessId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(businessId)
      .select('name email role bankDetails') // only what this page needs
      .lean();

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    return res.render('business-profile-edit-bank', {
      title: 'Update Bank Details',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ GET /profile/edit-bank error:', err);
    req.flash('error', 'Failed to load bank details page.');
    return res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 🏦 Bank Details (POST)  action="/business/profile/update-bank"
 * -------------------------------------------------------- */
// POST /business/profile/update-bank
router.post('/profile/update-bank', requireBusiness, async (req, res, next) => {
  try {
    const bizId = req.business?._id;
    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // Accept ALL styles:
    // 1) nested: bankDetails[bankName]
    // 2) dotted: bankDetails.bankName
    // 3) flat:   bankName
    const bd = req.body?.bankDetails || {};

    const pick = (key) => {
      const v = bd?.[key] ?? req.body?.[`bankDetails.${key}`] ?? req.body?.[key] ?? '';
      return String(v ?? '').trim();
    };

    // Build $set only for non-empty values (prevents wiping saved data)
    const set = {};
    const setIf = (path, val) => {
      if (val !== undefined && val !== null) {
        const s = String(val).trim();
        if (s !== '') set[path] = s;
      }
    };

    // Pull submitted values
    const payoutMethod = pick('payoutMethod') || 'bank';

    const accountHolderName = pick('accountHolderName');
    const bankName = pick('bankName');
    const accountNumber = pick('accountNumber').replace(/\s+/g, '');
    const branchCode = pick('branchCode');
    const accountType = pick('accountType');
    const currency = pick('currency');
    const swiftCode = pick('swiftCode');
    const iban = pick('iban');

    // If payoutMethod=bank, require the basics IF they are trying to use bank payouts
    // (This also prevents saving an invalid bank payout config.)
    if (payoutMethod === 'bank') {
      // If they submitted ANY bank field, enforce required basics
      const submittedAnyBankField = Boolean(
        accountHolderName ||
          bankName ||
          accountNumber ||
          branchCode ||
          accountType ||
          currency ||
          swiftCode ||
          iban,
      );

      if (submittedAnyBankField) {
        if (!accountHolderName || !accountNumber) {
          req.flash('error', 'Please enter Account Holder Name and Account Number.');
          return res.redirect('/business/profile/edit-bank');
        }
      }
    }

    // Only set fields that are actually non-empty
    setIf('bankDetails.payoutMethod', payoutMethod);
    setIf('bankDetails.accountHolderName', accountHolderName);
    setIf('bankDetails.bankName', bankName);
    setIf('bankDetails.accountNumber', accountNumber);
    setIf('bankDetails.branchCode', branchCode);
    setIf('bankDetails.accountType', accountType);
    setIf('bankDetails.currency', currency);
    setIf('bankDetails.swiftCode', swiftCode);
    setIf('bankDetails.iban', iban);

    // If NOTHING to update, don’t touch DB
    if (Object.keys(set).length === 0) {
      req.flash('info', 'No changes detected.');
      return res.redirect('/business/profile');
    }

    set['bankDetails.updatedAt'] = new Date();

    await Business.findByIdAndUpdate(bizId, { $set: set }, { new: true });

    req.flash('success', '✅ Bank details updated.');
    return res.redirect('/business/profile');
  } catch (err) {
    return next(err);
  }
});

/* =======================================================
 * BUSINESS PASSWORD – FORGOT / RESET
 * =======================================================
 */

// GET /business/password/forgot
router.get('/password/forgot', (req, res) => {
  res.render('business-forgot', {
    title: 'Forgot business password',
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

// POST /business/password/forgot
router.post('/password/forgot', async (req, res) => {
  try {
    const rawEmail = (req.body && req.body.email) || '';
    const email = normalizeEmail(rawEmail);

    if (!email) {
      req.flash('error', 'Please enter your business email.');
      return res.redirect('/business/password/forgot');
    }

    const business = await Business.findOne({ email });

    if (business) {
      // remove old tokens for this business
      await BusinessResetToken.deleteMany({ businessId: business._id });

      // new token valid for 1 hour
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

      await BusinessResetToken.create({
        businessId: business._id,
        token,
        expiresAt,
      });

      try {
        await sendBusinessResetEmail(business, token, req);
      } catch (mailErr) {
        console.error('❌ Failed to send business reset email:', mailErr);
      }
    }

    // Always show "check email" even if account not found
    return res.render('business-forgot-sent', {
      title: 'Check your email',
      maskedEmail: maskEmail(email),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ business forgot error:', err);
    req.flash('error', 'Could not send reset link. Please try again.');
    return res.redirect('/business/password/forgot');
  }
});

// GET /business/password/reset/:token
router.get('/password/reset/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    const now = new Date();
    const doc = await BusinessResetToken.findOne({
      token,
      expiresAt: { $gt: now },
    });

    if (!doc) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    return res.render('business-reset', {
      title: 'Set a new password',
      token,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ business reset GET error:', err);
    req.flash('error', 'Could not open reset page.');
    return res.redirect('/business/password/forgot');
  }
});

// POST /business/password/reset/:token
router.post('/password/reset/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const { password, confirm } = req.body || {};

    if (!password || !confirm) {
      req.flash('error', 'Please fill in both password fields.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }
    if (password !== confirm) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }
    if (String(password).length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect(`/business/password/reset/${encodeURIComponent(token)}`);
    }

    const now = new Date();
    const doc = await BusinessResetToken.findOne({
      token,
      expiresAt: { $gt: now },
    });

    if (!doc) {
      req.flash('error', 'Reset link is invalid or expired.');
      return res.redirect('/business/password/forgot');
    }

    const business = await Business.findById(doc.businessId);
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/password/forgot');
    }

    business.password = await bcrypt.hash(String(password).trim(), 12);
    await business.save();

    // remove all tokens for this business
    await BusinessResetToken.deleteMany({ businessId: business._id });

    req.flash('success', 'Your password has been reset. You can now log in.');
    return res.redirect('/business/login');
  } catch (err) {
    console.error('❌ business reset POST error:', err);
    req.flash('error', 'Could not reset password. Please try again.');
    return res.redirect('/business/password/forgot');
  }
});

/* ----------------------------------------------------------
 * SELLER DASHBOARD → redirect to new /seller-ui
 * Production-safe:
 * - auth guarded
 * - role checked
 * - verification checked from DB
 * - redirects only to internal local path
 * -------------------------------------------------------- */
router.get(
  '/dashboards/seller-dashboard',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);

      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'seller') {
        req.flash('error', '⛔ Access denied. Seller accounts only.');
        return res.redirect('/business/dashboard');
      }

      const sellerDoc = await Business.findById(getBizId(req)).select('_id role isVerified').lean();

      if (!sellerDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sellerDoc.role !== 'seller') {
        req.flash('error', '⛔ Access denied. Seller accounts only.');
        return res.redirect('/business/dashboard');
      }

      if (!sellerDoc.isVerified) {
        req.flash('error', 'Please verify your email to access the seller dashboard.');
        return res.redirect('/business/verify-pending');
      }

      return res.redirect(302, '/seller-ui/');
    } catch (err) {
      console.error('❌ Seller dashboard redirect error:', err);
      req.flash('error', 'Failed to open seller dashboard.');
      return res.redirect('/business/login');
    }
  },
);

/* ----------------------------------------------------------
 * SUPPLIER DASHBOARD (NO CHART LOGIC)
 * ✅ NOW IGNORES refunded/cancelled orders AND refunded items
 * -------------------------------------------------------- */
router.get(
  '/dashboards/supplier-dashboard',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const sessionBusiness = getBiz(req);

      if (!sessionBusiness || !sessionBusiness._id) {
        req.flash('error', 'Session expired. Please log in again.');
        return res.redirect('/business/login');
      }

      if (sessionBusiness.role !== 'supplier') {
        req.flash('error', '⛔ Access denied. Supplier accounts only.');
        return res.redirect('/business/dashboard');
      }

      const supplierDoc = await Business.findById(sessionBusiness._id)
        .select('_id name email role isVerified logoUrl')
        .lean();

      if (!supplierDoc) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      if (!supplierDoc.isVerified) {
        req.flash('error', 'Please verify your email to access the supplier dashboard.');
        return res.redirect('/business/verify-pending');
      }

      // ✅ Supplier dashboard data only.
      // ✅ Uses SupplierProduct + SupplyRequest.
      // ✅ Supplier KPI cards use SupplierProduct + SupplyRequest.
      // ✅ Supplier main chart also reads imported seller Product stock linked by sourceSupplier.
      const supplierDashboardData = await computeSupplierWholesaleDashboardData(supplierDoc._id);
      const supplierMainChart = await buildSupplierMainChartData(supplierDoc._id);

      const supplierAvatarUrl =
        String(supplierDoc.logoUrl || '').trim() || '/images/branding/logo-unincorporate.png';

      const supportInbox = process.env.SUPPORT_INBOX || 'support@unicoporate.test';

      const mailerOk = !!(
        process.env.SENDGRID_API_KEY ||
        process.env.SMTP_HOST ||
        process.env.SMTP_URL
      );

      return res.render('dashboards/supplier-dashboard', {
        layout: false,

        title: 'Supplier Dashboard',
        business: supplierDoc,
        supplierAvatarUrl,

        // Supplier inventory totals
        totals: supplierDashboardData.totals,
        products: supplierDashboardData.products,
        inventoryValue: supplierDashboardData.inventoryValue,

        // ✅ The 4 new supplier product card groups
        supplierTopSellingProducts: supplierDashboardData.supplierTopSellingProducts || [],

        supplierLowStockProducts: supplierDashboardData.supplierLowStockProducts || [],

        supplierOutOfStockProducts: supplierDashboardData.supplierOutOfStockProducts || [],

        supplierFastestGrowingProducts: supplierDashboardData.supplierFastestGrowingProducts || [],

        // ✅ Real supplier performance section under the 4 product cards
        supplierPerformanceOverview: supplierDashboardData.supplierPerformanceOverview || {},

        // ✅ Seller location interest section above footer
        supplierLocationInterest: supplierDashboardData.supplierLocationInterest || {
          countries: [],
          provinces: [],
          cities: [],
        },

        supplierMainChart,

        // Safe defaults for old dashboard sections that may still exist in the EJS
        trackingStats: {
          total: 0,
          delivered: 0,
          inTransit: 0,
          processing: 0,
        },

        orders: {
          total: 0,
          byStatus: {},
          recent: [],
        },

        kpis: {
          totalProducts: supplierDashboardData.totals.totalProducts,
          totalStock: supplierDashboardData.totals.totalStock,
          inStock: supplierDashboardData.totals.inStock,
          lowStock: supplierDashboardData.totals.lowStock,
          outOfStock: supplierDashboardData.totals.outOfStock,
          inventoryValue: supplierDashboardData.inventoryValue,
        },

        deliveryOptions: [],
        isOrdersAdmin: false,
        mailerOk,
        supportInbox,

        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        baseCurrency: BASE_CURRENCY,
        formatMoney: formatBusinessMoney,
      });
    } catch (err) {
      console.error('❌ Supplier dashboard error:', err);
      req.flash('error', '❌ Failed to load supplier dashboard.');
      return res.redirect('/business/login');
    }
  },
);

/* ----------------------------------------------------------
 * Supplier KPIs JSON for auto-refresh
 * -------------------------------------------------------- */
router.get('/api/supplier/kpis', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = getBiz(req);

    if (!business || !business._id || business.role !== 'supplier') {
      return res.status(403).json({
        ok: false,
        message: 'Suppliers only',
      });
    }

    // ✅ Supplier KPI API must also use SupplierProduct + SupplyRequest only.
    const supplierDashboardData = await computeSupplierWholesaleDashboardData(business._id);
    const supplierSoldCardData = await buildSupplierSoldCardData(business._id);
    const supplierPayoutCardData = await buildSupplierPayoutCardData(business._id);
    const supplierRefundCardData = await buildSupplierRefundCardData(business._id);
    const supplierObjectId = new mongoose.Types.ObjectId(String(business._id));

    const stockStart = new Date();
    stockStart.setDate(stockStart.getDate() - 6);
    stockStart.setHours(0, 0, 0, 0);

    const stockMovementRows = await SupplierProduct.aggregate([
      {
        $match: {
          supplier: supplierObjectId,
          status: { $ne: 'archived' },
          updatedAt: { $gte: stockStart },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$updatedAt',
            },
          },
          totalStock: { $sum: '$availableQuantity' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const stockMovementMap = new Map(
      stockMovementRows.map((row) => [String(row._id), Number(row.totalStock || 0)]),
    );

    const stockChartLabels = [];
    const stockChartData = [];

    for (let i = 0; i < 7; i += 1) {
      const d = new Date(stockStart);
      d.setDate(stockStart.getDate() + i);

      const key = d.toISOString().slice(0, 10);

      stockChartLabels.push(
        d.toLocaleDateString(undefined, {
          weekday: 'short',
        }),
      );

      stockChartData.push(stockMovementMap.get(key) || 0);
    }

    return res.json({
      ok: true,

      totals: supplierDashboardData.totals,
      inventoryValue: supplierDashboardData.inventoryValue,

      chart: {
        card1: {
          labels: stockChartLabels,
          data: stockChartData,
        },
        card2: {
          labels: supplierSoldCardData.chart.labels,
          data: supplierSoldCardData.chart.data,
        },
        card3: {
          labels: supplierPayoutCardData.chart.labels,
          data: supplierPayoutCardData.chart.data,
        },
        card4: {
          labels: supplierRefundCardData.chart.labels,
          data: supplierRefundCardData.chart.data,
        },
      },

      sales: {
        totalSoldStock: supplierSoldCardData.totalSoldStock,
        totalSalesRevenue: supplierSoldCardData.totalSalesRevenue,
        currency: BASE_CURRENCY,
      },

      payouts: {
        eligiblePayoutAmount: supplierPayoutCardData.eligiblePayoutAmount,
        latestPaidAmount: supplierPayoutCardData.latestPaidAmount,
        latestPaidAt: supplierPayoutCardData.latestPaidAt,
        currency: supplierPayoutCardData.currency,
      },

      refunds: {
        totalRefundedOrders: supplierRefundCardData.totalRefundedOrders,
        totalRefundedProducts: supplierRefundCardData.totalRefundedProducts,
        totalRefundedStock: supplierRefundCardData.totalRefundedStock,
      },

      supplierTopSellingProducts: supplierDashboardData.supplierTopSellingProducts || [],

      supplierLowStockProducts: supplierDashboardData.supplierLowStockProducts || [],

      supplierOutOfStockProducts: supplierDashboardData.supplierOutOfStockProducts || [],

      supplierFastestGrowingProducts: supplierDashboardData.supplierFastestGrowingProducts || [],
    });
  } catch (err) {
    console.error('❌ Supplier KPI API error:', err);
    return res.status(500).json({
      ok: false,
      message: 'Failed to load supplier KPIs',
    });
  }
});

/* ----------------------------------------------------------
 * Supplier mainChart JSON
 * ✅ Real supplier data only
 * ✅ Used by views/dashboards/partials/supplier-charts.ejs
 * -------------------------------------------------------- */
function normalizeSupplierTrendRange(value) {
  const range = String(value || '')
    .trim()
    .toLowerCase();

  if (range === 'day') return 'day';
  if (range === 'year') return 'year';

  return 'month';
}

function startOfSupplierChartDay(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function supplierDateKey(date, range) {
  const d = new Date(date);

  if (range === 'year') {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function supplierDateLabel(key, range) {
  if (range === 'year') {
    const [year, month] = String(key || '').split('-');
    const d = new Date(Number(year), Number(month) - 1, 1);

    return d.toLocaleDateString(undefined, {
      month: 'short',
      year: 'numeric',
    });
  }

  const d = new Date(`${key}T00:00:00`);

  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function buildSupplierTrendBuckets(range) {
  const safeRange = normalizeSupplierTrendRange(range);
  const now = new Date();
  const buckets = [];

  if (safeRange === 'year') {
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    start.setMonth(start.getMonth() - 11);

    for (let i = 0; i < 12; i += 1) {
      const d = new Date(start);
      d.setMonth(start.getMonth() + i);
      buckets.push(supplierDateKey(d, 'year'));
    }

    return {
      range: 'year',
      rangeLabel: 'Last 12 months',
      fromDate: start,
      buckets,
    };
  }

  if (safeRange === 'day') {
    const start = startOfSupplierChartDay(now);
    start.setDate(start.getDate() - 6);

    for (let i = 0; i < 7; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      buckets.push(supplierDateKey(d, 'day'));
    }

    return {
      range: 'day',
      rangeLabel: 'Last 7 days',
      fromDate: start,
      buckets,
    };
  }

  const start = startOfSupplierChartDay(now);
  start.setDate(start.getDate() - 29);

  for (let i = 0; i < 30; i += 1) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    buckets.push(supplierDateKey(d, 'month'));
  }

  return {
    range: 'month',
    rangeLabel: 'Last 30 days',
    fromDate: start,
    buckets,
  };
}

async function buildSupplierTrendOverview(supplierId, range = 'month') {
  const supplierObjectId = new mongoose.Types.ObjectId(String(supplierId));
  const trend = buildSupplierTrendBuckets(range);

  const groupFormat = trend.range === 'year' ? '%Y-%m' : '%Y-%m-%d';

  const importedRows = await SupplyRequest.aggregate([
    {
      $addFields: {
        supplierChartDate: {
          $ifNull: ['$approvedAt', '$createdAt'],
        },
      },
    },
    {
      $match: {
        supplier: supplierObjectId,
        status: 'approved',
        supplierChartDate: { $gte: trend.fromDate },
      },
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: groupFormat,
            date: '$supplierChartDate',
          },
        },

        // Purple line: how many supplier product imports were approved
        importedProducts: { $sum: 1 },

        // Green line: total stock quantity imported/requested by sellers
        importedStock: { $sum: '$requestedQuantity' },
      },
    },
  ]);

  const importedProductsMap = new Map(
    importedRows.map((row) => [String(row._id), Number(row.importedProducts || 0)]),
  );

  const importedStockMap = new Map(
    importedRows.map((row) => [String(row._id), Number(row.importedStock || 0)]),
  );

  return {
    range: trend.range,
    rangeLabel: trend.rangeLabel,
    chart: {
      labels: trend.buckets.map((key) => supplierDateLabel(key, trend.range)),

      // This is what supplier-charts.ejs reads for the purple line
      importedProducts: trend.buckets.map((key) => importedProductsMap.get(key) || 0),

      // This is what supplier-charts.ejs reads for the green line
      importedStock: trend.buckets.map((key) => importedStockMap.get(key) || 0),

      // Safe old key, in case another old section still reads it
      requested: trend.buckets.map((key) => importedProductsMap.get(key) || 0),
    },
  };
}

router.get(
  '/api/supplier/trend-overview',
  requireBusiness,
  requireVerifiedBusiness,
  async (req, res) => {
    try {
      const business = getBiz(req);

      if (!business || !business._id || business.role !== 'supplier') {
        return res.status(403).json({
          ok: false,
          message: 'Suppliers only',
        });
      }

      const range = normalizeSupplierTrendRange(req.query.range);
      const overview = await buildSupplierTrendOverview(business._id, range);

      return res.json({
        ok: true,
        ...overview,
      });
    } catch (err) {
      console.error('❌ Supplier trend overview API error:', err);

      return res.status(500).json({
        ok: false,
        message: 'Failed to load supplier trend overview',
      });
    }
  },
);

/* ----------------------------------------------------------
 * Seller KPIs JSON for auto-refresh
 * -------------------------------------------------------- */
router.get('/api/seller/kpis', requireBusiness, async (req, res) => {
  try {
    const business = getBiz(req);
    if (!business || !business._id || business.role !== 'seller') {
      return res.status(403).json({ ok: false, message: 'Sellers only' });
    }

    const kpis = await computeSupplierKpis(business._id);
    return res.json({ ok: true, ...kpis });
  } catch (err) {
    console.error('seller KPI API error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load KPIs' });
  }
});

/* ----------------------------------------------------------
 * BUYER DASHBOARD
 * ✅ Shows refunded/cancelled clearly in table (uiStatus)
 * ✅ KPIs ignore refunded/cancelled (DB-backed)
 * ✅ Shipping stats ignore refunded/cancelled
 * ✅ orderedProducts ignores refunded/cancelled orders + refunded items
 * ✅ demands/matches added (safe defaults)
 * ✅ /business/api/buyer/stats added for auto-refresh
 * -------------------------------------------------------- */

// NOTE: ensure these are imported at top of your file:
// const Business = require('../models/Business');
// const Product = require('../models/Product');
// const requireBusiness = require('../middleware/requireBusiness');

router.get('/dashboards/buyer-dashboard', requireBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
    if (!sessionBusiness || !sessionBusiness._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    if (sessionBusiness.role !== 'buyer') {
      req.flash('error', '⛔ Access denied. Buyer accounts only.');
      return res.redirect('/business/dashboard');
    }

    const business = await Business.findById(sessionBusiness._id).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    if (!business.isVerified) {
      req.flash('error', 'Please verify your email to access the buyer dashboard.');
      return res.redirect('/business/verify-pending');
    }

    const OrderModel = Order;

    // ----------------------------
    // Helpers (order + item)
    // ----------------------------
    function isRefundedOrder(o) {
      if (!o) return false;
      if (o.isRefunded === true) return true;
      if (o.refundedAt) return true;
      const rs = String(o.refundStatus || '')
        .trim()
        .toUpperCase();
      return rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED';
    }

    function isCancelledOrder(o) {
      const st = String(o?.status || '')
        .trim()
        .toUpperCase();
      return st === 'CANCELLED' || st === 'CANCELED' || st === 'VOIDED';
    }

    function isRefundedItem(it) {
      if (!it) return false;
      if (it.isRefunded === true) return true;
      if (it.refundedAt) return true;
      const rs = String(it.refundStatus || '')
        .trim()
        .toUpperCase();
      return rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED';
    }

    // ----------------------------
    // 1) Orders list (KEEP ALL so buyer sees refunded/cancelled)
    // ----------------------------
    const ordersRaw = await OrderModel.find({ businessBuyer: business._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const ordersWithUi = ordersRaw.map((o) => {
      const refunded = isRefundedOrder(o);
      const cancelled = !refunded && isCancelledOrder(o);

      const uiStatus = refunded ? 'Refunded' : cancelled ? 'Cancelled' : o.status || 'Unknown';

      const uiStatusKey = String(uiStatus).toLowerCase().replace(/\s+/g, '-');

      return {
        ...o,
        uiStatus,
        uiStatusKey,
        _isRefunded: refunded,
        _isCancelled: cancelled,
      };
    });

    const activeOrders = ordersWithUi.filter((o) => !o._isRefunded && !o._isCancelled);

    // ----------------------------
    // 2) KPI counts (DB-backed, ignore refunded/cancelled)
    // ----------------------------
    const nonRefundedCancelMatch = {
      businessBuyer: business._id,
      status: { $nin: ['Cancelled', 'CANCELLED', 'Canceled', 'CANCELED', 'Voided', 'VOIDED'] },
      isRefunded: { $ne: true },
      refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] },
      $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }],
    };

    const totalOrders = await OrderModel.countDocuments(nonRefundedCancelMatch);

    const completedOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Completed', 'COMPLETED', 'Delivered', 'DELIVERED'] },
    });

    const pendingOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: {
        $in: ['Pending', 'PENDING', 'Processing', 'PROCESSING', 'PAID', 'Shipped', 'SHIPPED'],
      },
    });

    const refundedOrders = await OrderModel.countDocuments({
      businessBuyer: business._id,
      $or: [
        { isRefunded: true },
        { refundStatus: { $in: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] } },
        { refundedAt: { $exists: true, $ne: null } },
      ],
    });

    // ----------------------------
    // 3) Shipping stats (ignore refunded/cancelled)
    // ----------------------------
    let shipStats = { inTransit: 0, delivered: 0, processing: 0 };

    // Prefer orderId when present, else fallback to _id
    const activeOrderKeys = activeOrders
      .map((o) => (o.orderId ? { orderId: o.orderId } : { _id: o._id }))
      .filter(Boolean);

    if (activeOrderKeys.length > 0) {
      const matchStage = {
        $match: {
          $or: activeOrderKeys,
        },
      };

      const trackingAgg = await OrderModel.aggregate([
        matchStage,
        { $group: { _id: '$shippingTracking.status', count: { $sum: 1 } } },
      ]);

      for (const r of trackingAgg) {
        const s = String(r._id || '').toUpperCase();
        if (s === 'IN_TRANSIT' || s === 'SHIPPED') shipStats.inTransit += Number(r.count || 0);
        if (s === 'DELIVERED') shipStats.delivered += Number(r.count || 0);
        if (s === 'PROCESSING') shipStats.processing += Number(r.count || 0);
      }
    }

    // ----------------------------
    // 4) Products from orders (ignore refunded/cancelled orders + refunded items)
    // ----------------------------
    const orderedCustomIds = new Set();

    for (const o of activeOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        if (isRefundedItem(it)) continue;

        const pid = it.productId || it.customId || it.pid || it.sku;
        if (pid) orderedCustomIds.add(String(pid));
      }
    }

    let orderedProducts = [];
    if (orderedCustomIds.size > 0) {
      const ids = Array.from(orderedCustomIds);

      orderedProducts = await Product.find({
        $or: [{ customId: { $in: ids } }, { _id: { $in: ids } }],
      })
        .select('customId name price imageUrl category stock')
        .limit(8)
        .lean();
    }

    // ----------------------------
    // 5) Demands + Matches (safe defaults for now)
    // ----------------------------
    // If you already have models later, replace this section with real queries.
    const demands = { active: 0, pendingMatches: 0 };
    const matches = [];

    // ----------------------------
    // 6) Mailer status
    // ----------------------------
    const mailerOk = !!(
      process.env.SENDGRID_API_KEY ||
      process.env.SMTP_HOST ||
      process.env.SMTP_URL
    );

    // Table wants 6 items
    const recentOrders = ordersWithUi.slice(0, 6);

    return res.render('dashboards/buyer-dashboard', {
      title: 'Buyer Dashboard',
      business,

      success: req.flash('success'),
      error: req.flash('error'),

      totalOrders,
      completedOrders,
      pendingOrders,
      refundedOrders, // optional KPI

      orders: recentOrders, // includes uiStatus/uiStatusKey/_isRefunded/_isCancelled
      shipStats,
      orderedProducts,

      demands,
      matches,

      mailerOk,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,

      baseCurrency: BASE_CURRENCY,
      formatMoney: formatBusinessMoney,
    });
  } catch (err) {
    console.error('❌ Buyer dashboard error:', err);
    req.flash('error', 'Failed to load buyer dashboard.');
    return res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * BUYER DASHBOARD API (auto-refresh)
 * This matches the EJS refresh script fields exactly.
 * -------------------------------------------------------- */
router.get('/api/buyer/stats', requireBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
    if (!sessionBusiness?._id) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (sessionBusiness.role !== 'buyer')
      return res.status(403).json({ ok: false, error: 'Forbidden' });

    const business = await Business.findById(sessionBusiness._id).select('_id isVerified').lean();
    if (!business) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!business.isVerified) return res.status(403).json({ ok: false, error: 'Unverified' });

    const OrderModel = Order;

    const nonRefundedCancelMatch = {
      businessBuyer: business._id,
      status: { $nin: ['Cancelled', 'CANCELLED', 'Canceled', 'CANCELED', 'Voided', 'VOIDED'] },
      isRefunded: { $ne: true },
      refundStatus: { $nin: ['REFUNDED', 'FULL', 'FULLY_REFUNDED'] },
      $or: [{ refundedAt: { $exists: false } }, { refundedAt: null }],
    };

    const totalOrders = await OrderModel.countDocuments(nonRefundedCancelMatch);

    const completedOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: { $in: ['Completed', 'COMPLETED', 'Delivered', 'DELIVERED'] },
    });

    const pendingOrders = await OrderModel.countDocuments({
      ...nonRefundedCancelMatch,
      status: {
        $in: ['Pending', 'PENDING', 'Processing', 'PROCESSING', 'PAID', 'Shipped', 'SHIPPED'],
      },
    });

    // Shipping stats from active orders (recent window = last 30 days optional)
    // Keep simple: aggregate for the buyer ignoring refunded/cancelled
    const trackingAgg = await OrderModel.aggregate([
      { $match: nonRefundedCancelMatch },
      { $group: { _id: '$shippingTracking.status', count: { $sum: 1 } } },
    ]);

    let delivered = 0;
    let inTransit = 0;
    let processing = 0;

    for (const r of trackingAgg) {
      const s = String(r._id || '').toUpperCase();
      if (s === 'DELIVERED') delivered += Number(r.count || 0);
      if (s === 'IN_TRANSIT' || s === 'SHIPPED') inTransit += Number(r.count || 0);
      if (s === 'PROCESSING') processing += Number(r.count || 0);
    }

    return res.json({
      ok: true,
      totalOrders,
      completedOrders,
      pendingOrders,
      delivered,
      inTransit,
      processing,
    });
  } catch (err) {
    console.error('❌ Buyer stats api error:', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

/* ----------------------------------------------------------
 * 🧭 GET: Universal Dashboard Redirector
 * -------------------------------------------------------- */
router.get('/dashboard', requireBusiness, (req, res) => {
  const { role } = getBiz(req) || {};
  if (!role) {
    req.flash('error', 'Please log in again.');
    return res.redirect('/business/login');
  }

  switch (role) {
    case 'seller':
      return res.redirect('/business/dashboards/seller-dashboard');
    case 'supplier':
      return res.redirect('/business/dashboards/supplier-dashboard');
    case 'buyer':
      return res.redirect('/business/dashboards/buyer-dashboard');
    default:
      req.flash('error', 'Invalid business role.');
      return res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * 🔓 Logout
 * -------------------------------------------------------- */
router.post('/logout', (req, res) => {
  if (!req.session) {
    return res.redirect('/business/login');
  }

  req.flash('success', "You've been logged out successfully.");

  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.redirect('/business/dashboard');
    }

    res.clearCookie('connect.sid');
    res.redirect('/business/login');
  });
});

/* ----------------------------------------------------------
 * 🔒 Change password (while logged in)
 * -------------------------------------------------------- */

// GET /business/change-password
router.get('/change-password', requireBusiness, (req, res) => {
  res.render('business-change-password', {
    title: 'Change password',
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

// POST /business/change-password
router.post('/change-password', requireBusiness, async (req, res) => {
  try {
    const { current, next, confirm } = req.body || {};

    if (!current || !next || !confirm) {
      req.flash('error', 'All fields are required.');
      return res.redirect('/business/change-password');
    }
    if (next !== confirm) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/business/change-password');
    }
    if (String(next).trim().length < 6) {
      req.flash('error', 'New password must be at least 6 characters.');
      return res.redirect('/business/change-password');
    }

    const business = await Business.findById(getBizId(req));
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const ok = await bcrypt.compare(String(current), business.password);
    if (!ok) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/business/change-password');
    }

    business.password = await bcrypt.hash(String(next).trim(), 12);
    await business.save();

    req.flash('success', 'Password updated successfully.');
    return res.redirect('/business/profile');
  } catch (err) {
    console.error('❌ Change business password error:', err);
    req.flash('error', 'Failed to change password.');
    return res.redirect('/business/change-password');
  }
});

/* ----------------------------------------------------------
 * 👤 Profile Management  (UPDATED: includes PayPal payouts email)
 * -------------------------------------------------------- */
router.get('/profile', requireBusiness, async (req, res) => {
  try {
    const bizId = req.business?._id;

    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ OWNER VIEW: fetch full doc fields needed for the profile page
    // ❌ do NOT use toSafeJSON() here (it hides bank details by design)
    const business = await Business.findById(bizId)
      .select(
        [
          'name email role phone country city address createdAt',
          'officialNumber officialNumberType',
          'verification isVerified',
          'logoUrl',
          'bankDetails',
          // ✅ PayPal payouts
          'payouts',
        ].join(' '),
      )
      .lean();

    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    // ✅ Mask account number for display (profile page should not show full number)
    const bd = business.bankDetails || {};

    // Try multiple possible saved shapes (old/new)
    const rawAcc = String(
      bd.accountNumber || '', // preferred (unmasked)
    ).replace(/\s+/g, '');

    const maskedFromDb = String(bd.accountNumberMasked || '').trim();
    const last4FromDb = String(bd.accountNumberLast4 || '').trim();

    const last4 = rawAcc.length >= 4 ? rawAcc.slice(-4) : last4FromDb ? last4FromDb.slice(-4) : '';

    // If DB already has a masked value, keep it; otherwise generate it from last4
    const finalMasked = maskedFromDb ? maskedFromDb : last4 ? `****${last4}` : '—';

    business.bankDetails = {
      ...bd,
      accountNumberLast4: last4 || (last4FromDb ? last4FromDb.slice(-4) : ''),
      accountNumberMasked: finalMasked,
    };

    return res.render('business-profile', {
      title: 'Business Profile',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      baseCurrency: BASE_CURRENCY,
      formatMoney: formatBusinessMoney,
    });
  } catch (err) {
    console.error('❌ Business profile error:', err);
    req.flash('error', 'Failed to load profile.');
    return res.redirect('/business/dashboard');
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Business Details ONLY (GET)
 * Renders: views/business-profile-edit-details.ejs
 * URL: /business/profile/edit-details
 * -------------------------------------------------------- */
router.get('/profile/edit-details', requireBusiness, async (req, res) => {
  try {
    const bizId = req.business?._id;
    if (!bizId || !mongoose.isValidObjectId(bizId)) {
      req.flash('error', 'Please log in again.');
      return res.redirect('/business/login');
    }

    // IMPORTANT: do NOT use toSafeJSON() here, because edit form needs real values
    // Also: lean() is fine here (we only need to display data)
    const business = await Business.findById(bizId)
      .select(
        [
          'name email role phone country countryCode city state postalCode addressLine1 addressLine2 address',
          'officialNumber officialNumberType',
          'verification isVerified',
          'logoUrl',
          'payouts',
        ].join(' '),
      )
      .lean();

    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    // Ensure payouts object exists (matches your schema defaults)
    business.payouts = business.payouts || { enabled: false, paypalEmail: '', updatedAt: null };

    return res.render('business-profile-edit-details', {
      title: 'Edit Business Details',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ GET /business/profile/edit-details error:', err);
    req.flash('error', 'Failed to load business details page.');
    return res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 📝 Update Business Details ONLY (POST)
 * action="/business/profile/update-details"
 * Updates ONLY:
 * - name, email, phone, country, city, address
 * - officialNumber, officialNumberType
 * - payouts.enabled + payouts.paypalEmail (via applyPaypalPayouts)
 * -------------------------------------------------------- */
router.post(
  '/profile/update-details',
  requireBusiness,
  businessLogoUpload.single('logo'),
  async (req, res) => {
    let newLogoUrl = '';

    try {
      const bizId = String(req.business?._id || '').trim();
      if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
        console.log('✅ HIT POST /business/profile/update-details');
        console.log('BODY:', req.body);
      }

      // Load business doc (this is the single source of truth)
      const business = await Business.findById(bizId).select(
        [
          'name email phone logoUrl',
          'country countryCode city state postalCode addressLine1 addressLine2 address',
          'officialNumber officialNumberType',
          'payouts verification isVerified',
          'emailVerifiedAt emailVerificationToken emailVerificationExpires verificationEmailSentAt',
        ].join(' '),
      );

      if (!business) {
        req.flash('error', 'Business not found. Please log in again.');
        return res.redirect('/business/login');
      }

      // Use existing values from the loaded doc
      const existingEmail = normalizeEmail(business.email);
      const existingPaypalEmail = String(business?.payouts?.paypalEmail || '').trim();

      // ---- Pick + sanitize (BODY first, fallback to DB so form can still save) ----
      const name = String(req.body?.name ?? business.name ?? '').trim();

      const emailRaw = String(req.body?.email ?? business.email ?? '').trim();
      const email = normalizeEmail(emailRaw);

      const phone = String(req.body?.phone ?? business.phone ?? '').trim();

      // ✅ Human readable (legacy)
      const country = String(req.body?.country ?? business.country ?? '').trim();

      // ✅ Shippo-ready structured fields (fallback to DB values)
      const countryCode = String(req.body?.countryCode ?? business.countryCode ?? '')
        .trim()
        .toUpperCase();

      const city = String(req.body?.city ?? business.city ?? '').trim();
      const state = String(req.body?.state ?? business.state ?? '').trim();
      const postalCode = String(req.body?.postalCode ?? business.postalCode ?? '').trim();

      // Accept BOTH naming styles:
      // - new: addressLine1/addressLine2
      // - EJS: street1/street2
      const addressLine1 = String(
        req.body?.addressLine1 ?? req.body?.street1 ?? business.addressLine1 ?? '',
      ).trim();

      const addressLine2 = String(
        req.body?.addressLine2 ?? req.body?.street2 ?? business.addressLine2 ?? '',
      ).trim();

      // ✅ Legacy combined address
      const address = `${addressLine1}${addressLine2 ? `, ${addressLine2}` : ''}`.trim();

      const officialNumber = String(
        req.body?.officialNumber ?? business.officialNumber ?? '',
      ).trim();
      const officialNumberType = String(
        req.body?.officialNumberType ?? business.officialNumberType ?? 'OTHER',
      ).trim();

      // payoutsEnabled comes as "0", "1", or ["0","1"]
      const peRaw = req.body?.payoutsEnabled;
      const payoutsOn = Array.isArray(peRaw)
        ? peRaw.includes('1') || peRaw.includes('on') || peRaw.includes('true')
        : ['1', 'on', 'true', 'yes'].includes(
            String(peRaw || '')
              .trim()
              .toLowerCase(),
          );

      // paypalEmail may be missing when input is disabled
      const paypalFromBodyExists = Object.prototype.hasOwnProperty.call(
        req.body || {},
        'paypalEmail',
      );
      const paypalEmailRaw = paypalFromBodyExists
        ? String(req.body.paypalEmail || '').trim()
        : existingPaypalEmail;

      // ---- Required field checks ----
      // ✅ Required (Shippo-ready + legacy)
      if (!name || !email || !phone || !country || !officialNumber) {
        req.flash('error', 'Please fill in all required fields.');
        return res.redirect('/business/profile/edit-details');
      }

      // ✅ Shippo-ready required fields
      if (!countryCode || countryCode.length !== 2) {
        req.flash('error', 'Country code must be 2 letters (ISO 2), e.g., ZA, US.');
        return res.redirect('/business/profile/edit-details');
      }

      if (!city || !postalCode || !addressLine1) {
        req.flash('error', 'Please fill in your City, Postal Code, and Address Line 1.');
        return res.redirect('/business/profile/edit-details');
      }

      // ✅ Same rule as /signup
      if (countryCode === 'US' && !state) {
        req.flash('error', 'State is required for US addresses.');
        return res.redirect('/business/profile/edit-details');
      }

      // ---- Validate officialNumberType ----
      const allowedTypes = ['CIPC_REG', 'VAT', 'TIN', 'OTHER'];
      if (!allowedTypes.includes(officialNumberType)) {
        req.flash('error', 'Invalid official number type.');
        return res.redirect('/business/profile/edit-details');
      }

      // ---- Email uniqueness if changed ----
      const emailChanged = email !== existingEmail;

      if (emailChanged) {
        const exists = await Business.findOne({ email, _id: { $ne: bizId } }).lean();
        if (exists) {
          req.flash('error', 'That email is already used by another business account.');
          return res.redirect('/business/profile/edit-details');
        }
      }

      // ---- Official number change => reset verification status ----
      const currentOfficial = String(business.officialNumber || '').trim();
      const officialChanged = officialNumber !== currentOfficial;

      // ---- Optional logo replacement ----
      const oldLogoUrl = String(business.logoUrl || '').trim();

      if (req.file) {
        try {
          newLogoUrl = await uploadBusinessLogoToS3(req.file);
        } catch (err) {
          console.error('❌ Business logo upload failed during edit-details:', err);
          req.flash('error', 'Business logo upload failed. Please try again.');
          return res.redirect('/business/profile/edit-details');
        }
      }

      // ---- PayPal payouts: use the SAME helper as /signup ----
      const applied = applyPaypalPayouts(business, paypalEmailRaw, payoutsOn);
      if (!applied || applied.ok !== true) {
        req.flash('error', applied?.error || 'Invalid PayPal payouts settings.');
        return res.redirect('/business/profile/edit-details');
      }

      // ---- Apply allowed fields on the doc ----
      business.name = name;
      business.phone = phone;

      // ✅ Shippo-ready structured address (single source of truth for shipping)
      business.countryCode = countryCode;
      business.city = city;
      business.state = state; // may be empty for non-US
      business.postalCode = postalCode;
      business.addressLine1 = addressLine1;
      business.addressLine2 = addressLine2;

      // ✅ Legacy fields (do NOT break other pages)
      business.country = country; // human readable legacy
      business.address = address; // combined legacy

      business.officialNumber = officialNumber;
      business.officialNumberType = officialNumberType;

      if (newLogoUrl) {
        business.logoUrl = newLogoUrl;
      }

      // ---- If email changed: require re-verify + set token (DECLARE ONCE) ----
      let token = null;
      if (emailChanged) {
        token = crypto.randomBytes(32).toString('hex');
        business.email = email;

        business.isVerified = false;
        business.emailVerifiedAt = null;

        business.emailVerificationToken = token;
        business.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        business.verificationEmailSentAt = new Date();
      }

      // ---- Official number change => reset verification status ----
      if (officialChanged) {
        business.verification = business.verification || {};
        business.verification.status = 'pending';
        business.verification.reason = '';
        business.verification.updatedAt = new Date();
      }

      // Save
      await business.save();

      if (newLogoUrl && oldLogoUrl && oldLogoUrl !== newLogoUrl) {
        await deleteS3ImageByUrl(oldLogoUrl);
      }

      // ---- Keep session in sync ----
      if (!req.session.business) req.session.business = {};

      req.session.business.name = business.name;
      req.session.business.email = business.email;
      req.session.business.phone = business.phone || '';
      req.session.business.isVerified = business.isVerified;
      req.session.business.payouts = {
        enabled: business.payouts?.enabled === true,
        paypalEmail: business.payouts?.paypalEmail || '',
      };

      // ✅ keep address fields in session too (prevents “old profile data” issues)
      req.session.business.country = business.country || '';
      req.session.business.countryCode = business.countryCode || '';
      req.session.business.city = business.city || '';
      req.session.business.state = business.state || '';
      req.session.business.postalCode = business.postalCode || '';
      req.session.business.addressLine1 = business.addressLine1 || '';
      req.session.business.addressLine2 = business.addressLine2 || '';
      req.session.business.address = business.address || '';

      // ---- If email changed, send verification mail ----
      if (emailChanged) {
        try {
          await sendBusinessVerificationEmail(business, token, req);
          req.flash('success', '✅ Details saved. Please verify your new email address.');
        } catch (mailErr) {
          console.error(
            '❌ send verification after email change failed:',
            mailErr?.response?.body || mailErr?.message || mailErr,
          );
          req.flash(
            'warning',
            'Details saved, but we could not send the verification email. Use “Resend verification”.',
          );
        }
        return res.redirect('/business/verify-pending');
      }

      req.flash('success', '✅ Business details updated.');
      return res.redirect('/business/profile');
    } catch (err) {
      if (newLogoUrl) {
        await deleteS3ImageByUrl(newLogoUrl);
      }

      console.error('❌ POST /business/profile/update-details error:', err);
      req.flash('error', err?.message || 'Failed to update business details.');
      return res.redirect('/business/profile/edit-details');
    }
  },
);

/* ----------------------------------------------------------
 * 🗑️ Delete Profile
 * -------------------------------------------------------- */
router.get('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const bizId = getBizId(req);
    if (!bizId) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(bizId).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    return res.render('business-delete', {
      title: 'Delete Business Account',
      business,
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      verificationToken: '',
      csrfToken: req.csrfToken ? req.csrfToken() : '',

      // ✅ so the page can show messages
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error('❌ Delete profile render error:', err);
    req.flash('error', 'Failed to load delete confirmation page.');
    return res.redirect('/business/profile');
  }
});

router.post('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const businessId =
      req.session.business && req.session.business._id ? req.session.business._id : null;

    if (!businessId) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    // ✅ NEW: stop deletion if business still has products
    const hasProducts = await Product.exists({ business: businessId });
    if (hasProducts) {
      req.flash(
        'error',
        'Deletion failed: your account still have products. If you really want to delete this account you must go to your dashboard delete its product first here: /products/all',
      );
      return res.redirect('/business/profile/delete');
    }

    const password = String(req.body.password || '').trim();
    if (!password) {
      req.flash('error', 'Please enter your password to confirm deletion.');
      return res.redirect('/business/profile/delete');
    }

    // Load business + password hash (your schema might have select:false)
    const business = await Business.findById(businessId).select('+password');
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    const bcrypt = require('bcrypt');
    const ok = await bcrypt.compare(password, String(business.password || ''));
    if (!ok) {
      req.flash('error', 'Incorrect password. Deletion cancelled.');
      return res.redirect('/business/profile/delete');
    }

    await Business.findByIdAndDelete(businessId);

    const message = '✅ Business account deleted.';

    req.session.regenerate((err) => {
      if (err) {
        console.error('❌ Delete business session regenerate error:', err);
        return res.redirect('/');
      }

      req.flash('success', message);
      res.clearCookie('connect.sid');
      return res.redirect('/business/login');
    });
  } catch (err) {
    console.error('❌ Delete business error:', err);
    req.flash('error', 'Failed to delete account.');
    return res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 📊 ANALYTICS CHART DASHBOARD (per business)
 * -------------------------------------------------------- */

router.get('/analytics/chart', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
    if (!sessionBusiness || !sessionBusiness._id) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const business = await Business.findById(sessionBusiness._id).lean();
    if (!business) {
      req.flash('error', 'Business not found. Please log in again.');
      return res.redirect('/business/login');
    }

    const activeProducts = await Product.countDocuments({
      business: business._id,
      stock: { $gt: 0 },
    });

    res.render('business-chart', {
      title: `${business.name} - Analytics Dashboard`,
      business: {
        ...business,
        activeProducts,
      },
      active: 'analytics',
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      baseCurrency: BASE_CURRENCY,
      formatMoney: formatBusinessMoney,
    });
  } catch (err) {
    console.error('❌ Analytics chart dashboard error:', err);
    req.flash('error', 'Failed to load analytics dashboard.');
    res.redirect('/business/dashboard');
  }
});

// ----------------------------------------------------------
// 📊 ANALYTICS CHART DATA API (per business only)
// ✅ IGNORES refunded/cancelled orders AND refunded items
// ✅ Uses buildNonRefundedPaidMatch(OrderModel, extra) that exists ONCE above
// ----------------------------------------------------------
router.get('/analytics/chart-data', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const sessionBusiness = getBiz(req);
    if (!sessionBusiness || !sessionBusiness._id) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const OrderModel = Order;
    if (!OrderModel) {
      return res.status(500).json({ success: false, message: 'Order model not available' });
    }

    const businessId = sessionBusiness._id;
    const now = new Date();

    // ----------------------------
    // 1) Load THIS business products
    // ----------------------------
    const products = await Product.find({ business: businessId })
      .select('customId name price stock soldCount _id')
      .lean();

    // Build keys set (supports BOTH customId and _id matching)
    const productKeys = products
      .flatMap((p) => {
        const keys = [];
        if (p?.customId) keys.push(String(p.customId).trim());
        if (p?._id) keys.push(String(p._id).trim());
        return keys;
      })
      .filter(Boolean);

    const productKeySet = new Set(productKeys);

    // Active products count (stock > 0)
    const activeProducts = products.filter((p) => (Number(p.stock) || 0) > 0).length;

    // Price lookup map for fast revenue calculation
    const productPriceByKey = new Map();
    for (const p of products) {
      const price = Number(p?.price || 0) || 0;
      if (p?.customId) productPriceByKey.set(String(p.customId).trim(), price);
      if (p?._id) productPriceByKey.set(String(p._id).trim(), price);
    }

    // If no products, return zero chart
    if (productKeys.length === 0) {
      const dailyData = [];
      const monthlyData = [];
      const yearlyData = [];

      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        dailyData.push({
          date: d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }),
          sales: 0,
          orders: 0,
        });
      }

      for (let i = 29; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        monthlyData.push({
          date: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
          sales: 0,
          orders: 0,
        });
      }

      for (let i = 11; i >= 0; i--) {
        const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
        yearlyData.push({
          month: m.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }),
          sales: 0,
          orders: 0,
        });
      }

      return res.json({
        success: true,
        chartData: { daily: dailyData, monthly: monthlyData, yearly: yearlyData, custom: [] },
        metrics: {
          totalRevenue: 0,
          totalOrders: 0,
          avgOrderValue: 0,
          activeProducts,
          revenueChange: 0,
          ordersChange: 0,
          avgOrderChange: 0,
        },
        productPerformance: [],
        lastUpdated: new Date().toISOString(),
      });
    }

    // ----------------------------
    // 2) Helpers
    // ----------------------------
    const idMatchOr = [
      { 'items.productId': { $in: productKeys } },
      { 'items.customId': { $in: productKeys } },
      { 'items.pid': { $in: productKeys } },
      { 'items.sku': { $in: productKeys } },
    ];

    function moneyToNumber(m) {
      if (!m) return 0;
      if (typeof m === 'number') return m;
      if (typeof m === 'string') return Number(m) || 0;
      if (typeof m === 'object' && m.value !== undefined) return Number(m.value) || 0;
      return 0;
    }

    function isRefundedItem(item) {
      if (!item) return false;
      if (item.isRefunded === true) return true;

      const rs = String(item.refundStatus || '')
        .trim()
        .toUpperCase();
      if (rs === 'REFUNDED' || rs === 'FULL' || rs === 'FULLY_REFUNDED' || rs === 'COMPLETED')
        return true;

      if (item.refundedAt) return true;
      return false;
    }

    // revenue for THIS business from an order (ignore refunded items)
    function computeSellerAmount(order) {
      let sellerAmount = 0;
      if (!Array.isArray(order.items)) return 0;

      for (const item of order.items) {
        if (isRefundedItem(item)) continue;

        const pid = String(item.productId || item.customId || item.pid || item.sku || '').trim();
        if (!pid || !productKeySet.has(pid)) continue;

        const qty = Number(item.quantity || 1);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        const unitFromItem = moneyToNumber(item.price);
        const unitFromProduct = productPriceByKey.get(pid) || 0;

        const unit = unitFromItem || unitFromProduct;
        const line = qty * unit;

        if (line > 0) sellerAmount += line;
      }

      return sellerAmount;
    }

    // Use your shared refund/cancel exclusion helper
    function buildBaseMatch(extra = {}) {
      return buildNonRefundedPaidMatch(OrderModel, {
        ...extra,
        $or: idMatchOr,
      });
    }

    // Date keys (UTC-based, stable)
    const dayKey = (d) => new Date(d).toISOString().slice(0, 10); // YYYY-MM-DD
    const monthKey = (d) => new Date(d).toISOString().slice(0, 7); // YYYY-MM

    // ----------------------------
    // 3) Pull orders ONCE for last 30 days (covers daily + monthly)
    // ----------------------------
    const start30 = new Date(now);
    start30.setDate(start30.getDate() - 29);
    start30.setHours(0, 0, 0, 0);

    const orders30 = await OrderModel.find(buildBaseMatch({ createdAt: { $gte: start30 } }))
      .select('createdAt items status refundStatus isRefunded refundedAt')
      .lean();

    const salesByDay = new Map(); // YYYY-MM-DD -> { sales, orders }
    for (const o of orders30) {
      const amt = computeSellerAmount(o);
      if (amt <= 0) continue; // if all items refunded, don’t count order

      const k = dayKey(o.createdAt || now);
      const cur = salesByDay.get(k) || { sales: 0, orders: 0 };
      cur.sales += amt;
      cur.orders += 1;
      salesByDay.set(k, cur);
    }

    // Build monthlyData (last 30 days)
    const monthlyData = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      const v = salesByDay.get(k) || { sales: 0, orders: 0 };

      monthlyData.push({
        date: d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
        sales: Math.round((v.sales || 0) * 100) / 100,
        orders: Number(v.orders || 0),
      });
    }

    // Build dailyData (last 7 days)
    const dailyData = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      const v = salesByDay.get(k) || { sales: 0, orders: 0 };

      dailyData.push({
        date: d.toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric' }),
        sales: Math.round((v.sales || 0) * 100) / 100,
        orders: Number(v.orders || 0),
      });
    }

    // ----------------------------
    // 4) Pull orders ONCE for last 12 months (yearly)
    // ----------------------------
    const start12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    start12.setHours(0, 0, 0, 0);

    const orders12 = await OrderModel.find(buildBaseMatch({ createdAt: { $gte: start12 } }))
      .select('createdAt items status refundStatus isRefunded refundedAt')
      .lean();

    const salesByMonth = new Map(); // YYYY-MM -> { sales, orders }
    for (const o of orders12) {
      const amt = computeSellerAmount(o);
      if (amt <= 0) continue;

      const k = monthKey(o.createdAt || now);
      const cur = salesByMonth.get(k) || { sales: 0, orders: 0 };
      cur.sales += amt;
      cur.orders += 1;
      salesByMonth.set(k, cur);
    }

    const yearlyData = [];
    for (let i = 11; i >= 0; i--) {
      const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = monthKey(m);
      const v = salesByMonth.get(k) || { sales: 0, orders: 0 };

      yearlyData.push({
        month: m.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' }),
        sales: Math.round((v.sales || 0) * 100) / 100,
        orders: Number(v.orders || 0),
      });
    }

    // ----------------------------
    // 5) Metrics
    // ----------------------------
    const totalRevenue = yearlyData.reduce((sum, m) => sum + (Number(m.sales) || 0), 0);
    const totalOrders = yearlyData.reduce((sum, m) => sum + (Number(m.orders) || 0), 0);
    const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

    const lastIdx = yearlyData.length - 1;
    const prevIdx = lastIdx - 1;

    const currentMonthRevenue = lastIdx >= 0 ? yearlyData[lastIdx].sales : 0;
    const previousMonthRevenue = prevIdx >= 0 ? yearlyData[prevIdx].sales : 0;

    const revenueChange =
      previousMonthRevenue > 0
        ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100
        : 0;

    const currentMonthOrders = lastIdx >= 0 ? yearlyData[lastIdx].orders : 0;
    const previousMonthOrders = prevIdx >= 0 ? yearlyData[prevIdx].orders : 0;

    const ordersChange =
      previousMonthOrders > 0
        ? ((currentMonthOrders - previousMonthOrders) / previousMonthOrders) * 100
        : 0;

    const currentAvg = currentMonthOrders > 0 ? currentMonthRevenue / currentMonthOrders : 0;
    const previousAvg = previousMonthOrders > 0 ? previousMonthRevenue / previousMonthOrders : 0;

    const avgOrderChange = previousAvg > 0 ? ((currentAvg - previousAvg) / previousAvg) * 100 : 0;

    // ----------------------------
    // 6) Product performance (top 5) - same behavior as before
    // ----------------------------
    const productPerformance = [];

    if (products.length > 0) {
      const topProducts = products
        .filter((p) => (p.soldCount || 0) > 0)
        .sort((a, b) => (b.soldCount || 0) - (a.soldCount || 0))
        .slice(0, 5);

      if (topProducts.length > 0) {
        topProducts.forEach((product) => {
          const nm = String(product.name || '');
          const name = nm.length > 15 ? nm.substring(0, 15) + '...' : nm;
          productPerformance.push({ name, sales: product.soldCount || 0 });
        });
      } else {
        const inStockProducts = products
          .filter((p) => (Number(p.stock) || 0) > 0)
          .sort((a, b) => (Number(b.stock) || 0) - (Number(a.stock) || 0))
          .slice(0, 5);

        if (inStockProducts.length > 0) {
          inStockProducts.forEach((product) => {
            const nm = String(product.name || '');
            const name = nm.length > 15 ? nm.substring(0, 15) + '...' : nm;
            productPerformance.push({ name, sales: Number(product.stock) || 0 });
          });
        } else {
          productPerformance.push(
            { name: 'No products yet', sales: 1 },
            { name: 'Add products', sales: 1 },
          );
        }
      }
    }

    // Final response
    return res.json({
      success: true,
      chartData: { daily: dailyData, monthly: monthlyData, yearly: yearlyData, custom: [] },
      metrics: {
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        activeProducts,
        revenueChange: Math.round(revenueChange * 10) / 10,
        ordersChange: Math.round(ordersChange * 10) / 10,
        avgOrderChange: Math.round(avgOrderChange * 10) / 10,
      },
      productPerformance,
      lastUpdated: new Date().toISOString(),
    });
  } catch (error) {
    console.error('❌ Chart data API error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch chart data',
      error: error.message,
    });
  }
});

router.use((err, req, res, next) => {
  if (!err) return next();

  console.error('❌ businessAuth upload error:', err.message);

  if (
    err instanceof multer.MulterError ||
    String(err.message || '').includes('Only PNG/JPG/WEBP/GIF/BMP images are allowed')
  ) {
    req.flash('error', err.message || 'Business logo upload failed.');

    return res.status(400).render('business-signup', {
      title: 'Business Sign Up',
      active: 'business-signup',
      errors: [{ msg: err.message || 'Business logo upload failed.', param: 'logo' }],
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      ...req.body,
      representative: {
        fullName: pickField(req.body, 'representative.fullName', ''),
        phone: pickField(req.body, 'representative.phone', ''),
        idNumber: pickField(req.body, 'representative.idNumber', ''),
      },
    });
  }

  return next(err);
});

module.exports = router;
