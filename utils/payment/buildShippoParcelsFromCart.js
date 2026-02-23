// utils/payment/buildShippoParcelsFromCart.js
'use strict';

function normalizeMoneyNumber(v) {
  if (v === null || v === undefined || v === '') return null;

  if (typeof v === 'object') {
    const inner = v.value ?? v.amount ?? v.price ?? null;
    if (inner === null || inner === undefined || inner === '') return null;
    const n2 = Number(String(inner).trim());
    return Number.isFinite(n2) ? n2 : null;
  }

  if (typeof v === 'number') return Number.isFinite(v) ? v : null;

  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function toQty(v, fallback = 1) {
  const n = normalizeMoneyNumber(v);
  if (n === null) return fallback;
  const q = Math.floor(n);
  return q >= 1 ? q : fallback;
}

function kgFrom(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unit || 'kg').toLowerCase();
  if (u === 'kg') return v;
  if (u === 'g') return v / 1000;
  if (u === 'lb') return v * 0.45359237;
  if (u === 'oz') return v * 0.028349523125;
  return null;
}

function cmFrom(value, unit) {
  const v = Number(value);
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unit || 'cm').toLowerCase();
  if (u === 'cm') return v;
  if (u === 'in') return v * 2.54;
  return null;
}

async function loadProductsForCart(cart, { Product }) {
  if (!Product) {
    const err = new Error('Product model not available for shipping calculation.');
    err.code = 'NO_PRODUCT_MODEL';
    throw err;
  }

  const items = Array.isArray(cart?.items) ? cart.items : [];
  const ids = items
    .map((it) => String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim())
    .filter(Boolean);

  const unique = [...new Set(ids)];
  if (!unique.length) return [];

  const prods = await Product.find({ customId: { $in: unique } })
    .select('customId name shipping')
    .lean();

  const map = new Map(prods.map((p) => [String(p.customId), p]));
  return items.map((it) => {
    const id = String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim();
    return { cartItem: it, product: map.get(id) || null, customId: id };
  });
}

function validateCartProductsShippingOrThrow(pairs) {
  const missingList = [];

  for (const row of pairs) {
    const p = row.product;
    if (!p) {
      missingList.push(`${row.customId || 'UNKNOWN'} (product not found)`);
      continue;
    }

    const sh = p.shipping || {};
    const wVal = sh?.weight?.value;
    const wUnit = sh?.weight?.unit;

    const d = sh?.dimensions || {};
    const len = d.length;
    const wid = d.width;
    const hei = d.height;
    const dUnit = d.unit;

    const problems = [];
    if (kgFrom(wVal, wUnit) === null) problems.push('weight');
    if (cmFrom(len, dUnit) === null) problems.push('length');
    if (cmFrom(wid, dUnit) === null) problems.push('width');
    if (cmFrom(hei, dUnit) === null) problems.push('height');

    if (problems.length) {
      missingList.push(`${p.name || p.customId} (missing: ${problems.join(', ')})`);
    }
  }

  if (missingList.length) {
    const err = new Error(
      `Shipping is unavailable because these products are missing shipping measurements: ${missingList.join(' | ')}`
    );
    err.code = 'PRODUCT_SHIPPING_MISSING';
    throw err;
  }
}

function buildCalculatedParcelFromProducts(rows, { onlyFragile } = {}) {
  // ONE parcel:
  // - weight = sum(weight * qty)
  // - dimensions = max of each dimension (not multiplied by qty)
  let totalKg = 0;
  let maxLenCm = 0;
  let maxWidCm = 0;
  let maxHeiCm = 0;

  for (const row of rows) {
    const p = row.product;
    const sh = p.shipping || {};
    const qty = toQty(row?.cartItem?.qty ?? row?.cartItem?.quantity, 1);

    const isFragile = !!sh?.fragile;

    if (onlyFragile === true && !isFragile) continue;
    if (onlyFragile === false && isFragile) continue;

    const kgEach = kgFrom(sh?.weight?.value, sh?.weight?.unit);
    const d = sh?.dimensions || {};
    const unit = d.unit;

    const lenCm = cmFrom(d.length, unit);
    const widCm = cmFrom(d.width, unit);
    const heiCm = cmFrom(d.height, unit);

    totalKg += kgEach * qty;

    maxLenCm = Math.max(maxLenCm, lenCm);
    maxWidCm = Math.max(maxWidCm, widCm);
    maxHeiCm = Math.max(maxHeiCm, heiCm);
  }

  const safeKg = Math.max(0.001, Number(totalKg.toFixed(3)));
  const safeLen = Math.max(0.1, Number(maxLenCm.toFixed(1)));
  const safeWid = Math.max(0.1, Number(maxWidCm.toFixed(1)));
  const safeHei = Math.max(0.1, Number(maxHeiCm.toFixed(1)));

  return {
    length: String(safeLen),
    width: String(safeWid),
    height: String(safeHei),
    distance_unit: 'cm',
    weight: String(safeKg),
    mass_unit: 'kg',
  };
}

async function buildShippoParcelsFromCart_Strict(cart, { Product }) {
  const pairs = await loadProductsForCart(cart, { Product });
  validateCartProductsShippingOrThrow(pairs);

  const hasFragile = pairs.some((r) => !!r?.product?.shipping?.fragile);

  // Default: one parcel
  if (!hasFragile) {
    return [buildCalculatedParcelFromProducts(pairs)];
  }

  // Split only when fragile items exist
  const fragileRows = pairs.filter((r) => !!r?.product?.shipping?.fragile);
  const normalRows = pairs.filter((r) => !r?.product?.shipping?.fragile);

  const parcels = [];
  if (fragileRows.length) parcels.push(buildCalculatedParcelFromProducts(fragileRows));
  if (normalRows.length) parcels.push(buildCalculatedParcelFromProducts(normalRows));

  if (!parcels.length) {
    return [buildCalculatedParcelFromProducts(pairs)];
  }

  return parcels;
}

module.exports = {
  kgFrom,
  cmFrom,
  loadProductsForCart,
  validateCartProductsShippingOrThrow,
  buildCalculatedParcelFromProducts,
  buildShippoParcelsFromCart_Strict,
};