// routes/cjCart.js
'use strict';

const express = require('express');

const {
  ensureCjCart,
  publicCjCart,
  addCjItem,
  updateCjItemQuantity,
  removeCjItem,
  clearCjCart,
} = require('../utils/cj/cjCart');

const router = express.Router();

function errorStatus(error) {
  const code = String(error?.code || '').trim();

  if (
    [
      'CJ_PRODUCT_ID_REQUIRED',
      'CJ_VARIANT_ID_REQUIRED',
      'CJ_VARIANT_PRICE_INVALID',
    ].includes(code)
  ) {
    return 400;
  }

  if (
    [
      'CJ_PRODUCT_NOT_ACTIVE',
      'CJ_VARIANT_NOT_AVAILABLE',
      'CJ_CART_ITEM_NOT_FOUND',
    ].includes(code)
  ) {
    return 404;
  }

  if (code === 'CJ_INSUFFICIENT_INVENTORY') {
    return 409;
  }

  return 500;
}

function sendCjCartError(res, error) {
  const status = errorStatus(error);

  return res.status(status).json({
    success: false,
    code: String(error?.code || 'CJ_CART_ERROR'),
    message:
      error?.message ||
      'The CJ cart could not be updated.',
  });
}

/*
 * GET /api/cj-cart
 *
 * Returns only the separate CJ cart.
 */
router.get('/', (req, res) => {
  const cart = ensureCjCart(req);

  return res.json({
    success: true,
    ...publicCjCart(cart),
  });
});

/*
 * POST /api/cj-cart/add
 *
 * Body:
 * {
 *   "cjProductId": "...",
 *   "cjVariantId": "...",
 *   "quantity": 1
 * }
 */
router.post('/add', async (req, res) => {
  try {
    const cart = await addCjItem(req, {
      cjProductId: req.body?.cjProductId,
      cjVariantId: req.body?.cjVariantId,
      quantity: req.body?.quantity,
    });

    return res.status(200).json({
      success: true,
      message: 'CJ product added to the CJ cart.',
      redirectTo: '/cj/cart',
      storeDepartment: 'cj',
      ...cart,
    });
  } catch (error) {
    console.error('❌ CJ cart add failed:', error);
    return sendCjCartError(res, error);
  }
});

/*
 * POST /api/cj-cart/quantity
 *
 * Body:
 * {
 *   "cjVariantId": "...",
 *   "quantity": 2
 * }
 */
router.post('/quantity', async (req, res) => {
  try {
    const cart = await updateCjItemQuantity(req, {
      cjVariantId: req.body?.cjVariantId,
      quantity: req.body?.quantity,
    });

    return res.json({
      success: true,
      message: 'CJ cart quantity updated.',
      ...cart,
    });
  } catch (error) {
    console.error('❌ CJ cart quantity update failed:', error);
    return sendCjCartError(res, error);
  }
});

/*
 * POST /api/cj-cart/remove
 *
 * Body:
 * {
 *   "cjVariantId": "..."
 * }
 */
router.post('/remove', (req, res) => {
  try {
    const cjVariantId = String(
      req.body?.cjVariantId || '',
    ).trim();

    if (!cjVariantId) {
      return res.status(400).json({
        success: false,
        code: 'CJ_VARIANT_ID_REQUIRED',
        message: 'CJ variant ID is required.',
      });
    }

    const cart = removeCjItem(req, cjVariantId);

    return res.json({
      success: true,
      message: 'CJ product removed from the CJ cart.',
      ...cart,
    });
  } catch (error) {
    console.error('❌ CJ cart remove failed:', error);
    return sendCjCartError(res, error);
  }
});

/*
 * POST /api/cj-cart/clear
 */
router.post('/clear', (req, res) => {
  try {
    const cart = clearCjCart(req);

    return res.json({
      success: true,
      message: 'CJ cart cleared.',
      ...cart,
    });
  } catch (error) {
    console.error('❌ CJ cart clear failed:', error);
    return sendCjCartError(res, error);
  }
});

module.exports = router;