// routes/adminBestsellerCards.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const BestsellerCard = require('../models/BestsellerCard');
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

/* INDEX */
router.get('/bestseller-cards', requireAdmin, async (req, res) => {
  try {
    const cards = await BestsellerCard.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const cardsWithProducts = await Promise.all(
      cards.map(async (card) => {
        let product = null;

        if (card.productCustomId) {
          product = await Product.findOne({ customId: card.productCustomId })
            .select('customId name imageUrl category type price stock')
            .lean();
        }

        return {
          ...card,
          product,
        };
      })
    );

    return res.render('admin/bestseller-cards/index', {
      title: 'Bestseller Cards',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      cards: cardsWithProducts,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ admin bestseller cards index error:', err);
    req.flash('error', 'Could not load bestseller cards.');
    return res.redirect('/admin/dashboard');
  }
});

/* EDIT */
router.get('/bestseller-cards/:slot/edit', requireAdmin, async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid bestseller card slot.');
      return res.redirect('/admin/bestseller-cards');
    }

    const cardRaw = await BestsellerCard.findOne({ slot }).lean();

    let selectedProduct = null;
    let card = cardRaw;

    if (cardRaw?.productCustomId) {
      selectedProduct = await Product.findOne({ customId: cardRaw.productCustomId })
        .select('customId name imageUrl category type price stock isOnSale')
        .lean();

      card = {
        ...cardRaw,
        product: selectedProduct || null,
      };
    }

    return res.render('admin/bestseller-cards/edit', {
      title: `Edit ${slot === 'left' ? 'Left' : 'Right'} Bestseller Card`,
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      slot,
      card,
      selectedProduct,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ bestseller card edit page error:', err);
    req.flash('error', 'Could not load bestseller card.');
    return res.redirect('/admin/bestseller-cards');
  }
});

/* SEARCH PRODUCTS FOR BESTSELLER CARD */
router.get('/bestseller-cards/products/search', requireAdmin, async (req, res) => {
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
    console.error('❌ bestseller card product search error:', err);
    return res.status(500).json({
      success: false,
      products: [],
      message: 'Failed to search products.',
    });
  }
});

/* SAVE */
router.post('/bestseller-cards/:slot', requireAdmin, async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid bestseller card slot.');
      return res.redirect('/admin/bestseller-cards');
    }

    const payload = normalizePayload(req.body);

    if (!payload.productCustomId) {
      req.flash('error', 'Please select a product.');
      return res.redirect(`/admin/bestseller-cards/${slot}/edit`);
    }

    const product = await Product.findOne({
      customId: payload.productCustomId,
      stock: { $gt: 0 },
    }).lean();

    if (!product) {
      req.flash('error', 'Selected product was not found or is out of stock.');
      return res.redirect(`/admin/bestseller-cards/${slot}/edit`);
    }

    let card = await BestsellerCard.findOne({ slot });

    if (!card) {
      card = new BestsellerCard({
        slot,
        ...payload,
      });
    } else {
      card.productCustomId = payload.productCustomId;
      card.eyebrowText = payload.eyebrowText;
      card.titleOverride = payload.titleOverride;
      card.discountText = payload.discountText;
      card.active = payload.active;
      card.sortOrder = payload.sortOrder;
    }

    await card.save();

    req.flash('success', `${slot === 'left' ? 'Left' : 'Right'} bestseller card saved successfully.`);
    return res.redirect('/admin/bestseller-cards');
  } catch (err) {
    console.error('❌ save bestseller card error:', err);
    req.flash('error', 'Failed to save bestseller card.');
    return res.redirect('/admin/bestseller-cards');
  }
});

/* TOGGLE */
router.get('/bestseller-cards/:slot/toggle', requireAdmin, async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid bestseller card slot.');
      return res.redirect('/admin/bestseller-cards');
    }

    const card = await BestsellerCard.findOne({ slot });

    if (!card) {
      req.flash('error', 'Bestseller card not found for that slot.');
      return res.redirect('/admin/bestseller-cards');
    }

    card.active = !card.active;
    await card.save();

    req.flash(
      'success',
      `${slot === 'left' ? 'Left' : 'Right'} bestseller card ${
        card.active ? 'activated' : 'deactivated'
      } successfully.`
    );

    return res.redirect('/admin/bestseller-cards');
  } catch (err) {
    console.error('❌ toggle bestseller card error:', err);
    req.flash('error', 'Failed to toggle bestseller card.');
    return res.redirect('/admin/bestseller-cards');
  }
});

module.exports = router;

