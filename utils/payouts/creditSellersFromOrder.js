// utils/payouts/creditSellersFromOrder.js
'use strict';

const mongoose = require('mongoose');
const SellerBalanceLedger = require('../../models/SellerBalanceLedger');

let Product = null;
try {
  Product = require('../../models/Product');
} catch {
  // optional
}

const { moneyToCents } = require('../money');

function getBaseCurrency() {
  return (
    String(process.env.BASE_CURRENCY || '').trim().toUpperCase() ||
    'USD'
  );
}

function toUpper(v, fallback = null) {
  const s = String(v || '').trim().toUpperCase();
  return s || (fallback || getBaseCurrency());
}

function safeId(v) {
  const raw = v?._id || v;
  const id = String(raw || '').trim();
  return mongoose.isValidObjectId(id) ? id : null;
}

function toObjectId(v) {
  const id = safeId(v);
  return id ? new mongoose.Types.ObjectId(id) : null;
}

function getProductOwnerBusinessId(p) {
  const candidates = [
    p?.business?._id, p?.business,
    p?.businessId?._id, p?.businessId,
    p?.seller?._id, p?.seller,
    p?.sellerId?._id, p?.sellerId,
    p?.ownerBusiness?._id, p?.ownerBusiness,
    p?.ownerBusinessId?._id, p?.ownerBusinessId,
  ];

  for (const c of candidates) {
    const id = safeId(c);
    if (id) return id;
  }

  return null;
}

function getSourceSupplierId(p) {
  const candidates = [
    p?.sourceSupplier?._id,
    p?.sourceSupplier,
  ];

  for (const c of candidates) {
    const id = safeId(c);
    if (id) return id;
  }

  return null;
}

function isWholesaleImportedProduct(product) {
  return (
    String(product?.sourceType || '').trim() === 'wholesale_import' &&
    !!getSourceSupplierId(product)
  );
}

function isPaidLikeNormalized(order) {
  const s = String(order?.status || '').trim();
  if (!s) return false;

  const up = s.toUpperCase();
  if (['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'].includes(up)) return true;

  if (typeof order?.isPaidLike === 'function') {
    try {
      return !!order.isPaidLike();
    } catch {
      return false;
    }
  }

  return false;
}

function payoutDelayMs() {
  const daysRaw = Number(process.env.SELLER_PAYOUT_DELAY_DAYS ?? 2);
  const days = Number.isFinite(daysRaw)
    ? Math.max(0, Math.min(30, Math.trunc(daysRaw)))
    : 3;

  return days * 24 * 60 * 60 * 1000;
}

function normalizeItemCurrency(item, fallbackOrderCurrency) {
  const raw =
    item?.price?.currency ??
    item?.currency ??
    item?.amount?.currency ??
    fallbackOrderCurrency;

  return toUpper(raw, fallbackOrderCurrency || getBaseCurrency());
}

function getItemUnitCents(item) {
  // IMPORTANT:
  // Keep this compatible with your existing seller payout flow.
  // Your Order model stores item.price as the payout/net unit snapshot.
  const raw =
    item?.price?.value ??
    item?.price?.amount ??
    item?.unitPrice?.value ??
    item?.unitPrice ??
    item?.amount?.value ??
    item?.amount ??
    item?.price;

  const cents = moneyToCents(raw);
  return Number.isFinite(cents) ? cents : NaN;
}

function getWholesaleCostCents(product) {
  const cents = moneyToCents(product?.wholesaleCostPrice || 0);
  return Number.isFinite(cents) && cents > 0 ? cents : 0;
}

function getQty(item) {
  const qtyRaw = Number(item?.quantity != null ? item.quantity : 1);
  return Number.isFinite(qtyRaw) ? Math.max(1, Math.trunc(qtyRaw)) : 1;
}

function isDupKey(err) {
  return !!(
    err &&
    (err.code === 11000 || String(err.message || '').includes('E11000'))
  );
}

function addAggRow(agg, row) {
  if (!row?.businessObjId || !row?.businessIdStr || !row?.productKey) return;
  if (!row.netCents || row.netCents <= 0) return;

  const role = row.role || 'seller';
  const key = `${row.businessIdStr}:${row.productKey}:${role}`;

  const prev = agg.get(key) || {
    businessObjId: row.businessObjId,
    businessIdStr: row.businessIdStr,
    productKey: row.productKey,
    role,
    qty: 0,
    grossCents: 0,
    supplierCostCents: 0,
    marginCents: 0,
    feeCents: 0,
    netCents: 0,
    sourceSupplierProduct: row.sourceSupplierProduct || null,
    sourceSupplyRequest: row.sourceSupplyRequest || null,
  };

  prev.qty += Number(row.qty || 0);
  prev.grossCents += Number(row.grossCents || 0);
  prev.supplierCostCents += Number(row.supplierCostCents || 0);
  prev.marginCents += Number(row.marginCents || 0);
  prev.feeCents += Number(row.feeCents || 0);
  prev.netCents += Number(row.netCents || 0);

  agg.set(key, prev);
}

