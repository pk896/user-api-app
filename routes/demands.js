// routes/demands.js
'use strict';
const express = require('express');
const router = express.Router();
const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');
const DemandedProduct = require('../models/DemandedProduct');

/**
 * Mounted at /demands:
 *   GET  /demands            -> redirect to /demands/mine
 *   GET  /demands/add        -> render add form
 *   POST /demands/add        -> create demand
 *   GET  /demands/mine       -> list current business's demands
 *   GET  /demands/aggregate  -> aggregated view
 */

router.get('/', requireBusiness, (_req, res) => res.redirect('/demands/mine'));

router.get('/add', requireBusiness, (req, res) => {
  const business = req.session.business;
  res.render('demands/add-demand', {
    title: 'Add Demand',
    business,
    defaultBusinessName: business?.name || '',
    success: req.flash('success'),
    error: req.flash('error'),
    themeCss: res.locals.themeCss,
    nonce: res.locals.nonce,
  });
});

router.post('/add', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const b = req.session.business;
    const {
      requesterBusinessName,
      requesterContactName,
      requesterPosition,
      type,
      productName,
      quantity,
      country,
      province,
      city,
      town,
      notes,
    } = req.body;

    if (!requesterBusinessName || !requesterContactName || !requesterPosition) {
      req.flash('error', 'Please enter your business name, your name, and your position.');
      return res.redirect('/demands/add');
    }

    await DemandedProduct.create({
      business: b._id,
      requester: {
        businessName: String(requesterBusinessName).trim(),
        contactName: String(requesterContactName).trim(),
        position: String(requesterPosition).trim(),
      },
      type: String(type || '').trim(),
      productName: String(productName || '').trim(),
      quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
      country: String(country || '').trim(),
      province: String(province || '').trim(),
      city: String(city || '').trim(),
      town: String(town || '').trim(),
      notes: (notes || '').trim(),
    });

    req.flash('success', '✅ Demand submitted.');
    res.redirect('/demands/mine');
  } catch (err) {
    console.error('❌ Add demand error:', err);
    req.flash('error', 'Failed to submit demand.');
    res.redirect('/demands/add');
  }
});

router.get('/mine', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const demands = await DemandedProduct.find({ business: business._id })
      .sort({ createdAt: -1 })
      .lean();

    res.render('demands/my-demands', {
      title: 'My Demands',
      business,
      demands,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ List demands error:', err);
    req.flash('error', 'Failed to load demands.');
    res.redirect('/business/dashboard');
  }
});

router.get('/aggregate', requireBusiness, async (req, res) => {
  try {
    // ----- base data: all demands (lean for speed)
    const demandsAll = await DemandedProduct.find({})
      .select({
        requester: 1,
        type: 1,
        productName: 1,
        quantity: 1,
        country: 1,
        province: 1,
        city: 1,
        town: 1,
        notes: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1 })
      .lean();

    // ----- KPIs + type list
    const totalRequests = demandsAll.length;
    const typesSet = new Set();
    let totalQtyAll = 0;

    // summary by productName (normalized)
    const nameSummaryMap = new Map();
    for (const d of demandsAll) {
      const type = (d.type || '').trim();
      if (type) {typesSet.add(type);}

      const qty = Number(d.quantity || 0);
      totalQtyAll += qty;

      const key = String(d.productName || '')
        .trim()
        .toLowerCase();
      if (!nameSummaryMap.has(key)) {
        nameSummaryMap.set(key, {
          name: d.productName || '',
          requests: 0,
          totalQty: 0,
          types: new Set(),
        });
      }
      const entry = nameSummaryMap.get(key);
      entry.requests += 1;
      entry.totalQty += qty;
      if (type) {entry.types.add(type);}
    }

    const summaryByName = Array.from(nameSummaryMap.values())
      .map((e) => ({
        name: e.name,
        requests: e.requests,
        totalQty: e.totalQty,
        types: Array.from(e.types).sort(),
      }))
      .sort((a, b) => b.totalQty - a.totalQty);

    const uniqueProductNames = summaryByName.length;
    const types = Array.from(typesSet).sort();

    // ----- existing aggregations
    const byType = await DemandedProduct.aggregate([
      { $group: { _id: '$type', totalQty: { $sum: '$quantity' }, docs: { $sum: 1 } } },
      { $sort: { totalQty: -1 } },
    ]);

    const byTypeAndLocation = await DemandedProduct.aggregate([
      {
        $group: {
          _id: {
            type: '$type',
            country: '$country',
            province: '$province',
            city: '$city',
            town: '$town',
          },
          totalQty: { $sum: '$quantity' },
          docs: { $sum: 1 },
        },
      },
      { $sort: { '_id.type': 1, totalQty: -1 } },
    ]);

    res.render('demands/demanded-products', {
      title: 'Demanded Products (Aggregated)',
      business: req.session.business,
      // new data for the view
      demandsAll,
      summaryByName,
      totals: { totalRequests, uniqueProductNames, totalQtyAll },
      types,
      // existing tables
      byType,
      byTypeAndLocation,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Aggregation error:', err);
    req.flash('error', 'Failed to load demanded products.');
    res.redirect('/business/dashboard');
  }
});

module.exports = router;
