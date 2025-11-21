// routes/deliveryOptionsAdmin.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const DeliveryOption = require('../models/DeliveryOption');

const router = express.Router();

/* ------------------------------------------------------------------
 * 🔐 Orders Admin gate (same as your snippet)
 * ------------------------------------------------------------------ */
function requireOrdersAdmin(req, res, next) {
  if (req.session && req.session.ordersAdmin) {return next();}
  req.flash('error', 'You must be logged in as Orders Admin.');
  return res.redirect('/admin/orders/login');
}

/* ------------------------------------------------------------------
 * 💲 Helpers
 * - parsePriceToCents: from your previous code
 * - centsToFloat: for rendering to forms
 * ------------------------------------------------------------------ */
function parsePriceToCents(input) {
  if (input === null || input === undefined) {return null;}
  const str = String(input)
    .trim()
    .replace(/[$,R\s]/gi, ''); // remove currency symbols/spaces
  if (str === '') {return null;}
  const n = Number(str);
  if (!Number.isFinite(n)) {return null;}
  return Math.round(n * 100);
}
function centsToFloat(cents) {
  const n = Number(cents || 0);
  return (n / 100).toFixed(2);
}

function resSafeNonce(req) {
  // support your app's pattern where res.locals.nonce is injected by helmet middleware
  return (req.res && req.res.locals && req.res.locals.nonce) || '';
}

/* ------------------------------------------------------------------
 * 🧭 List (with simple search/sort/pagination)
 * GET /admin/delivery-options
 * ------------------------------------------------------------------ */
router.get('/admin/delivery-options', requireOrdersAdmin, async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = resSafeNonce(req);

    // filters
    const q = String(req.query.q || '').trim();
    const active =
      req.query.active === 'true' ? true : req.query.active === 'false' ? false : undefined;

    // sorting
    const sortBy = ['name', 'priceCents', 'createdAt'].includes(req.query.sortBy)
      ? req.query.sortBy
      : 'createdAt';
    const order = req.query.order === 'asc' ? 1 : -1;

    // pagination
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(5, Number(req.query.limit || 10)));
    const skip = (page - 1) * limit;

    // build query
    const where = {};
    if (q) {
      where.$or = [
        { name: new RegExp(q, 'i') },
        { description: new RegExp(q, 'i') },
        { region: new RegExp(q, 'i') },
      ];
    }
    if (typeof active === 'boolean') {where.active = active;}

    const [items, total] = await Promise.all([
      DeliveryOption.find(where)
        .sort({ [sortBy]: order })
        .skip(skip)
        .limit(limit)
        .lean(),
      DeliveryOption.countDocuments(where),
    ]);

    // decorate amounts for display
    const rows = items.map((it) => ({
      ...it,
      price: centsToFloat(it.priceCents),
      basePrice: centsToFloat(it.basePriceCents),
      perKmPrice: centsToFloat(it.perKmPriceCents),
      maxPrice: it.maxPriceCents != null ? centsToFloat(it.maxPriceCents) : null,
    }));

    const pages = Math.max(1, Math.ceil(total / limit));

    return res.render('admin/delivery-options-list', {
      title: 'Delivery Options',
      active: 'delivery-options',
      nonce,
      themeCss,
      q,
      filterActive: req.query.active || '',
      sortBy,
      order,
      page,
      pages,
      limit,
      total,
      rows,
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error('[deliveryOptions] list error:', err);
    req.flash('error', 'Failed to load delivery options.');
    return res.redirect('/admin');
  }
});

/* ------------------------------------------------------------------
 * ➕ New form
 * GET /admin/delivery-options/new
 * ------------------------------------------------------------------ */
router.get('/admin/delivery-options/new', requireOrdersAdmin, (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
  const nonce = resSafeNonce(req);

  return res.render('admin/delivery-options-form', {
    title: 'Add Delivery Option',
    active: 'delivery-options',
    nonce,
    themeCss,
    mode: 'create',
    form: {
      name: '',
      description: '',
      region: '',
      price: '',
      basePrice: '',
      perKmPrice: '',
      maxPrice: '',
      active: true,
      type: 'flat', // "flat" | "distance"
      minDays: 1,
      maxDays: 5,
    },
    success: req.flash('success'),
    error: req.flash('error'),
    errors: [],
  });
});

/* ------------------------------------------------------------------
 * 💾 Create
 * POST /admin/delivery-options
 * ------------------------------------------------------------------ */