async function creditSellersFromOrder(order, opts = {}) {
  const {
    platformFeeBps = 1000,
    onlyIfPaidLike = false,
  } = opts;

  if (!order) return { credited: 0, skipped: 'no-order' };

  if (onlyIfPaidLike && !isPaidLikeNormalized(order)) {
    return { credited: 0, skipped: 'not-paid' };
  }

  if (!Product) return { credited: 0, skipped: 'product-model-missing' };

  const orderId = safeId(order?._id);
  if (!orderId) return { credited: 0, skipped: 'missing-order-_id' };

  const items = Array.isArray(order.items) ? order.items : [];
  if (!items.length) return { credited: 0, skipped: 'no-items' };

  const feeBps = Math.max(0, Math.min(5000, Number(platformFeeBps || 0)));

  const orderCurrency = toUpper(
    order?.amount?.currency ||
    order?.breakdown?.currency ||
    order?.capture?.amount?.currency ||
    getBaseCurrency()
  );

  const customIds = new Set();
  const objectIds = [];

  for (const item of items) {
    const rawPid = item?.productId?._id || item?.productId || item?.product || item?.product?._id;
    const pidStr = String(rawPid || '').trim();
    if (!pidStr) continue;

    if (mongoose.isValidObjectId(pidStr)) {
      objectIds.push(new mongoose.Types.ObjectId(pidStr));
    }

    customIds.add(pidStr);
  }

  if (!customIds.size && !objectIds.length) {
    return { credited: 0, skipped: 'no-productIds' };
  }

  const products = await Product.find({
    $or: [
      { customId: { $in: [...customIds] } },
      ...(objectIds.length ? [{ _id: { $in: objectIds } }] : []),
    ],
  })
    .select(
      [
        '_id customId',
        'business businessId seller sellerId ownerBusiness ownerBusinessId',
        'sourceType sourceSupplier sourceSupplierProduct sourceSupplyRequest wholesaleCostPrice',
      ].join(' ')
    )
    .lean();

  if (!products.length) {
    return {
      credited: 0,
      skipped: 'products-not-found',
      debug: {
        customIdsCount: customIds.size,
        objectIdsCount: objectIds.length,
      },
    };
  }

  const byKey = new Map();

  for (const p of products) {
    if (p?.customId) byKey.set(String(p.customId), p);
    if (p?._id) byKey.set(String(p._id), p);
  }

  const agg = new Map();
  let mixedCurrencyDetected = false;
  let importedLines = 0;
  let normalLines = 0;

  for (const item of items) {
    const rawPid = item?.productId?._id || item?.productId || item?.product || item?.product?._id;
    const pidKey = String(rawPid || '').trim();
    if (!pidKey) continue;

    const product = byKey.get(pidKey);
    if (!product) continue;

    const sellerBusinessIdStr = getProductOwnerBusinessId(product);
    const sellerBusinessObjId = toObjectId(sellerBusinessIdStr);
    if (!sellerBusinessObjId) continue;

    const qty = getQty(item);

    const unitCents = getItemUnitCents(item);
    if (!Number.isFinite(unitCents) || unitCents <= 0) continue;

    const itemCurrency = normalizeItemCurrency(item, orderCurrency);
    if (itemCurrency !== orderCurrency) {
      mixedCurrencyDetected = true;
      continue;
    }

    const grossCents = unitCents * qty;
    if (!Number.isFinite(grossCents) || grossCents <= 0) continue;

    const productKey = String(product.customId || product._id);

    if (isWholesaleImportedProduct(product)) {
      importedLines += 1;

      const supplierBusinessIdStr = getSourceSupplierId(product);
      const supplierBusinessObjId = toObjectId(supplierBusinessIdStr);

      const wholesaleCostUnitCents = getWholesaleCostCents(product);
      const wantedSupplierCents = wholesaleCostUnitCents * qty;

      // Supplier must never receive more than this paid line can cover.
      const supplierNetCents = Math.min(grossCents, wantedSupplierCents);

      if (supplierBusinessObjId && supplierNetCents > 0) {
        addAggRow(agg, {
          role: 'supplier',
          businessObjId: supplierBusinessObjId,
          businessIdStr: String(supplierBusinessIdStr),
          productKey,
          qty,
          grossCents,
          supplierCostCents: supplierNetCents,
          marginCents: 0,
          feeCents: 0,
          netCents: supplierNetCents,
          sourceSupplierProduct: product.sourceSupplierProduct || null,
          sourceSupplyRequest: product.sourceSupplyRequest || null,
        });
      }

      const sellerMarginCents = Math.max(0, grossCents - supplierNetCents);
      const sellerFeeCents = Math.round((sellerMarginCents * feeBps) / 10000);
      const sellerNetCents = Math.max(0, sellerMarginCents - sellerFeeCents);

      if (sellerNetCents > 0) {
        addAggRow(agg, {
          role: 'seller',
          businessObjId: sellerBusinessObjId,
          businessIdStr: String(sellerBusinessIdStr),
          productKey,
          qty,
          grossCents,
          supplierCostCents: supplierNetCents,
          marginCents: sellerMarginCents,
          feeCents: sellerFeeCents,
          netCents: sellerNetCents,
          sourceSupplierProduct: product.sourceSupplierProduct || null,
          sourceSupplyRequest: product.sourceSupplyRequest || null,
        });
      }

      continue;
    }

    normalLines += 1;

    const feeCents = Math.round((grossCents * feeBps) / 10000);
    const netCents = grossCents - feeCents;
    if (!Number.isFinite(netCents) || netCents <= 0) continue;

    addAggRow(agg, {
      role: 'seller',
      businessObjId: sellerBusinessObjId,
      businessIdStr: String(sellerBusinessIdStr),
      productKey,
      qty,
      grossCents,
      supplierCostCents: 0,
      marginCents: grossCents,
      feeCents,
      netCents,
    });
  }

  const wanted = [];

  for (const row of agg.values()) {
    if (!row.netCents || row.netCents <= 0) continue;

    const uniqueKey = `earn:${String(orderId)}:${row.productKey}:${row.businessIdStr}:${row.role}`;

    const roleLabel = row.role === 'supplier' ? 'Supplier' : 'Seller';

    wanted.push({
      businessId: row.businessObjId,
      type: 'EARNING',
      amountCents: Math.trunc(row.netCents),
      currency: orderCurrency,
      availableAt: new Date(Date.now() + payoutDelayMs()),
      orderId: new mongoose.Types.ObjectId(orderId),
      note: `${roleLabel} net earnings for order ${order.orderId || String(orderId)} (${row.productKey})`,
      meta: {
        uniqueKey,
        payoutRole: row.role,
        productCustomId: row.productKey,
        qty: row.qty,
        grossCents: Math.trunc(row.grossCents),
        supplierCostCents: Math.trunc(row.supplierCostCents),
        marginCents: Math.trunc(row.marginCents),
        feeCents: Math.trunc(row.feeCents),
        platformFeeBps: feeBps,
        sourceSupplierProduct: row.sourceSupplierProduct
          ? String(row.sourceSupplierProduct?._id || row.sourceSupplierProduct)
          : '',
        sourceSupplyRequest: row.sourceSupplyRequest
          ? String(row.sourceSupplyRequest?._id || row.sourceSupplyRequest)
          : '',
      },
    });
  }

  if (!wanted.length) {
    return {
      credited: 0,
      skipped: 'no-creditable-items',
      debug: {
        mixedCurrencyDetected,
        itemsCount: items.length,
        productsFound: products.length,
        importedLines,
        normalLines,
      },
    };
  }

  const ops = wanted.map((w) => ({
    updateOne: {
      filter: {
        businessId: w.businessId,
        type: 'EARNING',
        orderId: w.orderId,
        'meta.uniqueKey': w.meta.uniqueKey,
      },
      update: {
        $setOnInsert: {
          amountCents: w.amountCents,
          currency: w.currency,
          availableAt: w.availableAt,
          note: w.note,
          meta: {
            ...w.meta,
            orderPublicId: String(order.orderId || orderId),
          },
        },
      },
      upsert: true,
    },
  }));

  let upsertedCount = 0;

  try {
    const wr = await SellerBalanceLedger.bulkWrite(ops, { ordered: false });
    upsertedCount = Number(wr?.upsertedCount || 0);
  } catch (e) {
    if (!isDupKey(e)) throw e;
    upsertedCount = 0;
  }

  if (!upsertedCount) {
    return {
      credited: 0,
      skipped: 'all-already-credited',
      debug: {
        wanted: wanted.length,
        importedLines,
        normalLines,
      },
      currency: orderCurrency,
      feeBps,
      mixedCurrencyDetected,
    };
  }

  return {
    credited: upsertedCount,
    currency: orderCurrency,
    feeBps,
    mixedCurrencyDetected,
    importedLines,
    normalLines,
  };
}

module.exports = { creditSellersFromOrder };