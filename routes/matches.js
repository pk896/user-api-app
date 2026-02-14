// routes/matches.js
'use strict';
const express = require('express');
const router = express.Router();

const MatchedDemand = require('../models/MatchedDemand');
const Demand = require('../models/Demand');
const DemandedProduct = require('../models/DemandedProduct'); // fallback model
const Product = require('../models/Product');
const Notification = require('../models/Notification');

const requireBusiness = require('../middleware/requireBusiness');
const requireRole = require('../middleware/requireRole');
const { sendMail } = require('../utils/mailer');

// Convert a plain text string into a minimal HTML (line breaks -> <br>)
function textToHtml(s = '') {
  return `<p>${String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`;
}

/**
 * Email helper, now using sendMail() (SendGrid). No-op if "to" missing.
 * You can pass { to, subject, text, html?, replyTo? }.
 * - If html isn't provided, a simple HTML fallback is generated from text.
 */
async function sendBuyerEmail({ to, subject, text, html, replyTo }) {
  if (!to) {return;} // quietly skip if no recipient
  await sendMail({
    to,
    subject,
    text: text || '',
    html: html || textToHtml(text || ''),
    // Optionally let buyers reply to supplier or support:
    // Prefer explicit replyTo if provided, otherwise fall back to SMTP_FROM
    replyTo: replyTo || process.env.SMTP_FROM || 'Unicoporate <phakisingxongxela@gmail.com>',
  });
}

/* ---------------------------------------------
 * Middleware: request logger
 * ------------------------------------------- */
router.use((req, _res, next) => {
  console.log('[/matches]', req.method, req.originalUrl);
  next();
});

// Simple health
router.get('/_ping', (_req, res) => res.send('matches: ok'));

/* ---------------------------------------------
 * Core: TYPE-ONLY matching
 * ------------------------------------------- */
async function runMatchingTypeOnly(req, res) {
  try {
    const buyer = req.session.business;
    if (!buyer) {
      req.flash('error', 'Please log in as a buyer.');
      return res.redirect('/business/login');
    }

    const demandId = req.params.demandId;
    if (!demandId) {
      req.flash('error', 'Missing demand id.');
      return res.redirect('/demands/my-demands');
    }

    // Load demand from either model (historical support)
    let demand = await Demand.findById(demandId).lean();
    if (!demand) {demand = await DemandedProduct.findById(demandId).lean();}
    if (!demand) {
      console.warn('[/matches/run] demand not found by id', demandId);
      req.flash('error', 'Demand not found.');
      return res.redirect('/demands/my-demands');
    }

    // Robust owner check across historical fields
    const bizId = String(buyer._id);
    const candidateOwnerIds = [
      demand.buyerId,
      demand.buyer,
      demand.business,
      demand.owner,
      demand.requesterBusinessId,
      demand.requester && demand.requester.businessId,
      demand.requester && demand.requester.business && demand.requester.business._id,
    ]
      .filter(Boolean)
      .map(String);

    const isOwner = candidateOwnerIds.some((id) => id === bizId);
    if (!isOwner) {
      console.warn('[/matches/run] owner check failed', {
        demandId: String(demand._id),
        bizId,
        candidateOwnerIds,
      });
      req.flash('error', 'Demand not found (owner check failed).');
      return res.redirect('/demands/my-demands');
    }

    // Type-only
    const dTypeRaw = String(demand.productType || demand.type || '').trim();
    if (!dTypeRaw) {
      req.flash('error', "This demand has no 'type'. Set a type first to find matches.");
      return res.redirect('/demands/my-demands');
    }

    // Case-insensitive EXACT match on Product.type
    const esc = dTypeRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const products = await Product.find({
      type: { $regex: new RegExp('^' + esc + '$', 'i') },
    })
      .limit(1000)
      .lean();

    let created = 0,
      updated = 0;

    for (const p of products) {
      const supplierId = p.business || p.businessId; // tolerate both field names
      if (!supplierId) {continue;}

      const snapshot = {
        demandTitle: demand.title || demand.productName || demand.type || dTypeRaw,
        demandQuantity: demand.quantity,
        demandLocation:
          demand.location ||
          [demand.country, demand.province, demand.city, demand.town].filter(Boolean).join(', '),
        productName: p.name,
        productType: p.type,
        productPrice: p.price,
        productLocation:
          p.location || [p.country, p.province, p.city, p.town].filter(Boolean).join(', '),
      };

      const updateDoc = {
        demandId: demand._id,
        buyerId: buyer._id,
        supplierId,
        productId: p._id,
        score: 100, // strict type-only
        snapshot,
      };

      const resUpsert = await MatchedDemand.updateOne(
        { demandId: demand._id, productId: p._id },
        { $set: updateDoc, $setOnInsert: { status: 'pending' } },
        { upsert: true },
      );

      // count inserts reliably across Mongoose versions
      if (resUpsert.upsertedId || resUpsert.upsertedCount > 0) {created++;}
      else {updated++;}
    }

    req.flash('success', `Matched by type "${dTypeRaw}" — ${created} new, ${updated} updated.`);
    return res.redirect(`/matches/buyer?demand=${demand._id}`);
  } catch (err) {
    console.error('[matches.run type-only] error:', err);
    req.flash('error', 'Failed to run matching.');
    return res.redirect('/demands/my-demands');
  }
}