router.post(
  '/admin/delivery-options',
  requireOrdersAdmin,
  express.urlencoded({ extended: true }),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('type').isIn(['flat', 'distance']).withMessage('Type must be flat or distance'),
    body('minDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('minDays 0-60'),
    body('maxDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('maxDays 0-60'),
  ],
  async (req, res) => {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = resSafeNonce(req);

    const errors = validationResult(req);
    const form = {
      name: req.body.name || '',
      description: req.body.description || '',
      region: req.body.region || '',
      type: req.body.type || 'flat',
      price: req.body.price || '',
      basePrice: req.body.basePrice || '',
      perKmPrice: req.body.perKmPrice || '',
      maxPrice: req.body.maxPrice || '',
      active: req.body.active === 'on' || req.body.active === 'true' || req.body.active === true,
      minDays: Number(req.body.minDays || 0),
      maxDays: Number(req.body.maxDays || 0),
    };

    if (!errors.isEmpty()) {
      return res.status(400).render('admin/delivery-options-form', {
        title: 'Add Delivery Option',
        active: 'delivery-options',
        nonce,
        themeCss,
        mode: 'create',
        form,
        success: [],
        error: ['Please fix the errors and try again.'],
        errors: errors.array(),
      });
    }

    try {
      const doc = new DeliveryOption({
        name: form.name,
        description: form.description,
        region: form.region,
        type: form.type,
        active: form.active,
        minDays: form.minDays,
        maxDays: form.maxDays,
        // prices in cents
        priceCents: form.type === 'flat' ? parsePriceToCents(form.price) : null,
        basePriceCents: form.type === 'distance' ? parsePriceToCents(form.basePrice) : null,
        perKmPriceCents: form.type === 'distance' ? parsePriceToCents(form.perKmPrice) : null,
        maxPriceCents: form.type === 'distance' ? parsePriceToCents(form.maxPrice) : null,
      });

      await doc.save();
      req.flash('success', 'Delivery option created.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions] create error:', err);
      return res.status(500).render('admin/delivery-options-form', {
        title: 'Add Delivery Option',
        active: 'delivery-options',
        nonce,
        themeCss,
        mode: 'create',
        form,
        success: [],
        error: ['Failed to create delivery option.'],
        errors: [],
      });
    }
  },
);

/* ------------------------------------------------------------------
 * ✏️ Edit form
 * GET /admin/delivery-options/:id/edit
 * ------------------------------------------------------------------ */
router.get('/admin/delivery-options/:id/edit', requireOrdersAdmin, async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = resSafeNonce(req);

    const id = req.params.id;
    const doc = await DeliveryOption.findById(id).lean();
    if (!doc) {
      req.flash('error', 'Delivery option not found.');
      return res.redirect('/admin/delivery-options');
    }

    const form = {
      name: doc.name || '',
      description: doc.description || '',
      region: doc.region || '',
      type: doc.type || 'flat',
      active: !!doc.active,
      minDays: typeof doc.minDays === 'number' ? doc.minDays : 0,
      maxDays: typeof doc.maxDays === 'number' ? doc.maxDays : 0,
      // convert cents to strings for inputs
      price: doc.priceCents != null ? centsToFloat(doc.priceCents) : '',
      basePrice: doc.basePriceCents != null ? centsToFloat(doc.basePriceCents) : '',
      perKmPrice: doc.perKmPriceCents != null ? centsToFloat(doc.perKmPriceCents) : '',
      maxPrice: doc.maxPriceCents != null ? centsToFloat(doc.maxPriceCents) : '',
    };

    return res.render('admin/delivery-options-form', {
      title: 'Edit Delivery Option',
      active: 'delivery-options',
      nonce,
      themeCss,
      mode: 'edit',
      id,
      form,
      success: req.flash('success'),
      error: req.flash('error'),
      errors: [],
    });
  } catch (err) {
    console.error('[deliveryOptions] edit form error:', err);
    req.flash('error', 'Failed to load delivery option.');
    return res.redirect('/admin/delivery-options');
  }
});

/* ------------------------------------------------------------------
 * 🔄 Update
 * POST /admin/delivery-options/:id
 * ------------------------------------------------------------------ */
