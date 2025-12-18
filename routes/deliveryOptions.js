// routes/deliveryOptions.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const DeliveryOption = require('../models/DeliveryOption');

const router = express.Router();

/* -----------------------------------------------------------
 * 🔐 Admin gate (supports both admin + ordersAdmin)
 * --------------------------------------------------------- */
function requireAdminDelivery(req, res, next) {
  // ✅ main admin session (your admin dashboard login)
  if (req.session?.admin) return next();

  // ✅ optional: allow orders admin too (if you still use it)
  if (req.session?.ordersAdmin) return next();

  req.flash('error', 'You must be logged in as Admin to manage delivery options.');
  return res.redirect('/admin/login');
}

/* -----------------------------------------------------------
 * 🧰 Helpers
 * --------------------------------------------------------- */
function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}

function themeCssFrom(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function parsePriceToCents(input) {
  if (input === null || input === undefined) return 0;

  const str = String(input).trim().replace(/[$,R\s]/gi, '');
  if (!str) return 0;

  const n = Number(str);
  if (!Number.isFinite(n)) return 0;

  // protect from negative
  return Math.max(0, Math.round(n * 100));
}

/* -----------------------------------------------------------
 * NOTE: This router is mounted like:
 *   app.use('/admin', deliveryOptionRouter)
 * So paths below are "/delivery-options", not "/admin/delivery-options".
 * --------------------------------------------------------- */

/* -----------------------------------------------------------
 * 📃 LIST: GET /admin/delivery-options
 * --------------------------------------------------------- */
router.get('/delivery-options', requireAdminDelivery, async (req, res) => {
  try {
    const nonce = resNonce(req);
    const themeCss = themeCssFrom(req);

    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim(); // '' | 'active' | 'inactive'

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(5, Number(req.query.limit || 10)));
    const skip = (page - 1) * limit;

    const where = {};
    if (q) where.name = new RegExp(q, 'i');
    if (status === 'active') where.active = true;
    if (status === 'inactive') where.active = false;

    const [options, total] = await Promise.all([
      DeliveryOption.find(where).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      DeliveryOption.countDocuments(where),
    ]);

    return res.render('delivery-options/list', {
      title: 'Delivery Options',
      themeCss,
      nonce,
      options,
      initialFilters: { q, status },
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
      page,
      total,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error('[deliveryOptions:list] error:', err);
    req.flash('error', 'Failed to load delivery options.');
    return res.redirect('/admin/dashboard');
  }
});

/* -----------------------------------------------------------
 * ➕ NEW FORM: GET /admin/delivery-options/new
 * --------------------------------------------------------- */
router.get('/delivery-options/new', requireAdminDelivery, (req, res) => {
  const nonce = resNonce(req);
  const themeCss = themeCssFrom(req);

  return res.render('delivery-options/form', {
    title: 'New Delivery Option',
    themeCss,
    nonce,
    mode: 'create',
    doc: {
      name: '',
      deliveryDays: 0,
      priceCents: 0,
      active: true,
      description: '',
      region: '',
    },
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
    warning: req.flash('warning'),
  });
});

/* -----------------------------------------------------------
 * 💾 CREATE: POST /admin/delivery-options
 * --------------------------------------------------------- */
router.post(
  '/delivery-options',
  requireAdminDelivery,
  express.urlencoded({ extended: true }),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('deliveryDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('Delivery days must be 0–60'),
    body('price').optional({ checkFalsy: true }).isString(),
  ],
  async (req, res) => {
    const nonce = resNonce(req);
    const themeCss = themeCssFrom(req);

    const errors = validationResult(req);

    const doc = {
      name: req.body.name || '',
      deliveryDays: Number(req.body.deliveryDays || 0),
      priceCents: parsePriceToCents(req.body.price),
      active: req.body.active === 'on' || req.body.active === 'true' || req.body.active === true,
      description: req.body.description || '',
      region: req.body.region || '',
    };

    if (!errors.isEmpty()) {
      return res.status(400).render('delivery-options/form', {
        title: 'New Delivery Option',
        themeCss,
        nonce,
        mode: 'create',
        doc,
        success: [],
        error: errors.array().map((e) => e.msg),
        info: [],
        warning: [],
      });
    }

    try {
      await DeliveryOption.create(doc);
      req.flash('success', 'Delivery option created.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions:create] error:', err);
      return res.status(500).render('delivery-options/form', {
        title: 'New Delivery Option',
        themeCss,
        nonce,
        mode: 'create',
        doc,
        success: [],
        error: ['Failed to create delivery option.'],
        info: [],
        warning: [],
      });
    }
  },
);

/* -----------------------------------------------------------
 * ✏️ EDIT FORM: GET /admin/delivery-options/:id/edit
 * --------------------------------------------------------- */
router.get('/delivery-options/:id/edit', requireAdminDelivery, async (req, res) => {
  try {
    const nonce = resNonce(req);
    const themeCss = themeCssFrom(req);

    const doc = await DeliveryOption.findById(req.params.id).lean();
    if (!doc) {
      req.flash('error', 'Delivery option not found.');
      return res.redirect('/admin/delivery-options');
    }

    return res.render('delivery-options/form', {
      title: 'Edit Delivery Option',
      themeCss,
      nonce,
      mode: 'edit',
      doc,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('[deliveryOptions:editForm] error:', err);
    req.flash('error', 'Failed to load delivery option.');
    return res.redirect('/admin/delivery-options');
  }
});

/* -----------------------------------------------------------
 * 🔄 UPDATE: POST /admin/delivery-options/:id
 * --------------------------------------------------------- */
router.post(
  '/delivery-options/:id',
  requireAdminDelivery,
  express.urlencoded({ extended: true }),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('deliveryDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('Delivery days must be 0–60'),
    body('price').optional({ checkFalsy: true }).isString(),
  ],
  async (req, res) => {
    const nonce = resNonce(req);
    const themeCss = themeCssFrom(req);

    const errors = validationResult(req);
    const id = req.params.id;

    const doc = {
      name: req.body.name || '',
      deliveryDays: Number(req.body.deliveryDays || 0),
      priceCents: parsePriceToCents(req.body.price),
      active: req.body.active === 'on' || req.body.active === 'true' || req.body.active === true,
      description: req.body.description || '',
      region: req.body.region || '',
    };

    if (!errors.isEmpty()) {
      return res.status(400).render('delivery-options/form', {
        title: 'Edit Delivery Option',
        themeCss,
        nonce,
        mode: 'edit',
        doc: { _id: id, ...doc },
        success: [],
        error: errors.array().map((e) => e.msg),
        info: [],
        warning: [],
      });
    }

    try {
      const updated = await DeliveryOption.findByIdAndUpdate(id, doc, { new: true });
      if (!updated) {
        req.flash('error', 'Delivery option not found.');
        return res.redirect('/admin/delivery-options');
      }
      req.flash('success', 'Delivery option updated.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions:update] error:', err);
      return res.status(500).render('delivery-options/form', {
        title: 'Edit Delivery Option',
        themeCss,
        nonce,
        mode: 'edit',
        doc: { _id: id, ...doc },
        success: [],
        error: ['Failed to update delivery option.'],
        info: [],
        warning: [],
      });
    }
  },
);

/* -----------------------------------------------------------
 * ✅ TOGGLE ACTIVE: POST /admin/delivery-options/:id/toggle
 * --------------------------------------------------------- */
router.post(
  '/delivery-options/:id/toggle',
  requireAdminDelivery,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const id = req.params.id;
      const opt = await DeliveryOption.findById(id);
      if (!opt) {
        req.flash('error', 'Delivery option not found.');
        return res.redirect('/admin/delivery-options');
      }
      opt.active = !opt.active;
      await opt.save();
      req.flash('success', `Delivery option ${opt.active ? 'activated' : 'deactivated'}.`);
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions:toggle] error:', err);
      req.flash('error', 'Failed to toggle delivery option.');
      return res.redirect('/admin/delivery-options');
    }
  },
);

/* -----------------------------------------------------------
 * 🗑️ DELETE: POST /admin/delivery-options/:id/delete
 * --------------------------------------------------------- */
router.post(
  '/delivery-options/:id/delete',
  requireAdminDelivery,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const deleted = await DeliveryOption.findByIdAndDelete(req.params.id);
      if (!deleted) {
        req.flash('error', 'Delivery option not found.');
        return res.redirect('/admin/delivery-options');
      }
      req.flash('success', 'Delivery option deleted.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions:delete] error:', err);
      req.flash('error', 'Failed to delete delivery option.');
      return res.redirect('/admin/delivery-options');
    }
  },
);

module.exports = router;