// Mount GET + POST (GET is handy for testing from a link)
router.get('/run/:demandId', requireBusiness, requireRole('buyer'), (req, res, next) => {
  console.log('role=', req.session?.business?.role || req.session?.business?.type);
  console.log('session id=', req.session.id);
  return runMatchingTypeOnly(req, res, next);
});
router.post('/run/:demandId', requireBusiness, requireRole('buyer'), runMatchingTypeOnly);

/* ---------------------------------------------
 * Buyer view: matched products (with optional demand filter)
 * ------------------------------------------- */
router.get('/buyer', requireBusiness, requireRole('buyer'), async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = res.locals.nonce || '';
    const buyer = req.session.business;

    // (Optional) pagination support
    const page = Math.max(1, Number(req.query.page || 1));
    const per = Math.min(50, Math.max(5, Number(req.query.per || 20)));

    const demandFilter = req.query.demand ? { demandId: req.query.demand } : {};
    const q = { buyerId: buyer._id, ...demandFilter };

    const total = await MatchedDemand.countDocuments(q);
    const matches = await MatchedDemand.find(q)
      .sort({ score: -1, createdAt: -1 })
      .skip((page - 1) * per)
      .limit(per)
      .populate('demandId')
      .populate('productId')
      .populate('supplierId')
      .lean();

    res.render('matches/matched-products', {
      title: 'Matched Products',
      active: 'matches-buyer',
      themeCss,
      nonce,
      matches,
      success: req.flash('success'),
      error: req.flash('error'),
      business: buyer,
      // pager state
      page,
      per,
      total,
      pages: Math.ceil(total / per),
      demand: req.query.demand || '',
    });
  } catch (err) {
    console.error('[matches.buyer]', err);
    req.flash('error', 'Could not load matched products.');
    return res.redirect('/demands/my-demands');
  }
});

/* ---------------------------------------------
 * Supplier view: matched demands (Only Pending default + pagination)
 * ------------------------------------------- */
router.get('/supplier', requireBusiness, requireRole('supplier'), async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = res.locals.nonce || '';
    const supplier = req.session.business;

    const page = Math.max(1, Number(req.query.page || 1));
    const per = Math.min(50, Math.max(5, Number(req.query.per || 20)));

    // Default to onlyPending=1 unless explicitly set to 0
    const onlyPending = String(req.query.onlyPending ?? '1') !== '0';
    const statusFilter = onlyPending ? { status: 'pending' } : {};
    const q = { supplierId: supplier._id, ...statusFilter };

    const total = await MatchedDemand.countDocuments(q);
    const matches = await MatchedDemand.find(q)
      .sort({ status: 1, score: -1, createdAt: -1 })
      .skip((page - 1) * per)
      .limit(per)
      .populate('demandId')
      .populate('productId')
      .populate('buyerId')
      .lean();

    res.render('matches/matched-demands', {
      title: 'Matched Demands',
      active: 'matches-supplier',
      themeCss,
      nonce,
      matches,
      success: req.flash('success'),
      error: req.flash('error'),
      business: supplier,
      // pager + filter state
      page,
      per,
      total,
      pages: Math.ceil(total / per),
      onlyPending,
    });
  } catch (err) {
    console.error('[matches.supplier]', err);
    req.flash('error', 'Could not load matched demands.');
    return res.redirect('/dashboard');
  }
});

/* ---------------------------------------------
 * Supplier respond (accept / reject + optional message)
 * - creates Notification for buyer
 * - optionally emails buyer on "accepted"
 * ------------------------------------------- */