router.post(
  '/admin/delivery-options/:id',
  requireOrdersAdmin,
  express.urlencoded({ extended: true }),
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('type').isIn(['flat', 'distance']).withMessage('Type must be flat or distance'),
    body('minDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('minDays 0-60'),
    body('maxDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0, max: 60 })
      .withMessage('maxDays 0-60'),
  ],
  async (req, res) => {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = resSafeNonce(req);

    const id = req.params.id;
    const errors = validationResult(req);
    const form = {
      name: req.body.name || '',
      description: req.body.description || '',
      region: req.body.region || '',
      type: req.body.type || 'flat',
      active: req.body.active === 'on' || req.body.active === 'true' || req.body.active === true,
      minDays: Number(req.body.minDays || 0),
      maxDays: Number(req.body.maxDays || 0),
      price: req.body.price || '',
      basePrice: req.body.basePrice || '',
      perKmPrice: req.body.perKmPrice || '',
      maxPrice: req.body.maxPrice || '',
    };

    if (!errors.isEmpty()) {
      return res.status(400).render('admin/delivery-options-form', {
        title: 'Edit Delivery Option',
        active: 'delivery-options',
        nonce,
        themeCss,
        mode: 'edit',
        id,
        form,
        success: [],
        error: ['Please fix the errors and try again.'],
        errors: errors.array(),
      });
    }

    try {
      const update = {
        name: form.name,
        description: form.description,
        region: form.region,
        type: form.type,
        active: form.active,
        minDays: form.minDays,
        maxDays: form.maxDays,
        priceCents: null,
        basePriceCents: null,
        perKmPriceCents: null,
        maxPriceCents: null,
      };

      if (form.type === 'flat') {
        update.priceCents = parsePriceToCents(form.price);
      } else {
        update.basePriceCents = parsePriceToCents(form.basePrice);
        update.perKmPriceCents = parsePriceToCents(form.perKmPrice);
        update.maxPriceCents = parsePriceToCents(form.maxPrice);
      }

      await DeliveryOption.findByIdAndUpdate(id, update, { new: true });
      req.flash('success', 'Delivery option updated.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions] update error:', err);
      return res.status(500).render('admin/delivery-options-form', {
        title: 'Edit Delivery Option',
        active: 'delivery-options',
        nonce,
        themeCss,
        mode: 'edit',
        id,
        form,
        success: [],
        error: ['Failed to update delivery option.'],
        errors: [],
      });
    }
  },
);

/* ------------------------------------------------------------------
 * 🗑️ Delete
 * POST /admin/delivery-options/:id/delete
 * ------------------------------------------------------------------ */
router.post(
  '/admin/delivery-options/:id/delete',
  requireOrdersAdmin,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const id = req.params.id;
      await DeliveryOption.findByIdAndDelete(id);
      req.flash('success', 'Delivery option deleted.');
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions] delete error:', err);
      req.flash('error', 'Failed to delete delivery option.');
      return res.redirect('/admin/delivery-options');
    }
  },
);

/* ------------------------------------------------------------------
 * ✅ Enable / ❌ Disable toggle (quick action)
 * POST /admin/delivery-options/:id/toggle
 * ------------------------------------------------------------------ */
router.post(
  '/admin/delivery-options/:id/toggle',
  requireOrdersAdmin,
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const id = req.params.id;
      const doc = await DeliveryOption.findById(id);
      if (!doc) {
        req.flash('error', 'Delivery option not found.');
        return res.redirect('/admin/delivery-options');
      }
      doc.active = !doc.active;
      await doc.save();
      req.flash('success', `Delivery option ${doc.active ? 'enabled' : 'disabled'}.`);
      return res.redirect('/admin/delivery-options');
    } catch (err) {
      console.error('[deliveryOptions] toggle error:', err);
      req.flash('error', 'Failed to toggle delivery option.');
      return res.redirect('/admin/delivery-options');
    }
  },
);

/* ------------------------------------------------------------------
 * 🌐 Lightweight JSON API (for your checkout to list options)
 * GET /api/admin/delivery-options
 * ------------------------------------------------------------------ */
router.get('/api/admin/delivery-options', requireOrdersAdmin, async (_req, res) => {
  try {
    const docs = await DeliveryOption.find({}).sort({ createdAt: -1 }).lean();
    return res.json(docs);
  } catch (err) {
    console.error('[deliveryOptions] api list error:', err);
    return res.status(500).json({ message: 'Failed to fetch delivery options' });
  }
});

module.exports = router;
