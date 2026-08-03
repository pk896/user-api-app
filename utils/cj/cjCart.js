// utils/cj/cjCart.js
'use strict';

const CjProduct = require('../../models/CjProduct');

function getBaseCurrency() {
  const value = String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase();

  return /^[A-Z]{3}$/.test(value) ? value : 'USD';
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeQuantity(value, fallback = 1) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(100, Math.floor(parsed)));
}

function ensureCjCart(req) {
  if (!req.session.cjCart || typeof req.session.cjCart !== 'object') {
    req.session.cjCart = {
      source: 'CJ',
      items: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  if (!Array.isArray(req.session.cjCart.items)) {
    req.session.cjCart.items = [];
  }

  req.session.cjCart.source = 'CJ';

  return req.session.cjCart;
}

/*
 * CJ cart prices contain no Kasyora-added VAT.
 *
 * The customer may later be charged destination import VAT,
 * customs duties or carrier handling charges during import.
 * Those amounts are not calculated or collected by this cart.
 */
function calculateCjCartSummary(items = []) {
  const list = Array.isArray(items) ? items : [];

  const summary = list.reduce(
    (accumulator, item) => {
      const quantity = normalizeQuantity(item?.quantity, 1);

      /*
       * Prefer the explicit CJ selling-price field.
       *
       * item.price remains only as a compatibility fallback
       * for older session cart records.
       */
      const unitPrice = round2(item?.priceExVat ?? item?.price ?? 0);

      accumulator.itemCount += quantity;

      accumulator.subtotal += unitPrice * quantity;

      return accumulator;
    },
    {
      itemCount: 0,
      subtotal: 0,
    },
  );

  summary.subtotal = round2(summary.subtotal);

  return {
    itemCount: summary.itemCount,

    /*
     * New authoritative CJ summary fields.
     */
    subtotal: summary.subtotal,

    vatAmount: 0,

    total: summary.subtotal,

    /*
     * Temporary compatibility fields.
     *
     * These prevent existing CJ cart and checkout templates
     * from breaking before they are patched.
     *
     * They no longer mean that VAT has been added.
     */
    subtotalExVat: summary.subtotal,

    totalIncVat: summary.subtotal,
  };
}

function publicCjCart(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];
  const summary = calculateCjCartSummary(items);

  return {
    source: 'CJ',
    department: 'cj',
    items,
    ...summary,
  };
}

function getVariantById(product, cjVariantId) {
  const wantedId = String(cjVariantId || '').trim();

  if (!wantedId || !Array.isArray(product?.variants)) {
    return null;
  }

  return (
    product.variants.find((variant) => String(variant?.cjVariantId || '').trim() === wantedId) ||
    null
  );
}

function variantInventoryState(variant) {
  const inventoryKnown = variant?.inventoryKnown === true;
  const totalInventory = Math.max(0, Math.floor(Number(variant?.totalInventory || 0)));

  return {
    inventoryKnown,
    totalInventory,
  };
}

async function loadSellableCjProductAndVariant({ cjProductId, cjVariantId }) {
  const cleanProductId = String(cjProductId || '').trim();
  const cleanVariantId = String(cjVariantId || '').trim();

  if (!cleanProductId) {
    const error = new Error('CJ product ID is required.');
    error.code = 'CJ_PRODUCT_ID_REQUIRED';
    throw error;
  }

  if (!cleanVariantId) {
    const error = new Error('Please select a CJ product variant.');
    error.code = 'CJ_VARIANT_ID_REQUIRED';
    throw error;
  }

  const product = await CjProduct.findOne({
    cjProductId: cleanProductId,
    status: 'active',
  });

  if (!product) {
    const error = new Error('This CJ product is not currently available for sale.');
    error.code = 'CJ_PRODUCT_NOT_ACTIVE';
    throw error;
  }

  const variant = getVariantById(product, cleanVariantId);

  if (!variant || variant.isEnabled !== true) {
    const error = new Error('This CJ product variant is not currently available.');
    error.code = 'CJ_VARIANT_NOT_AVAILABLE';
    throw error;
  }

  const priceExVat = Number(variant?.sellingPriceExVat?.value);

  const priceCurrency = String(
    variant?.sellingPriceExVat?.currency || product?.pricing?.baseCurrency || getBaseCurrency(),
  )
    .trim()
    .toUpperCase();

  const expectedCurrency = getBaseCurrency();

  if (!Number.isFinite(priceExVat) || priceExVat < 0 || priceCurrency !== expectedCurrency) {
    const error = new Error('This CJ variant does not have a valid Kasyora selling price.');
    error.code = 'CJ_VARIANT_PRICE_INVALID';
    throw error;
  }

  /*
   * CJ sellingPriceExVat is the complete Kasyora selling
   * price used by the CJ cart.
   *
   * Kasyora does not add South African VAT to this amount.
   */
  const sellingPrice = round2(priceExVat);

  return {
    product,
    variant,

    priceExVat: sellingPrice,

    price: sellingPrice,

    currency: expectedCurrency,

    vatRate: 0,

    inventory: variantInventoryState(variant),
  };
}

function buildCjCartItem({
  product,
  variant,
  quantity,
  priceExVat,
  price,
  currency,
  vatRate,
  inventory,
}) {
  return {
    source: 'CJ',

    cjProductId: String(product.cjProductId || '').trim(),
    cjVariantId: String(variant.cjVariantId || '').trim(),

    productSku: String(product.productSku || '').trim(),
    variantSku: String(variant.variantSku || '').trim(),

    name: String(product.name || 'CJ Product').trim(),
    variantName: String(
      variant.variantName || variant.variantKey || variant.variantSku || 'Variant',
    ).trim(),

    imageUrl: String(variant.imageUrl || product.mainImageUrl || '').trim(),

    category: String(
      product?.category?.name || product?.category?.firstName || 'CJ Product',
    ).trim(),

    quantity: normalizeQuantity(quantity, 1),

    /*
     * Both fields contain the same VAT-free CJ selling price.
     *
     * price is kept for compatibility with existing CJ views.
     * priceExVat remains the explicit authoritative field.
     */
    price: round2(price ?? priceExVat),

    priceExVat: round2(priceExVat ?? price),

    currency: String(currency || getBaseCurrency())
      .trim()
      .toUpperCase(),

    /*
     * Kasyora adds and collects no VAT in the CJ flow.
     */
    vatRate: Number(vatRate || 0),

    vatIncluded: false,

    weightGrams: Number.isFinite(Number(variant.weightGrams)) ? Number(variant.weightGrams) : null,

    dimensionsMm: {
      length: Number.isFinite(Number(variant?.dimensionsMm?.length))
        ? Number(variant.dimensionsMm.length)
        : null,

      width: Number.isFinite(Number(variant?.dimensionsMm?.width))
        ? Number(variant.dimensionsMm.width)
        : null,

      height: Number.isFinite(Number(variant?.dimensionsMm?.height))
        ? Number(variant.dimensionsMm.height)
        : null,
    },

    inventoryKnown: inventory.inventoryKnown,
    inventorySnapshot: inventory.totalInventory,

    addedAt: new Date().toISOString(),
  };
}

function findCjCartItemIndex(items, cjVariantId) {
  const wantedId = String(cjVariantId || '').trim();

  return (Array.isArray(items) ? items : []).findIndex(
    (item) => String(item?.cjVariantId || '').trim() === wantedId,
  );
}

async function addCjItem(req, { cjProductId, cjVariantId, quantity }) {
  const cart = ensureCjCart(req);

  const loaded = await loadSellableCjProductAndVariant({
    cjProductId,
    cjVariantId,
  });

  const safeQuantity = normalizeQuantity(quantity, 1);

  /*
   * CJ sometimes does not return inventory during the
   * product import/synchronisation response.
   *
   * When inventory is known, enforce it.
   * When inventory is unknown, checkout must perform
   * a fresh CJ inventory and logistics validation later.
   */
  if (loaded.inventory.inventoryKnown && loaded.inventory.totalInventory < safeQuantity) {
    const error = new Error(
      `Only ${loaded.inventory.totalInventory} unit(s) are currently available.`,
    );
    error.code = 'CJ_INSUFFICIENT_INVENTORY';
    throw error;
  }

  const existingIndex = findCjCartItemIndex(cart.items, loaded.variant.cjVariantId);

  if (existingIndex >= 0) {
    const currentQuantity = normalizeQuantity(cart.items[existingIndex].quantity, 1);

    const nextQuantity = normalizeQuantity(currentQuantity + safeQuantity, currentQuantity);

    if (loaded.inventory.inventoryKnown && loaded.inventory.totalInventory < nextQuantity) {
      const error = new Error(
        `Only ${loaded.inventory.totalInventory} unit(s) are currently available.`,
      );
      error.code = 'CJ_INSUFFICIENT_INVENTORY';
      throw error;
    }

    cart.items[existingIndex] = buildCjCartItem({
      ...loaded,
      quantity: nextQuantity,
    });
  } else {
    cart.items.push(
      buildCjCartItem({
        ...loaded,
        quantity: safeQuantity,
      }),
    );
  }

  cart.updatedAt = new Date().toISOString();

  /*
   * Successful CJ add switches only the visible storefront
   * department. It does not delete the internal cart.
   */
  req.session.storeDepartment = 'cj';

  return publicCjCart(cart);
}

async function updateCjItemQuantity(req, { cjVariantId, quantity }) {
  const cart = ensureCjCart(req);
  const cleanVariantId = String(cjVariantId || '').trim();

  const index = findCjCartItemIndex(cart.items, cleanVariantId);

  if (index < 0) {
    const error = new Error('CJ cart item was not found.');
    error.code = 'CJ_CART_ITEM_NOT_FOUND';
    throw error;
  }

  const currentItem = cart.items[index];

  const loaded = await loadSellableCjProductAndVariant({
    cjProductId: currentItem.cjProductId,
    cjVariantId: cleanVariantId,
  });

  const safeQuantity = normalizeQuantity(quantity, 1);

  if (loaded.inventory.inventoryKnown && loaded.inventory.totalInventory < safeQuantity) {
    const error = new Error(
      `Only ${loaded.inventory.totalInventory} unit(s) are currently available.`,
    );
    error.code = 'CJ_INSUFFICIENT_INVENTORY';
    throw error;
  }

  cart.items[index] = buildCjCartItem({
    ...loaded,
    quantity: safeQuantity,
  });

  cart.updatedAt = new Date().toISOString();
  req.session.storeDepartment = 'cj';

  return publicCjCart(cart);
}

function removeCjItem(req, cjVariantId) {
  const cart = ensureCjCart(req);
  const cleanVariantId = String(cjVariantId || '').trim();

  cart.items = cart.items.filter(
    (item) => String(item?.cjVariantId || '').trim() !== cleanVariantId,
  );

  cart.updatedAt = new Date().toISOString();

  return publicCjCart(cart);
}

function clearCjCart(req) {
  req.session.cjCart = {
    source: 'CJ',
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  return publicCjCart(req.session.cjCart);
}

module.exports = {
  ensureCjCart,
  publicCjCart,
  calculateCjCartSummary,
  addCjItem,
  updateCjItemQuantity,
  removeCjItem,
  clearCjCart,
};
