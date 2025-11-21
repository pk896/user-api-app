// routes/shipments.js
const express = require('express');
const router = express.Router();

const Shipment = require('../models/Shipment');
const Product = require('../models/Product');
const Order = require('../models/Order');
const requireBusiness = require('../middleware/requireBusiness');

/* ---------------------------------------------
 * Helpers
 * ------------------------------------------- */
function escapeRegex(s = '') {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const ALLOWED_STATUSES = [
  'Pending',
  'Processing',
  'In Transit',
  'Delivered',
  'Canceled',
  'Cancelled',
];

function normalizeStatus(s) {
  const val = String(s || '').trim();
  // Accept both spellings explicitly
  if (val === 'Cancelled') {return 'Cancelled';}
  if (val === 'Canceled') {return 'Canceled';}
  return ALLOWED_STATUSES.includes(val) ? val : undefined;
}

/* ===========================================================
 * GET: All Shipments (with server-side filters)
 *    /shipments?q=&status=
 * =========================================================== */
router.get('/', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';

    const q = String(req.query.q || '').trim();
    const statusRaw = String(req.query.status || '').trim();
    const status = normalizeStatus(statusRaw) || (statusRaw ? statusRaw : '');

    const filter = { business: business._id };
    if (status) {filter.status = status;}

    // Text search across several fields + product name
    if (q) {
      const regex = new RegExp(escapeRegex(q), 'i');

      // match products by name that belong to this business
      const prodIds = await Product.find(
        { business: business._id, name: regex },
        { _id: 1 },
      ).lean();

      filter.$or = [
        { orderId: regex },
        { carrier: regex },
        { trackingNumber: regex },
        { buyerName: regex },
        { buyerEmail: regex },
        ...(prodIds.length ? [{ product: { $in: prodIds.map((p) => p._id) } }] : []),
      ];
    }

    const shipments = await Shipment.find(filter)
      .populate('product', 'name price customId')
      .sort({ updatedAt: -1 })
      .lean();

    res.render('shipments/all-shipments', {
      title: 'Manage Shipments',
      business,
      shipments,
      themeCss,
      nonce: res.locals.nonce,
      success: req.flash('success'),
      error: req.flash('error'),
      initialFilters: { q, status }, // for client prefill
    });
  } catch (err) {
    console.error('❌ Error loading shipments:', err);
    req.flash('error', 'Failed to load shipments.');
    res.redirect('/business/dashboard');
  }
});

/* ===========================================================
 * GET: Add Shipment page
 * =========================================================== */