router.post('/:matchId/respond', requireBusiness, requireRole('supplier'), async (req, res) => {
  try {
    const supplier = req.session.business;
    const { action, message } = req.body;

    const match = await MatchedDemand.findOne({
      _id: req.params.matchId,
      supplierId: supplier._id,
    })
      .populate('buyerId')
      .populate('productId')
      .populate('demandId');

    if (!match) {
      req.flash('error', 'Match not found.');
      return res.redirect('/matches/supplier');
    }

    if (!['accepted', 'rejected', 'pending'].includes(action)) {
      req.flash('error', 'Invalid action.');
      return res.redirect('/matches/supplier');
    }

    match.status = action;
    match.supplierMessage = String(message || '').slice(0, 500);
    await match.save();

    const demandTitle =
      match.snapshot?.demandTitle ||
      match.demandId?.title ||
      match.demandId?.productName ||
      match.demandId?.type ||
      'Demand';

    const productName = match.snapshot?.productName || match.productId?.name || 'Product';

    // ✅ use _id if populated, or the raw ObjectId if not
    await Notification.create({
      buyerId: match.buyerId?._id || match.buyerId,
      type: `match.${action}`, // enum: match.accepted | match.rejected | match.pending
      matchId: match._id,
      demandId: match.demandId?._id || match.demandId,
      productId: match.productId?._id || match.productId,
      supplierId: supplier._id,
      title:
        action === 'accepted'
          ? `Supplier accepted your match: ${productName}`
          : action === 'rejected'
            ? `Supplier rejected your match: ${productName}`
            : `Match updated: ${productName}`,
      message: message || `Demand: ${demandTitle}`,
    });

    const buyerEmail = match.buyerId?.email || match.buyerId?.contactEmail || null;

    if (action === 'accepted' && buyerEmail) {
      try {
        await sendBuyerEmail({
          to: buyerEmail,
          subject: `[Phakisi] Supplier accepted your demand match`,
          text: `${supplier.name || 'Supplier'} accepted your match for ${productName}.

Demand: ${demandTitle}
Message: ${match.supplierMessage || '—'}`,
          // You could set replyTo to supplier email if available on session/business record
          replyTo:
            supplier.email ||
            supplier.contactEmail ||
            process.env.SMTP_FROM ||
            'support@unicoporate.co.za',
        });
      } catch (e) {
        // Don’t block the flow on email failure; notification already created
        console.warn('[matches.respond] email send failed:', e.message);
      }
    }

    req.flash('success', `Response recorded: ${action.toUpperCase()}.`);
    return res.redirect('/matches/supplier');
  } catch (err) {
    console.error('[matches.respond]', err);
    req.flash('error', 'Failed to record response.');
    return res.redirect('/matches/supplier');
  }
});

/* ---------------------------------------------
 * Buyer summary (JSON) — totals + per-demand
 * ------------------------------------------- */
router.get('/buyer/summary', requireBusiness, requireRole('buyer'), async (req, res) => {
  try {
    const buyer = req.session.business;
    const since = req.session.buyerMatchesLastSeenAt
      ? new Date(req.session.buyerMatchesLastSeenAt)
      : null;

    // status counters
    const statusAgg = await MatchedDemand.aggregate([
      { $match: { buyerId: buyer._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const counters = { total: 0, pending: 0, accepted: 0, rejected: 0 };
    for (const r of statusAgg) {
      counters[r._id] = r.count;
      counters.total += r.count;
    }

    // new since last seen
    let newSince = 0;
    if (since) {
      newSince = await MatchedDemand.countDocuments({
        buyerId: buyer._id,
        updatedAt: { $gt: since },
      });
    }

    // per-demand aggregation
    const perDemandAgg = await MatchedDemand.aggregate([
      { $match: { buyerId: buyer._id } },
      { $group: { _id: { demandId: '$demandId', status: '$status' }, count: { $sum: 1 } } },
    ]);

    const perDemandMap = new Map();
    for (const row of perDemandAgg) {
      const did = String(row._id.demandId);
      if (!perDemandMap.has(did))
        {perDemandMap.set(did, { demandId: did, pending: 0, accepted: 0, rejected: 0, total: 0 });}
      const bucket = perDemandMap.get(did);
      bucket[row._id.status] = row.count;
      bucket.total += row.count;
    }

    const demandIds = Array.from(perDemandMap.keys());
    const demands = demandIds.length
      ? await Demand.find({ _id: { $in: demandIds } }, { title: 1, productName: 1, type: 1 }).lean()
      : [];
    const titleById = new Map(
      demands.map((d) => [String(d._id), d.title || d.productName || d.type || 'Demand']),
    );

    const perDemand = Array.from(perDemandMap.values())
      .map((x) => ({ ...x, title: titleById.get(x.demandId) || 'Demand' }))
      .sort((a, b) => b.total - a.total);

    res.json({ ok: true, counters: { ...counters, newSince }, perDemand });
  } catch (err) {
    console.error('[matches.buyer/summary]', err);
    res.status(500).json({ ok: false, message: 'Failed to load summary' });
  }
});

module.exports = router;
