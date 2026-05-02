// \utils\payment\resolveShippoFromAddressForCart.js
'use strict';

const { resolveWarehouseForCart, publicWarehouseMeta } = require('./resolveWarehouseForCart');

function pickDefaultBizId(product) {
  return (
    product?.businessId ||
    product?.sellerId ||
    product?.seller ||
    product?.ownerBusiness ||
    product?.business ||
    null
  );
}

function attachFromMeta(from, meta = {}) {
  if (!from || typeof from !== 'object') return from;

  Object.defineProperty(from, '_fromMeta', {
    value: meta,
    enumerable: false,
    configurable: true,
  });

  return from;
}

async function resolvePlatformWarehouseFromAddress(cart, deps = {}) {
  const {
    to,
    Warehouse,
    buildShippoAddressFromWarehouse,
    getShippoFromAddress,
  } = deps;

  const envFrom = getShippoFromAddress();

  if (!Warehouse || typeof Warehouse.findOne !== 'function') {
    return attachFromMeta(envFrom, {
      source: 'env',
      reason: 'WAREHOUSE_MODEL_NOT_AVAILABLE',
    });
  }

  if (typeof buildShippoAddressFromWarehouse !== 'function') {
    return attachFromMeta(envFrom, {
      source: 'env',
      reason: 'WAREHOUSE_ADDRESS_BUILDER_NOT_AVAILABLE',
    });
  }

  try {
    const warehouse = await resolveWarehouseForCart(cart, { to, Warehouse });

    if (!warehouse) {
      return attachFromMeta(envFrom, {
        source: 'env',
        reason: 'NO_MATCHING_WAREHOUSE',
      });
    }

    const from = buildShippoAddressFromWarehouse(warehouse);

    return attachFromMeta(from, {
      source: 'warehouse',
      warehouse: publicWarehouseMeta(warehouse),
    });
  } catch (err) {
    console.warn('[warehouse resolver] falling back to env FROM address:', {
      code: err?.code,
      message: err?.message,
    });

    return attachFromMeta(envFrom, {
      source: 'env',
      reason: err?.code || 'WAREHOUSE_RESOLUTION_FAILED',
    });
  }
}

async function resolveShippoFromAddressForCart(cart, deps = {}) {
  const {
    Product,
    Business,
    buildShippoAddressFromBusiness,
  } = deps;

  const allowedCats = new Set(['second-hand-clothes', 'uncategorized-second-hand-things']);

  // If missing dependencies, fall back safely to platform warehouse/env flow.
  if (!Product || !Business || typeof buildShippoAddressFromBusiness !== 'function') {
    return resolvePlatformWarehouseFromAddress(cart, deps);
  }

  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) {
    return resolvePlatformWarehouseFromAddress(cart, deps);
  }

  const ids = items
    .map((it) => String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim())
    .filter(Boolean);

  const unique = [...new Set(ids)];
  if (!unique.length) {
    return resolvePlatformWarehouseFromAddress(cart, deps);
  }

  // Support BOTH customId and Mongo _id from cart items.
  const objectIdLike = unique.filter((v) => /^[a-f\d]{24}$/i.test(v));
  const customIds = unique.filter((v) => !/^[a-f\d]{24}$/i.test(v));

  const or = [];
  if (customIds.length) or.push({ customId: { $in: customIds } });
  if (objectIdLike.length) or.push({ _id: { $in: objectIdLike } });

  const prods = await Product.find(or.length ? { $or: or } : {})
    .select('_id customId name category businessId sellerId seller ownerBusiness business')
    .lean();

  // Map by BOTH keys.
  const map = new Map();
  for (const p of prods) {
    if (p.customId) map.set(String(p.customId), p);
    if (p._id) map.set(String(p._id), p);
  }

  const rows = unique.map((id) => ({ id, product: map.get(id) || null }));

  // If any product missing or category not second-hand, use platform warehouse/env.
  for (const r of rows) {
    if (!r.product) {
      return resolvePlatformWarehouseFromAddress(cart, deps);
    }

    const cat = String(r.product.category || '').trim().toLowerCase();
    if (!allowedCats.has(cat)) {
      return resolvePlatformWarehouseFromAddress(cart, deps);
    }
  }

  // Second-hand flow: ensure same seller business for all items.
  const firstBizId = pickDefaultBizId(rows[0].product);
  if (!firstBizId) {
    const err = new Error(
      'Second-hand order detected, but product is missing seller businessId. Cannot build FROM address.'
    );
    err.code = 'SELLER_BUSINESS_MISSING';
    throw err;
  }

  for (const r of rows) {
    const bid = pickDefaultBizId(r.product);
    if (!bid || String(bid) !== String(firstBizId)) {
      const err = new Error(
        'Second-hand order contains products from different sellers. Cannot build one FROM address for one shipment.'
      );
      err.code = 'MIXED_SELLERS_NOT_SUPPORTED';
      throw err;
    }
  }

  const biz = await Business.findById(firstBizId).lean();
  if (!biz) {
    const err = new Error('Seller business not found for second-hand order.');
    err.code = 'SELLER_BUSINESS_NOT_FOUND';
    throw err;
  }

  const sellerFrom = buildShippoAddressFromBusiness(biz);

  return attachFromMeta(sellerFrom, {
    source: 'seller_business',
    businessId: String(firstBizId),
  });
}

module.exports = { resolveShippoFromAddressForCart };
