// routes/wholesaleCheckout.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

const SupplierProduct = require('../models/SupplierProduct');
const SupplyRequest = require('../models/SupplyRequest');
const Business = require('../models/Business');
const Product = require('../models/Product');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

const router = express.Router();

const BASE_CURRENCY = String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';

function formatWholesaleMoney(amount) {
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

function getBusiness(req) {
  return req.business || req.session?.business || null;
}

function requireSeller(req, res, next) {
  const business = getBusiness(req);

  if (!business || !business._id) {
    req.flash('error', 'Please log in first.');
    return res.redirect('/business/login');
  }

  if (business.role !== 'seller') {
    req.flash('error', 'Only seller accounts can request wholesale stock.');
    return res.redirect('/business/dashboard');
  }

  return next();
}

function cleanString(value, max = 1000) {
  return String(value || '').trim().slice(0, max);
}

function toPositiveInt(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;

  const int = Math.floor(n);
  return int >= 1 ? int : fallback;
}

function toPositiveMoney(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n > 0 ? Number(n.toFixed(2)) : fallback;
}

function makeImportedProductCustomId() {
  return `WIMP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

async function createUniqueImportedCustomId() {
  for (let i = 0; i < 10; i += 1) {
    const customId = makeImportedProductCustomId();
    const exists = await Product.exists({ customId });
    if (!exists) return customId;
  }

  throw new Error('Could not generate unique product ID. Please try again.');
}

function supplierShippingIsComplete(product) {
  const shipping = product?.shipping || {};
  const weight = shipping.weight || {};
  const dimensions = shipping.dimensions || {};

  return (
    Number(weight.value) > 0 &&
    Number(dimensions.length) > 0 &&
    Number(dimensions.width) > 0 &&
    Number(dimensions.height) > 0
  );
}

function getWholesaleCart(req) {
  if (!req.session.wholesaleCart) {
    req.session.wholesaleCart = {
      items: [],
    };
  }

  if (!Array.isArray(req.session.wholesaleCart.items)) {
    req.session.wholesaleCart.items = [];
  }

  return req.session.wholesaleCart;
}

function saveSession(req) {
  return new Promise((resolve) => {
    if (req.session && typeof req.session.save === 'function') {
      return req.session.save(() => resolve());
    }

    return resolve();
  });
}

/* =========================================================
 * POST /wholesale/cart/add/:supplierProductId
 * Seller adds supplier product to wholesale cart
 * ======================================================= */
router.post(
  '/cart/add/:supplierProductId',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const seller = getBusiness(req);
      const supplierProductId = cleanString(req.params.supplierProductId, 80);

      if (!mongoose.isValidObjectId(supplierProductId)) {
        req.flash('error', 'Invalid wholesale product.');
        return res.redirect('/wholesale');
      }

      const product = await SupplierProduct.findOne({
        _id: supplierProductId,
        status: 'active',
      })
        .select(
          '_id supplier name imageUrl wholesalePrice minimumOrderQuantity availableQuantity unit status'
        )
        .lean();

      if (!product) {
        req.flash('error', 'Wholesale product not found or not active.');
        return res.redirect('/wholesale');
      }

      const supplierId = String(product.supplier || '');
      const sellerId = String(seller._id || '');

      if (supplierId === sellerId) {
        req.flash('error', 'You cannot request stock from your own supplier account.');
        return res.redirect('/wholesale');
      }

      const requestedQty = toPositiveInt(
        req.body.quantity || req.body.requestedQuantity,
        Number(product.minimumOrderQuantity || 1)
      );

      const minimumOrderQuantity = Number(product.minimumOrderQuantity || 1);
      const availableQuantity = Number(product.availableQuantity || 0);

      if (requestedQty < minimumOrderQuantity) {
        req.flash(
          'error',
          `Minimum order quantity is ${minimumOrderQuantity} ${product.unit || 'units'}.`
        );
        return res.redirect(`/wholesale/products/${product._id}`);
      }

      if (availableQuantity <= 0) {
        req.flash('error', 'This wholesale product is currently out of stock.');
        return res.redirect(`/wholesale/products/${product._id}`);
      }

      if (requestedQty > availableQuantity) {
        req.flash(
          'error',
          `Only ${availableQuantity} ${product.unit || 'units'} available.`
        );
        return res.redirect(`/wholesale/products/${product._id}`);
      }

      const cart = getWholesaleCart(req);

      const existing = cart.items.find((item) => {
        return String(item.supplierProduct) === String(product._id);
      });

      if (existing) {
        existing.requestedQuantity = requestedQty;
      } else {
        cart.items.push({
          supplier: String(product.supplier),
          supplierProduct: String(product._id),
          name: product.name || 'Wholesale Product',
          imageUrl: product.imageUrl || '',
          wholesalePrice: Number(product.wholesalePrice || 0),
          minimumOrderQuantity,
          availableQuantity,
          unit: product.unit || 'units',
          requestedQuantity: requestedQty,
        });
      }

      await saveSession(req);

      req.flash('success', 'Wholesale product added to request cart.');
      return res.redirect('/wholesale/checkout');
    } catch (err) {
      console.error('❌ Add wholesale cart error:', err);
      req.flash('error', 'Could not add wholesale product to cart.');
      return res.redirect('/wholesale');
    }
  }
);

/* =========================================================
 * POST /wholesale/cart/update/:supplierProductId
 * Update quantity on wholesale checkout
 * ======================================================= */
router.post(
  '/cart/update/:supplierProductId',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const supplierProductId = cleanString(req.params.supplierProductId, 80);
      const quantity = toPositiveInt(req.body.quantity, 1);

      const cart = getWholesaleCart(req);

      const item = cart.items.find((row) => {
        return String(row.supplierProduct) === supplierProductId;
      });

      if (!item) {
        req.flash('error', 'Wholesale cart item not found.');
        return res.redirect('/wholesale/checkout');
      }

      const freshProduct = await SupplierProduct.findOne({
        _id: supplierProductId,
        status: 'active',
      })
        .select('_id minimumOrderQuantity availableQuantity unit')
        .lean();

      if (!freshProduct) {
        req.flash('error', 'This wholesale product is no longer available.');
        cart.items = cart.items.filter((row) => {
          return String(row.supplierProduct) !== supplierProductId;
        });
        await saveSession(req);
        return res.redirect('/wholesale/checkout');
      }

      const minimumOrderQuantity = Number(freshProduct.minimumOrderQuantity || 1);
      const availableQuantity = Number(freshProduct.availableQuantity || 0);

      if (quantity < minimumOrderQuantity) {
        req.flash(
          'error',
          `Minimum order quantity is ${minimumOrderQuantity} ${freshProduct.unit || 'units'}.`
        );
        return res.redirect('/wholesale/checkout');
      }

      if (quantity > availableQuantity) {
        req.flash(
          'error',
          `Only ${availableQuantity} ${freshProduct.unit || 'units'} available.`
        );
        return res.redirect('/wholesale/checkout');
      }

      item.requestedQuantity = quantity;
      item.minimumOrderQuantity = minimumOrderQuantity;
      item.availableQuantity = availableQuantity;
      item.unit = freshProduct.unit || item.unit || 'units';

      await saveSession(req);

      req.flash('success', 'Wholesale quantity updated.');
      return res.redirect('/wholesale/checkout');
    } catch (err) {
      console.error('❌ Update wholesale cart error:', err);
      req.flash('error', 'Could not update wholesale cart.');
      return res.redirect('/wholesale/checkout');
    }
  }
);

/* =========================================================
 * POST /wholesale/cart/remove/:supplierProductId
 * Remove item from wholesale cart
 * ======================================================= */
router.post(
  '/cart/remove/:supplierProductId',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const supplierProductId = cleanString(req.params.supplierProductId, 80);
      const cart = getWholesaleCart(req);

      cart.items = cart.items.filter((item) => {
        return String(item.supplierProduct) !== supplierProductId;
      });

      await saveSession(req);

      req.flash('success', 'Wholesale product removed from cart.');
      return res.redirect('/wholesale/checkout');
    } catch (err) {
      console.error('❌ Remove wholesale cart error:', err);
      req.flash('error', 'Could not remove wholesale product.');
      return res.redirect('/wholesale/checkout');
    }
  }
);

/* =========================================================
 * GET /wholesale/checkout
 * Seller wholesale checkout/request page
 * ======================================================= */
router.get(
  '/checkout',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const seller = getBusiness(req);
      const cart = getWholesaleCart(req);

      const supplierIds = [
        ...new Set(
          cart.items
            .map((item) => String(item.supplier || '').trim())
            .filter(Boolean)
        ),
      ];

      const suppliers = supplierIds.length
        ? await Business.find({ _id: { $in: supplierIds } })
            .select('_id name email phone logoUrl city country')
            .lean()
        : [];

      const suppliersById = new Map(
        suppliers.map((supplier) => [String(supplier._id), supplier])
      );

      const items = cart.items.map((item) => {
        const supplier = suppliersById.get(String(item.supplier)) || null;

        const quantity = Number(item.requestedQuantity || 0);
        const price = Number(item.wholesalePrice || 0);

        return {
          ...item,
          supplier,
          lineTotal: quantity * price,
        };
      });

      const subtotal = items.reduce((sum, item) => {
        return sum + Number(item.lineTotal || 0);
      }, 0);

      return res.render('wholesale/checkout', {
        title: 'Wholesale Checkout',
        active: 'wholesale-checkout',
        business: seller,
        items,
        subtotal,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
        baseCurrency: BASE_CURRENCY,
        formatMoney: formatWholesaleMoney,
      });
    } catch (err) {
      console.error('❌ Wholesale checkout page error:', err);
      req.flash('error', 'Could not load wholesale checkout.');
      return res.redirect('/wholesale');
    }
  }
);

/* =========================================================
 * POST /wholesale/checkout/request
 * Creates SupplyRequest records
 * ======================================================= */
router.post(
  '/checkout/request',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const seller = getBusiness(req);
      const cart = getWholesaleCart(req);

      if (!cart.items.length) {
        req.flash('error', 'Your wholesale cart is empty.');
        return res.redirect('/wholesale');
      }

      const contactName = cleanString(req.body.contactName, 120);
      const contactEmail = cleanString(req.body.contactEmail, 160).toLowerCase();
      const contactPhone = cleanString(req.body.contactPhone, 60);
      const deliveryCountry = cleanString(req.body.deliveryCountry, 120);
      const deliveryCity = cleanString(req.body.deliveryCity, 120);
      const message = cleanString(req.body.message, 2000);

      if (!contactName || !contactPhone || !deliveryCountry || !deliveryCity) {
        req.flash(
          'error',
          'Please enter contact name, phone, delivery country, and delivery city.'
        );
        return res.redirect('/wholesale/checkout');
      }

      const createdRequests = [];

      for (const item of cart.items) {
        if (!mongoose.isValidObjectId(item.supplierProduct)) continue;

        const product = await SupplierProduct.findOne({
          _id: item.supplierProduct,
          status: 'active',
        })
          .select(
            '_id supplier name minimumOrderQuantity availableQuantity unit status'
          )
          .lean();

        if (!product) {
          throw new Error(`Product no longer available: ${item.name}`);
        }

        const requestedQuantity = toPositiveInt(item.requestedQuantity, 1);
        const minimumOrderQuantity = Number(product.minimumOrderQuantity || 1);
        const availableQuantity = Number(product.availableQuantity || 0);

        if (requestedQuantity < minimumOrderQuantity) {
          throw new Error(
            `${product.name} minimum order quantity is ${minimumOrderQuantity} ${product.unit || 'units'}.`
          );
        }

        if (availableQuantity <= 0) {
          throw new Error(`${product.name} is currently out of stock.`);
        }

        if (requestedQuantity > availableQuantity) {
          throw new Error(
            `${product.name} only has ${availableQuantity} ${product.unit || 'units'} available.`
          );
        }

        const request = await SupplyRequest.create({
          seller: seller._id,
          supplier: product.supplier,
          supplierProduct: product._id,
          requestedQuantity,
          message,
          contactName,
          contactEmail,
          contactPhone,
          deliveryCountry,
          deliveryCity,
          status: 'pending',
        });

        createdRequests.push(request);
      }

      req.session.wholesaleCart = {
        items: [],
      };

      await saveSession(req);

      req.flash(
        'success',
        `Wholesale request sent successfully. ${createdRequests.length} request(s) created.`
      );

      return res.redirect('/wholesale/my-requests');
    } catch (err) {
      console.error('❌ Create wholesale request error:', err);
      req.flash('error', err.message || 'Could not send wholesale request.');
      return res.redirect('/wholesale/checkout');
    }
  }
);

/* =========================================================
 * POST /wholesale/import/:requestId
 * Seller imports approved supplier product into seller Product collection
 * ======================================================= */
router.post(
  '/import/:requestId',
  requireBusiness,
  requireVerifiedBusiness,
  requireSeller,
  async (req, res) => {
    try {
      const seller = getBusiness(req);
      const requestId = cleanString(req.params.requestId, 80);

      if (!mongoose.isValidObjectId(requestId)) {
        req.flash('error', 'Invalid supply request.');
        return res.redirect('/wholesale/my-requests');
      }

      const supplyRequest = await SupplyRequest.findOne({
        _id: requestId,
        seller: seller._id,
        status: 'approved',
      })
        .populate('supplier')
        .populate('supplierProduct')
        .lean();

      if (!supplyRequest) {
        req.flash('error', 'Only approved supply requests can be imported.');
        return res.redirect('/wholesale/my-requests');
      }

      const supplierProduct = supplyRequest.supplierProduct;

      if (!supplierProduct || !supplierProduct._id) {
        req.flash('error', 'Supplier product was not found.');
        return res.redirect('/wholesale/my-requests');
      }

      const duplicate = await Product.findOne({
        business: seller._id,
        sourceSupplyRequest: supplyRequest._id,
      })
        .select('_id customId name')
        .lean();

      if (duplicate) {
        req.flash(
          'info',
          `This supply request is already imported as "${duplicate.name}".`
        );
        return res.redirect('/products/all');
      }

      if (!supplierShippingIsComplete(supplierProduct)) {
        req.flash(
          'error',
          'Cannot import this product yet. The supplier product is missing shipping weight or dimensions.'
        );
        return res.redirect('/wholesale/my-requests');
      }

      const wholesalePrice = Number(supplierProduct.wholesalePrice || 0);

      const approvedQuantity = toPositiveInt(
        supplyRequest.requestedQuantity,
        0
      );

      if (approvedQuantity <= 0) {
        req.flash('error', 'Cannot import this product because the approved request quantity is invalid.');
        return res.redirect('/wholesale/my-requests');
      }

      const suggestedRetailPrice =
        wholesalePrice > 0 ? Number((wholesalePrice * 1.35).toFixed(2)) : 1;

      const retailPrice = toPositiveMoney(
        req.body.retailPrice,
        suggestedRetailPrice
      );

      const customId = await createUniqueImportedCustomId();

      const role = String(supplierProduct.role || 'general').trim() || 'general';
      const type = String(supplierProduct.type || '').trim();

      const sizes = Array.isArray(supplierProduct.sizes)
        ? supplierProduct.sizes.map((v) => String(v || '').trim()).filter(Boolean)
        : [];

      const colors = Array.isArray(supplierProduct.colors)
        ? supplierProduct.colors.map((v) => String(v || '').trim()).filter(Boolean)
        : [];

      const colorImages = Array.isArray(supplierProduct.colorImages)
        ? supplierProduct.colorImages
            .map((entry) => ({
              color: String(entry?.color || '').trim(),
              imageUrl: String(entry?.imageUrl || '').trim(),
            }))
            .filter((entry) => entry.color && entry.imageUrl)
        : [];

      const importedProduct = new Product({
        customId,
        name: supplierProduct.name,
        price: retailPrice,
        description: supplierProduct.description || '',
        imageUrl: supplierProduct.imageUrl,

        // ✅ Import stock from approved supply request quantity
        stock: approvedQuantity,

        role,
        type,
        category: supplierProduct.category || '',

        color: supplierProduct.color || colors[0] || '',
        size: supplierProduct.size || sizes[0] || '',
        sizes,
        colors,
        colorImages,

        quality: supplierProduct.quality || '',
        made: supplierProduct.made || supplierProduct.countryOfOrigin || '',
        madeCode: supplierProduct.madeCode || '',
        manufacturer: supplierProduct.manufacturer || '',
        keywords: Array.isArray(supplierProduct.keywords)
          ? supplierProduct.keywords
          : [],

        shipping: {
          weight: {
            value: Number(supplierProduct.shipping?.weight?.value || 0),
            unit: supplierProduct.shipping?.weight?.unit || 'kg',
          },
          dimensions: {
            length: Number(supplierProduct.shipping?.dimensions?.length || 0),
            width: Number(supplierProduct.shipping?.dimensions?.width || 0),
            height: Number(supplierProduct.shipping?.dimensions?.height || 0),
            unit: supplierProduct.shipping?.dimensions?.unit || 'cm',
          },
          shipSeparately: Boolean(supplierProduct.shipping?.shipSeparately),
          fragile: Boolean(supplierProduct.shipping?.fragile),
          packagingHint: supplierProduct.shipping?.packagingHint || '',
        },

        business: seller._id,

        sourceType: 'wholesale_import',
        sourceSupplier: supplyRequest.supplier?._id || supplyRequest.supplier,
        sourceSupplierProduct: supplierProduct._id,
        sourceSupplyRequest: supplyRequest._id,
        wholesaleCostPrice: wholesalePrice,
        importedAt: new Date(),

        isNewItem: true,
        isOnSale: false,
        isPopular: false,
      });

      await importedProduct.save();

      req.flash(
        'success',
        `Product imported successfully with ${approvedQuantity} item(s) in stock. Please review the retail price before selling.`
      );

      return res.redirect('/products/all');
    } catch (err) {
      console.error('❌ Wholesale import error:', err);

      req.flash(
        'error',
        err.message || 'Could not import this wholesale product.'
      );

      return res.redirect('/wholesale/my-requests');
    }
  }
);

module.exports = router;