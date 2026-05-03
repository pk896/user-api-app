// routes/adminHomePromoOffers.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const HomePromoOffer = require('../models/HomePromoOffer');
const Product = require('../models/Product');

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function normalizePayload(body) {
  return {
    productCustomId: String(body.productCustomId || '').trim(),
    eyebrowText: String(body.eyebrowText || '').trim(),
    titleOverride: String(body.titleOverride || '').trim(),
    discountText: String(body.discountText || '').trim(),
    active: String(body.active || '') === 'on',
    sortOrder: Number(body.sortOrder || 0),
  };
}

function promoOfferSnapshot(offer) {
  if (!offer) return null;

  return {
    slot: offer.slot || '',
    productCustomId: offer.productCustomId || '',
    eyebrowText: offer.eyebrowText || '',
    titleOverride: offer.titleOverride || '',
    discountText: offer.discountText || '',
    active: !!offer.active,
    sortOrder: Number(offer.sortOrder || 0),
  };
}

/* DASHBOARD */
router.get(
  '/home-promo-offers',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
  try {
    const offers = await HomePromoOffer.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const offersWithProducts = await Promise.all(
      offers.map(async (offer) => {
        let product = null;

        if (offer.productCustomId) {
          product = await Product.findOne({ customId: offer.productCustomId })
            .select('customId name imageUrl category type price stock')
            .lean();
        }

        return {
          ...offer,
          product,
        };
      })
    );

    return res.render('admin/home-promo-offers/index', {
      title: 'Homepage Promo Offers',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      offers: offersWithProducts,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ admin home promo offers index error:', err);
    req.flash('error', 'Could not load homepage promo offers.');
    return res.redirect('/admin/dashboard');
  }
});

/* NEW / EDIT PAGE BY SLOT */
router.get(
  '/home-promo-offers/:slot/edit',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid promo offer slot.');
      return res.redirect('/admin/home-promo-offers');
    }

    const offerRaw = await HomePromoOffer.findOne({ slot }).lean();

    let selectedProduct = null;
    let offer = offerRaw;

    if (offerRaw?.productCustomId) {
      selectedProduct = await Product.findOne({ customId: offerRaw.productCustomId })
        .select('customId name imageUrl category type price stock isOnSale')
        .lean();

      offer = {
        ...offerRaw,
        product: selectedProduct || null,
      };
    }

    return res.render('admin/home-promo-offers/edit', {
      title: `Edit ${slot === 'left' ? 'Left' : 'Right'} Promo Offer`,
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      slot,
      offer,
      selectedProduct,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ home promo offer edit page error:', err);
    req.flash('error', 'Could not load promo offer.');
    return res.redirect('/admin/home-promo-offers');
  }
});

/* SEARCH PRODUCTS FOR HOME PROMO OFFERS */
router.get(
  '/home-promo-offers/products/search',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.json({ success: true, products: [] });
    }

    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const products = await Product.find({
      stock: { $gt: 0 },
      $or: [
        { customId: { $regex: safeQ, $options: 'i' } },
        { name: { $regex: safeQ, $options: 'i' } },
      ],
    })
      .select('customId name imageUrl category type price stock isOnSale')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({ success: true, products });
  } catch (err) {
    console.error('❌ home promo offers product search error:', err);
    return res.status(500).json({
      success: false,
      products: [],
      message: 'Failed to search products.',
    });
  }
});

/* SAVE SLOT */
router.post(
  '/home-promo-offers/:slot',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid promo offer slot.');
      return res.redirect('/admin/home-promo-offers');
    }

    const payload = normalizePayload(req.body);

    if (!payload.productCustomId) {
      req.flash('error', 'Please select a product.');
      return res.redirect(`/admin/home-promo-offers/${slot}/edit`);
    }

    const product = await Product.findOne({
      customId: payload.productCustomId,
      stock: { $gt: 0 },
    }).lean();

    if (!product) {
      req.flash('error', 'Selected product was not found or is out of stock.');
      return res.redirect(`/admin/home-promo-offers/${slot}/edit`);
    }

    let offer = await HomePromoOffer.findOne({ slot });
    const before = promoOfferSnapshot(offer);
    const isCreate = !offer;

    if (!offer) {
      offer = new HomePromoOffer({
        slot,
        ...payload,
      });
    } else {
      offer.productCustomId = payload.productCustomId;
      offer.eyebrowText = payload.eyebrowText;
      offer.titleOverride = payload.titleOverride;
      offer.discountText = payload.discountText;
      offer.active = payload.active;
      offer.sortOrder = payload.sortOrder;
    }

    await offer.save();

    await logAdminAction(req, {
      action: isCreate ? 'store.home_promo_offer.create' : 'store.home_promo_offer.update',
      entityType: 'home_promo_offer',
      entityId: String(offer._id),
      status: 'success',
      before,
      after: promoOfferSnapshot(offer),
      meta: {
        section: 'home_promo_offers',
        slot,
        productCustomId: payload.productCustomId,
        productName: product.name || '',
      },
    });

    req.flash('success', `${slot === 'left' ? 'Left' : 'Right'} promo offer saved successfully.`);
    return res.redirect('/admin/home-promo-offers');
  } catch (err) {
    console.error('❌ save promo offer error:', err);
    req.flash('error', 'Failed to save promo offer.');
    return res.redirect('/admin/home-promo-offers');
  }
});

/* TOGGLE */
router.get(
  '/home-promo-offers/:slot/toggle',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid promo offer slot.');
      return res.redirect('/admin/home-promo-offers');
    }

    const offer = await HomePromoOffer.findOne({ slot });

    if (!offer) {
      req.flash('error', 'Promo offer not found for that slot.');
      return res.redirect('/admin/home-promo-offers');
    }

    const before = promoOfferSnapshot(offer);

    offer.active = !offer.active;
    await offer.save();

    await logAdminAction(req, {
      action: offer.active ? 'store.home_promo_offer.activate' : 'store.home_promo_offer.deactivate',
      entityType: 'home_promo_offer',
      entityId: String(offer._id),
      status: 'success',
      before,
      after: promoOfferSnapshot(offer),
      meta: {
        section: 'home_promo_offers',
        slot,
      },
    });

    req.flash(
      'success',
      `${slot === 'left' ? 'Left' : 'Right'} promo offer ${
        offer.active ? 'activated' : 'deactivated'
      } successfully.`
    );
    return res.redirect('/admin/home-promo-offers');
  } catch (err) {
    console.error('❌ toggle promo offer error:', err);
    req.flash('error', 'Failed to toggle promo offer.');
    return res.redirect('/admin/home-promo-offers');
  }
});

router.use((err, req, res, _next) => {
  console.error('❌ adminHomePromoOffers route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');
  if (back) return res.redirect(back);

  return res.redirect('/admin/home-promo-offers');
});

module.exports = router;