router.get('/add', requireBusiness, async (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';

  const products = await Product.find({ business: req.session.business._id })
    .select('name _id customId')
    .lean();

  res.render('shipments/add-shipment', {
    title: 'Add Shipment',
    business: req.session.business,
    products,
    themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});

/* ===========================================================
 * POST: Create Shipment (optionally link to an Order by orderId)
 * =========================================================== */
router.post('/add', requireBusiness, async (req, res) => {
  try {
    const {
      orderId,
      productId,
      buyerName,
      buyerEmail,
      address,
      trackingNumber,
      status,
      quantity,
      carrier,
    } = req.body;

    const normalizedStatus = normalizeStatus(status) || 'Processing';
    const qty = Math.max(1, Number(quantity) || 1);

    const shipment = await Shipment.create({
      business: req.session.business._id,
      orderId: orderId?.trim() || undefined,
      product: productId?.trim() || undefined,
      buyerName: buyerName?.trim() || undefined,
      buyerEmail: buyerEmail?.trim() || undefined,
      address: address?.trim() || undefined,
      carrier: carrier?.trim() || undefined,
      trackingNumber: trackingNumber?.trim() || undefined,
      status: normalizedStatus,
      quantity: qty, // requires this field in the Shipment model
      history: [
        {
          status: normalizedStatus,
          note: 'Shipment created',
          at: new Date(),
        },
      ],
    });

    // Mirror fulfillment on the Order if supplied
    if (shipment.orderId) {
      const order = await Order.findOne({ orderId: shipment.orderId });
      if (order) {
        order.fulfillment.status = normalizedStatus;
        if (carrier) {order.fulfillment.carrier = carrier;}
        if (trackingNumber) {order.fulfillment.trackingNumber = trackingNumber;}
        order.fulfillment.history = order.fulfillment.history || [];
        order.fulfillment.history.push({
          status: normalizedStatus,
          note: 'Shipment created',
          at: new Date(),
        });
        await order.save();
      }
    }

    req.flash('success', '✅ Shipment created successfully!');
    res.redirect('/shipments');
  } catch (err) {
    console.error('❌ Error creating shipment:', err);
    req.flash('error', 'Failed to create shipment.');
    res.redirect('/shipments/add');
  }
});

/* ===========================================================
 * GET: Track page (buyer) – supports prefill
 * =========================================================== */
router.get('/track', async (req, res) => {
  const theme = req.session.theme || 'light';
  const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
  const canManage = Boolean(req.session?.admin || req.session?.business);
  const prefill = (req.query.prefill || '').trim();

  res.render('shipments/track-shipment', {
    title: 'Track Shipment',
    themeCss,
    business: req.session.business,
    admin: req.session.admin || null,
    canManage,
    prefill,
    shipment: null,
    shipmentsByProduct: null,
    error: req.flash('error'),
    success: req.flash('success'),
    nonce: res.locals.nonce,
  });
});

/* ===========================================================
 * GET: Shipments by product (business/admin only)
 * =========================================================== */
router.get('/by-product/:productId', requireBusiness, async (req, res) => {
  try {
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const canManage = true;

    const product = await Product.findById(req.params.productId).select('name _id customId').lean();
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/shipments');
    }

    const shipmentsByProduct = await Shipment.find({
      product: product._id,
      business: req.session.business._id,
    })
      .sort({ updatedAt: -1 })
      .lean();

    res.render('shipments/track-shipment', {
      title: `Shipments for ${product.name}`,
      themeCss,
      business: req.session.business,
      admin: req.session.admin || null,
      canManage,
      prefill: '',
      shipment: null,
      shipmentsByProduct,
      productForList: {
        _id: product._id,
        name: product.name,
        customId: product.customId,
      },
      error: req.flash('error'),
      success: req.flash('success'),
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Error loading shipments by product:', err);
    req.flash('error', 'Failed to load shipments for product.');
    res.redirect('/shipments');
  }
});

/* ===========================================================
 * POST: Track by Order ID or Tracking #
 * =========================================================== */
router.post('/track', async (req, res) => {
  try {
    const { query } = req.body;
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const canManage = Boolean(req.session?.admin || req.session?.business);

    const needle = (query || '').trim();
    if (!needle) {
      req.flash('error', 'Please enter an Order ID or Tracking Number.');
      return res.redirect('/shipments/track');
    }

    const shipment = await Shipment.findOne({
      $or: [{ orderId: needle }, { trackingNumber: needle }],
    })
      .populate('product', 'name price')
      .populate('business', 'name email')
      .lean();

    if (!shipment) {
      req.flash('error', '❌ No shipment found for that Order ID or Tracking Number.');
      return res.redirect('/shipments/track');
    }

    res.render('shipments/track-shipment', {
      title: 'Track Shipment',
      themeCss,
      shipment,
      business: req.session.business,
      admin: req.session.admin || null,
      canManage,
      success: req.flash('success'),
      error: req.flash('error'),
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Error tracking shipment:', err);
    req.flash('error', 'Server error. Try again later.');
    res.redirect('/shipments/track');
  }
});

/* ===========================================================
 * POST: Update status + mirror + ONE-TIME inventory adjustment
 * =========================================================== */
router.post('/update/:id', requireBusiness, async (req, res) => {
  try {
    const { status, trackingNumber, note, carrier } = req.body;

    const shipment = await Shipment.findOne({
      _id: req.params.id,
      business: req.session.business._id,
    });

    if (!shipment) {
      req.flash('error', 'Shipment not found or unauthorized.');
      return res.redirect('/shipments');
    }

    const normalizedStatus = normalizeStatus(status) || shipment.status;

    // Append to history
    shipment.history.push({
      status: normalizedStatus,
      note: note || `Status changed to ${normalizedStatus}`,
      at: new Date(),
    });

    // Update main fields
    shipment.status = normalizedStatus;
    if (typeof carrier === 'string' && carrier.trim()) {shipment.carrier = carrier.trim();}
    if (typeof trackingNumber === 'string' && trackingNumber.trim())
      {shipment.trackingNumber = trackingNumber.trim();}

    // Auto timestamps
    if (normalizedStatus === 'In Transit' && !shipment.shippedAt) {
      shipment.shippedAt = new Date();
    } else if (normalizedStatus === 'Delivered') {
      shipment.deliveredAt = new Date();
    }

    // ONE-TIME inventory update when first delivered
    if (normalizedStatus === 'Delivered' && !shipment.inventoryCounted && shipment.product) {
      const qty = Math.max(1, Number(shipment.quantity) || 1);

      // Atomic update to avoid race conditions
      await Product.updateOne(
        { _id: shipment.product },
        { $inc: { stock: -qty, soldCount: qty, soldOrders: 1 } },
      );

      shipment.inventoryCounted = true;
    }

    await shipment.save();

    // Mirror to Order (if linked)
    if (shipment.orderId) {
      const order = await Order.findOne({ orderId: shipment.orderId });
      if (order) {
        order.fulfillment.status = normalizedStatus;
        if (carrier) {order.fulfillment.carrier = carrier;}
        if (trackingNumber) {order.fulfillment.trackingNumber = trackingNumber;}
        order.fulfillment.history = order.fulfillment.history || [];
        order.fulfillment.history.push({
          status: normalizedStatus,
          note: note || `Status changed to ${normalizedStatus}`,
          at: new Date(),
        });

        if (normalizedStatus === 'In Transit' && !order.fulfillment.shippedAt) {
          order.fulfillment.shippedAt = new Date();
        } else if (normalizedStatus === 'Delivered') {
          order.fulfillment.deliveredAt = new Date();
        }

        await order.save();
      }
    }

    req.flash('success', `🚚 Shipment marked as ${normalizedStatus}.`);
    res.redirect('/shipments');
  } catch (err) {
    console.error('❌ Error updating shipment:', err);
    req.flash('error', 'Failed to update shipment.');
    res.redirect('/shipments');
  }
});

/* ===========================================================
 * POST: Delete Shipment
 * =========================================================== */
router.post('/delete/:id', requireBusiness, async (req, res) => {
  try {
    const shipment = await Shipment.findOneAndDelete({
      _id: req.params.id,
      business: req.session.business._id,
    });
    if (!shipment) {
      req.flash('error', 'Shipment not found.');
      return res.redirect('/shipments');
    }
    req.flash('success', '🗑️ Shipment deleted successfully.');
    res.redirect('/shipments');
  } catch (err) {
    console.error('❌ Error deleting shipment:', err);
    req.flash('error', 'Failed to delete shipment.');
    res.redirect('/shipments');
  }
});

module.exports = router;
