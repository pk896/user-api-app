'use strict';

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

async function resolveShippoFromAddressForCart(cart, deps = {}) {
  const {
    Product,
    Business,
    buildShippoAddressFromBusiness,
    getShippoFromAddress,
  } = deps;

  const envFrom = getShippoFromAddress();

  const allowedCats = new Set(['second-hand-clothes', 'uncategorized-second-hand-things']);

  // If missing dependencies, fall back safely
  if (!Product || !Business || typeof buildShippoAddressFromBusiness !== 'function') {
    return envFrom;
  }

  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) return envFrom;

  const ids = items
    .map((it) => String(it?.customId || it?.productId || it?.pid || it?.sku || '').trim())
    .filter(Boolean);

  const unique = [...new Set(ids)];
  if (!unique.length) return envFrom;

  // Support BOTH customId and Mongo _id from cart items
  const objectIdLike = unique.filter((v) => /^[a-f\d]{24}$/i.test(v));
  const customIds = unique.filter((v) => !/^[a-f\d]{24}$/i.test(v));

  const or = [];
  if (customIds.length) or.push({ customId: { $in: customIds } });
  if (objectIdLike.length) or.push({ _id: { $in: objectIdLike } });

  const prods = await Product.find(or.length ? { $or: or } : {})
    .select('_id customId name category businessId sellerId seller ownerBusiness business')
    .lean();

  // Map by BOTH keys
  const map = new Map();
  for (const p of prods) {
    if (p.customId) map.set(String(p.customId), p);
    if (p._id) map.set(String(p._id), p);
  }

  const rows = unique.map((id) => ({ id, product: map.get(id) || null }));

  // If any product missing or category not allowed -> use env
  for (const r of rows) {
    if (!r.product) return envFrom;

    const cat = String(r.product.category || '').trim().toLowerCase();
    if (!allowedCats.has(cat)) return envFrom;
  }

  // Ensure same seller business for all items
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

  return buildShippoAddressFromBusiness(biz);
}

module.exports = { resolveShippoFromAddressForCart };