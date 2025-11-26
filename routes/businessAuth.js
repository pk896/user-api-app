// routes/businessAuth.js
const express = require('express');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const Business = require('../models/Business');
const Product = require('../models/Product');
const requireBusiness = require('../middleware/requireBusiness');
const redirectIfLoggedIn = require('../middleware/redirectIfLoggedIn');
const DeliveryOption = require('../models/DeliveryOption');

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  /* Order model optional */
}

const router = express.Router();

// Normalize emails
const normalizeEmail = (email) => (email || '').trim().toLowerCase();

const LOW_STOCK_THRESHOLD = 10;

async function computeSupplierKpis(businessId) {
  // Load products for this supplier (we want customId, price, name, etc.)
  const products = await Product.find({ business: businessId })
    .select('stock customId price soldCount name category imageUrl')
    .lean();

  const totalProducts = products.length;
  const totalStock = products.reduce(
    (sum, p) => sum + (Number(p.stock) || 0),
    0
  );
  const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
  const lowStock = products.filter((p) => {
    const s = Number(p.stock) || 0;
    return s > 0 && s <= LOW_STOCK_THRESHOLD;
  }).length;
  const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

  let soldLast30 = 0;
  let revenueLast30 = 0;

  // Map for "Top Products (30 days)" section
  const perProductMap = new Map();

  const supplierCustomIds = products
    .map((p) => (p.customId ? String(p.customId) : null))
    .filter(Boolean);

  // ---- Prefer using Order docs for last 30 days ----
  if (Order && supplierCustomIds.length) {
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const PAID_STATES = Array.isArray(Order.PAID_STATES)
      ? Order.PAID_STATES
      : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

    const idMatchOr = [
      { 'items.productId': { $in: supplierCustomIds } },
      { 'items.customId': { $in: supplierCustomIds } },
      { 'items.pid': { $in: supplierCustomIds } },
      { 'items.sku': { $in: supplierCustomIds } },
    ];

    const recentOrders = await Order.find({
      createdAt: { $gte: since },
      status: { $in: PAID_STATES },
      $or: idMatchOr,
    })
      .select('items amount createdAt status')
      .lean();

    for (const o of recentOrders) {
      // Full order revenue
      const amt = Number(o?.amount?.value || 0);
      if (!Number.isNaN(amt)) {
        revenueLast30 += amt;
      }

      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const pid = String(
          it.productId ?? it.customId ?? it.pid ?? it.sku ?? ''
        ).trim();
        if (!pid) continue;
        if (!supplierCustomIds.includes(pid)) continue;

        const qty = Number(it.quantity || 1);
        if (!Number.isFinite(qty) || qty <= 0) continue;

        soldLast30 += qty;

        const prod =
          products.find((p) => String(p.customId) === pid) || {};

        const price = Number(prod.price || 0);
        const estRevenue = price * qty;

        const existing = perProductMap.get(pid) || {
          productId: pid,
          name: prod.name || it.name || '(unknown)',
          imageUrl: prod.imageUrl || '',
          category: prod.category || '',
          price,
          qty: 0,
          estRevenue: 0,
        };

        existing.qty += qty;
        existing.estRevenue += estRevenue;
        perProductMap.set(pid, existing);
      }
    }
  }

  // ---- Fallback: lifetime counters on Product (soldCount) ----
  if (soldLast30 === 0 && revenueLast30 === 0) {
    for (const p of products) {
      const qty = Number(p.soldCount || 0);
      if (!qty) continue;
      const price = Number(p.price || 0);

      soldLast30 += qty;
      revenueLast30 += qty * price;

      const pid = p.customId ? String(p.customId) : null;
      if (!pid) continue;

      const existing = perProductMap.get(pid) || {
        productId: pid,
        name: p.name || '(unknown)',
        imageUrl: p.imageUrl || '',
        category: p.category || '',
        price,
        qty: 0,
        estRevenue: 0,
      };
      existing.qty += qty;
      existing.estRevenue += qty * price;
      perProductMap.set(pid, existing);
    }
  }

  const perProduct = Array.from(perProductMap.values()).sort(
    (a, b) => b.qty - a.qty
  );

  const perProductTotalQty = perProduct.reduce(
    (sum, p) => sum + (Number(p.qty) || 0),
    0
  );
  const perProductEstRevenue = perProduct.reduce(
    (sum, p) => sum + (Number(p.estRevenue) || 0),
    0
  );

  return {
    totalProducts,
    totalStock,
    inStock,
    lowStock,
    outOfStock,
    soldLast30,
    revenueLast30,
    perProduct,
    perProductTotalQty,
    perProductEstRevenue: Number(perProductEstRevenue.toFixed(2)),
  };
}

/* ----------------------------------------------------------
 * 📝 GET: Business Signup
 * -------------------------------------------------------- */
router.get('/signup', (req, res) => {
  res.render('business-signup', {
    title: 'Business Sign Up',
    active: 'business-signup',
    success: req.flash('success'),
    error: req.flash('error'),
    errors: [],
    themeCss: res.locals.themeCss,
  });
});

/* ----------------------------------------------------------
 * 📨 POST: Business Signup
 * -------------------------------------------------------- */
router.post(
  '/signup',
  redirectIfLoggedIn,
  [
    body('name').notEmpty().withMessage('Business name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('role')
      .isIn(['seller', 'supplier', 'buyer'])
      .withMessage('Role must be seller, supplier, or buyer'),
    body('businessNumber').notEmpty().withMessage('Business number is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('country').notEmpty().withMessage('Country is required'),
    body('city').notEmpty().withMessage('City is required'),
    body('address').notEmpty().withMessage('Address is required'),
    body('idOrPassport').notEmpty().withMessage('ID or Passport is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the highlighted errors.');
      return res.status(400).render('business-signup', {
        title: 'Business Sign Up',
        active: 'business-signup',
        errors: errors.array(),
        success: req.flash('success'),
        error: req.flash('error'),
        themeCss: res.locals.themeCss,
      });
    }

    try {
      const {
        name,
        email,
        password,
        role,
        businessNumber,
        phone,
        country,
        city,
        address,
        idOrPassport,
      } = req.body;

      const emailNorm = normalizeEmail(email);
      const existing = await Business.findOne({ email: emailNorm });
      if (existing) {
        req.flash('error', 'An account with that email already exists.');
        return res.status(409).render('business-signup', {
          title: 'Business Sign Up',
          active: 'business-signup',
          errors: [{ msg: 'Email already in use', param: 'email' }],
          success: req.flash('success'),
          error: req.flash('error'),
          themeCss: res.locals.themeCss,
        });
      }

      const hashed = await bcrypt.hash(password, 12);
      const business = await Business.create({
        name,
        email: emailNorm,
        password: hashed,
        role,
        businessNumber,
        phone,
        country,
        city,
        address,
        idOrPassport,
      });

      // ✅ Save to session
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
      };

      req.flash('success', `🎉 Welcome ${business.name}! Your account was created successfully.`);

      // ✅ Role-based redirect after signup
      switch (business.role) {
        case 'seller':
          return res.redirect('/business/dashboards/seller-dashboard');
        case 'supplier':
          return res.redirect('/business/dashboards/supplier-dashboard');
        case 'buyer':
          return res.redirect('/business/dashboards/buyer-dashboard');
        default:
          req.flash('error', 'Invalid business role.');
          return res.redirect('/business/login');
      }
    } catch (err) {
      console.error('❌ Signup error:', err);
      req.flash('error', 'Server error during signup. Please try again.');
      return res.status(500).render('business-signup', {
        title: 'Business Sign Up',
        errors: [{ msg: 'Server error' }],
        success: req.flash('success'),
        error: req.flash('error'),
        themeCss: res.locals.themeCss,
      });
    }
  },
);

/* ----------------------------------------------------------
 * 🔐 GET: Business Login
 * -------------------------------------------------------- */
router.get('/login', redirectIfLoggedIn, (req, res) => {
  res.render('business-login', {
    title: 'Business Login',
    active: 'business-login',
    success: req.flash('success'),
    error: req.flash('error'),
    errors: [],
    themeCss: res.locals.themeCss,
  });
});

/* ----------------------------------------------------------
 * 🔑 POST: Business Login
 * -------------------------------------------------------- */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    console.log('✅ Session created:', req.session);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', 'Please fix the errors and try again.');
      return res.status(400).render('business-login', {
        title: 'Business Login',
        active: 'business-login',
        errors: errors.array(),
        success: req.flash('success'),
        error: req.flash('error'),
        themeCss: res.locals.themeCss,
      });
    }

    try {
      const { email, password } = req.body;
      const emailNorm = normalizeEmail(email);
      const business = await Business.findOne({ email: emailNorm });

      if (!business || !(await bcrypt.compare(password, business.password))) {
        req.flash('error', '❌ Invalid email or password.');
        return res.status(401).render('business-login', {
          title: 'Business Login',
          active: 'business-login',
          errors: [{ msg: 'Invalid credentials' }],
          success: req.flash('success'),
          error: req.flash('error'),
          themeCss: res.locals.themeCss,
        });
      }

      // ✅ Store session
      req.session.business = {
        _id: business._id,
        name: business.name,
        email: business.email,
        role: business.role,
      };

      req.flash('success', `✅ Welcome back, ${business.name}!`);

      // ✅ Role-based redirect after login
      switch (business.role) {
        case 'seller':
          return res.redirect('/business/dashboards/seller-dashboard');
        case 'supplier':
          return res.redirect('/business/dashboards/supplier-dashboard');
        case 'buyer':
          return res.redirect('/business/dashboards/buyer-dashboard');
        default:
          req.flash('error', 'Invalid business role.');
          return res.redirect('/business/login');
      }
    } catch (err) {
      console.error('❌ Login error:', err);
      req.flash('error', '❌ Login failed. Please try again later.');
      return res.status(500).render('business-login', {
        title: 'Business Login',
        errors: [{ msg: 'Server error' }],
        success: req.flash('success'),
        error: req.flash('error'),
        themeCss: res.locals.themeCss,
      });
    }
  },
);

// SELLER DASHBOARD - FIXED VERSION
router.get('/dashboards/seller-dashboard', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    // sellers only
    if (business.role !== 'seller') {
      req.flash('error', '⛔ Access denied. Seller accounts only.');
      return res.redirect('/business/dashboard');
    }

    const Order = require('../models/Order');
    const Shipment = require('../models/Shipment');

    // ------------------------------------------------------------
    // 1) All products for this seller (include customId for matching)
    // ------------------------------------------------------------
    const products = await Product.find({ business: business._id })
      .select('customId name price stock category imageUrl createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const totalProducts = products.length;
    const totalStock = products.reduce(
      (sum, p) => sum + (Number(p.stock) || 0),
      0
    );
    const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
    const lowStock = products.filter((p) => {
      const s = Number(p.stock) || 0;
      return s > 0 && s <= 5;
    }).length;
    const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0)
      .length;

    // Map by customId (this is what Order.items.productId stores)
    const productsByKey = new Map();
    const supplierCustomIds = [];
    for (const p of products) {
      if (p.customId) {
        const key = String(p.customId);
        supplierCustomIds.push(key);
        productsByKey.set(key, p);
      }
      // Also map by _id for backward compatibility
      productsByKey.set(String(p._id), p);
    }

    // ------------------------------------------------------------
    // 2) Shipments for this seller
    // ------------------------------------------------------------
    const shipmentsAgg = await Shipment.aggregate([
      { $match: { business: business._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const shipmentsByStatus = shipmentsAgg.reduce((m, r) => {
      m[r._id] = Number(r.count || 0);
      return m;
    }, {});

    const shipmentsTotal = Object.values(shipmentsByStatus).reduce(
      (a, b) => a + b,
      0
    );

    // ------------------------------------------------------------
    // 3) Orders for this seller (Recent Orders)
    // ------------------------------------------------------------
    let ordersTotal = 0;
    let ordersByStatus = {};
    let recentOrders = [];

    if (Order && supplierCustomIds.length) {
      const idMatchOr = [
        { 'items.productId': { $in: supplierCustomIds } },
        { 'items.customId': { $in: supplierCustomIds } },
        { 'items.pid': { $in: supplierCustomIds } },
        { 'items.sku': { $in: supplierCustomIds } },
      ];

      const baseOrderMatch = { $or: idMatchOr };

      const ordersAgg = await Order.aggregate([
        { $match: baseOrderMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);

      ordersByStatus = ordersAgg.reduce((m, r) => {
        m[r._id || 'Unknown'] = Number(r.count || 0);
        return m;
      }, {});
      ordersTotal = await Order.countDocuments(baseOrderMatch);

      recentOrders = await Order.find(baseOrderMatch)
        .select('orderId status amount createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    }

    // ------------------------------------------------------------
    // 4) 30-day KPIs with PROPER per-product data
    // ------------------------------------------------------------
    const SINCE_DAYS = 30;
    const since = new Date();
    since.setDate(since.getDate() - SINCE_DAYS);

    let soldPerProduct = [];
    let soldTotalQty = 0;
    let soldEstRevenue = 0;
    let last30Revenue = 0;
    let last30Items = 0;

    if (Order && supplierCustomIds.length) {
      const PAID_STATES = Array.isArray(Order.PAID_STATES)
        ? Order.PAID_STATES
        : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

      const idMatchOr = [
        { 'items.productId': { $in: supplierCustomIds } },
        { 'items.customId': { $in: supplierCustomIds } },
        { 'items.pid': { $in: supplierCustomIds } },
        { 'items.sku': { $in: supplierCustomIds } },
      ];

      const baseMatch = {
        createdAt: { $gte: since },
        status: { $in: PAID_STATES },
        $or: idMatchOr,
      };

      // Get ALL orders in last 30 days for this seller
      const recentOrders30 = await Order.find(baseMatch)
        .select('items amount createdAt status')
        .lean();

      // Process each order to build per-product stats
      const productSalesMap = new Map();

      for (const order of recentOrders30) {
        const items = Array.isArray(order.items) ? order.items : [];
        
        for (const item of items) {
          // Try all possible product ID fields
          const productId = String(
            item.productId || item.customId || item.pid || item.sku || ''
          ).trim();
          
          if (!productId || !supplierCustomIds.includes(productId)) continue;

          const quantity = Number(item.quantity || 1);
          if (quantity <= 0) continue;

          // Find the product details
          const product = productsByKey.get(productId);
          if (!product) continue;

          const price = Number(product.price || 0);
          const revenue = quantity * price;

          // Update totals
          last30Items += quantity;
          last30Revenue += revenue;

          // Update per-product stats
          if (!productSalesMap.has(productId)) {
            productSalesMap.set(productId, {
              productId: productId,
              name: product.name || '(unknown)',
              imageUrl: product.imageUrl || '',
              category: product.category || '',
              price: price,
              qty: 0,
              estRevenue: 0
            });
          }

          const existing = productSalesMap.get(productId);
          existing.qty += quantity;
          existing.estRevenue += revenue;
        }
      }

      // Convert map to array and sort by quantity sold
      soldPerProduct = Array.from(productSalesMap.values())
        .sort((a, b) => b.qty - a.qty);

      soldTotalQty = last30Items;
      soldEstRevenue = last30Revenue;
    }

    // If no recent orders, try using computeSupplierKpis as fallback
    if (soldPerProduct.length === 0) {
      try {
        const kpisRaw = await computeSupplierKpis(business._id);
        if (kpisRaw && Array.isArray(kpisRaw.perProduct) && kpisRaw.perProduct.length > 0) {
          soldPerProduct = kpisRaw.perProduct;
          soldTotalQty = kpisRaw.perProductTotalQty || 0;
          soldEstRevenue = kpisRaw.perProductEstRevenue || 0;
          last30Items = kpisRaw.soldLast30 || 0;
          last30Revenue = kpisRaw.revenueLast30 || 0;
        }
      } catch (e) {
        console.error('Fallback computeSupplierKpis failed:', e);
      }
    }

    const kpis = {
      totalProducts,
      totalStock,
      inStock,
      lowStock,
      outOfStock,
      soldLast30: last30Items,
      revenueLast30: Number(last30Revenue.toFixed(2)),
      last30Items,
      last30Revenue: Number(last30Revenue.toFixed(2)),
      perProduct: soldPerProduct, // THIS IS CRITICAL - must be populated
      perProductTotalQty: soldTotalQty,
      perProductEstRevenue: Number(soldEstRevenue.toFixed(2)),
    };

    console.log('📊 Seller KPIs Debug:', {
      perProductCount: kpis.perProduct.length,
      soldLast30: kpis.soldLast30,
      revenueLast30: kpis.revenueLast30,
      sampleProducts: kpis.perProduct.slice(0, 3).map(p => ({
        name: p.name,
        qty: p.qty,
        revenue: p.estRevenue
      }))
    });

    // ------------------------------------------------------------
    // 5) Delivery options + render
    // ------------------------------------------------------------
    const deliveryOptions = await DeliveryOption.find({ active: true })
      .sort({ deliveryDays: 1, priceCents: 1 })
      .lean();

    return res.render('dashboards/seller-dashboard', {
      title: 'Seller Dashboard',
      business,
      totals: {
        totalProducts,
        totalStock,
        inStock,
        lowStock,
        outOfStock,
      },
      products, // used by recentProducts in your EJS

      shipments: {
        total: shipmentsTotal,
        byStatus: shipmentsByStatus,
      },
      orders: {
        total: ordersTotal,
        byStatus: ordersByStatus,
        recent: recentOrders,
      },
      kpis, // This now includes properly populated perProduct array
      deliveryOptions,
      isOrdersAdmin: Boolean(req.session.ordersAdmin),

      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Seller dashboard error:', err);
    req.flash('error', 'Failed to load seller dashboard.');
    res.redirect('/business/login');
  }
});

// SUPPLIER DASHBOARD - UPDATED TO MATCH SELLER DASHBOARD
router.get('/dashboards/supplier-dashboard', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }
    
    // 🔒 Supplier-only
    if (business.role !== 'supplier') {
      req.flash('error', '⛔ Access denied. Supplier accounts only.');
      return res.redirect('/business/dashboard');
    }

    const Order = require('../models/Order');
    const Shipment = require('../models/Shipment');

    // ------------------------------------------------------------
    // 1) All products for this supplier
    // ------------------------------------------------------------
    const products = await Product.find({ business: business._id })
      .select('customId name price stock category imageUrl createdAt updatedAt')
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();

    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    const inStock = products.filter((p) => (Number(p.stock) || 0) > 0).length;
    const lowStock = products.filter((p) => {
      const s = Number(p.stock) || 0;
      return s > 0 && s <= 10; // Using 10 as threshold like seller dashboard
    }).length;
    const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

    // Build product lookup maps
    const productsByKey = new Map();
    const allProductIdentifiers = [];
    
    for (const p of products) {
      // Map by customId
      if (p.customId) {
        const customId = String(p.customId);
        productsByKey.set(customId, p);
        allProductIdentifiers.push(customId);
      }
      // Map by _id
      const objectId = String(p._id);
      productsByKey.set(objectId, p);
      allProductIdentifiers.push(objectId);
    }

    // ------------------------------------------------------------
    // 2) Shipments for this supplier
    // ------------------------------------------------------------
    const shipmentsAgg = await Shipment.aggregate([
      { $match: { business: business._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const shipmentsByStatus = shipmentsAgg.reduce((m, r) => {
      m[r._id] = Number(r.count || 0);
      return m;
    }, {});

    const shipmentsTotal = Object.values(shipmentsByStatus).reduce((a, b) => a + b, 0);

    // ------------------------------------------------------------
    // 3) Recent Orders for this supplier
    // ------------------------------------------------------------
    let ordersTotal = 0;
    let ordersByStatus = {};
    let recentOrders = [];

    if (Order && allProductIdentifiers.length) {
      const idMatchOr = [
        { 'items.productId': { $in: allProductIdentifiers } },
        { 'items.customId': { $in: allProductIdentifiers } },
        { 'items.pid': { $in: allProductIdentifiers } },
        { 'items.sku': { $in: allProductIdentifiers } },
      ];

      const baseOrderMatch = { $or: idMatchOr };

      const ordersAgg = await Order.aggregate([
        { $match: baseOrderMatch },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);

      ordersByStatus = ordersAgg.reduce((m, r) => {
        m[r._id || 'Unknown'] = Number(r.count || 0);
        return m;
      }, {});
      ordersTotal = await Order.countDocuments(baseOrderMatch);

      recentOrders = await Order.find(baseOrderMatch)
        .select('orderId status amount createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    }

    // ------------------------------------------------------------
    // 4) 30-DAY SALES DATA - SAME LOGIC AS SELLER DASHBOARD
    // ------------------------------------------------------------
    const SINCE_DAYS = 30;
    const since = new Date();
    since.setDate(since.getDate() - SINCE_DAYS);

    let soldPerProduct = [];
    let last30Revenue = 0;
    let last30Items = 0;

    if (Order && allProductIdentifiers.length) {
      const PAID_STATES = Array.isArray(Order.PAID_STATES)
        ? Order.PAID_STATES
        : ['Completed', 'Paid', 'Shipped', 'Delivered', 'COMPLETED'];

      const idMatchOr = [
        { 'items.productId': { $in: allProductIdentifiers } },
        { 'items.customId': { $in: allProductIdentifiers } },
        { 'items.pid': { $in: allProductIdentifiers } },
        { 'items.sku': { $in: allProductIdentifiers } },
      ];

      const baseMatch = {
        createdAt: { $gte: since },
        status: { $in: PAID_STATES },
        $or: idMatchOr,
      };

      // Get recent paid orders
      const recentPaidOrders = await Order.find(baseMatch)
        .select('items amount createdAt status')
        .lean();

      // Track sales per product
      const productSales = new Map();

      for (const order of recentPaidOrders) {
        const items = Array.isArray(order.items) ? order.items : [];
        
        for (const item of items) {
          // Try all possible product ID fields
          let productId = null;
          const possibleIds = [
            item.productId,
            item.customId, 
            item.pid,
            item.sku
          ];
          
          for (const id of possibleIds) {
            if (id && allProductIdentifiers.includes(String(id))) {
              productId = String(id);
              break;
            }
          }

          if (!productId) continue;

          const product = productsByKey.get(productId);
          if (!product) continue;

          const quantity = Number(item.quantity || 1);
          const price = Number(product.price || item.price || 0);
          const revenue = quantity * price;

          // Update totals
          last30Items += quantity;
          last30Revenue += revenue;

          // Update per-product stats
          if (!productSales.has(productId)) {
            productSales.set(productId, {
              productId: productId,
              name: product.name || item.name || '(unknown)',
              imageUrl: product.imageUrl || '',
              category: product.category || '',
              price: price,
              qty: 0,
              estRevenue: 0
            });
          }

          const productStat = productSales.get(productId);
          productStat.qty += quantity;
          productStat.estRevenue += revenue;
        }
      }

      // Convert to array and sort by quantity sold
      soldPerProduct = Array.from(productSales.values())
        .sort((a, b) => b.qty - a.qty);

      console.log('🔄 Supplier 30-day sales data:', {
        ordersProcessed: recentPaidOrders.length,
        productsWithSales: soldPerProduct.length,
        totalItemsSold: last30Items,
        totalRevenue: last30Revenue,
        topProducts: soldPerProduct.slice(0, 3).map(p => ({
          name: p.name,
          qty: p.qty,
          revenue: p.estRevenue
        }))
      });
    }

    // If no data found, use computeSupplierKpis as fallback
    if (soldPerProduct.length === 0 && last30Items === 0) {
      try {
        console.log('🔄 Trying computeSupplierKpis fallback for supplier...');
        const kpisRaw = await computeSupplierKpis(business._id);
        
        if (kpisRaw) {
          last30Items = kpisRaw.soldLast30 || 0;
          last30Revenue = kpisRaw.revenueLast30 || 0;
          
          if (Array.isArray(kpisRaw.perProduct) && kpisRaw.perProduct.length > 0) {
            soldPerProduct = kpisRaw.perProduct;
            console.log('🔄 Fallback provided', soldPerProduct.length, 'products for supplier');
          }
        }
      } catch (fallbackError) {
        console.error('❌ Supplier fallback also failed:', fallbackError);
      }
    }

    // Final KPIs object - SAME STRUCTURE AS SELLER DASHBOARD
    const kpis = {
      totalProducts,
      totalStock,
      inStock,
      lowStock,
      outOfStock,
      soldLast30: last30Items,
      revenueLast30: Number(last30Revenue.toFixed(2)),
      last30Items,
      last30Revenue: Number(last30Revenue.toFixed(2)),
      perProduct: soldPerProduct, // This is what the EJS checks
      perProductTotalQty: last30Items,
      perProductEstRevenue: Number(last30Revenue.toFixed(2)),
    };

    // ------------------------------------------------------------
    // 5) Delivery options
    // ------------------------------------------------------------
    const deliveryOptions = await DeliveryOption.find({ active: true })
      .sort({ deliveryDays: 1, priceCents: 1 })
      .lean();

    // Mailer status + inbox shown in toolbar
    const supportInbox = process.env.SUPPORT_INBOX || 'support@phakisi-global.test';
    const mailerOk = !!(
      process.env.SENDGRID_API_KEY ||
      process.env.SMTP_HOST ||
      process.env.SMTP_URL
    );

    return res.render('dashboards/supplier-dashboard', {
      title: 'Supplier Dashboard',
      business,
      totals: {
        totalProducts,
        totalStock,
        inStock,
        lowStock,
        outOfStock,
      },
      products,
      shipments: {
        total: shipmentsTotal,
        byStatus: shipmentsByStatus,
      },
      orders: {
        total: ordersTotal,
        byStatus: ordersByStatus,
        recent: recentOrders,
      },
      kpis, // Same structure as seller dashboard
      deliveryOptions,
      isOrdersAdmin: Boolean(req.session.ordersAdmin),
      mailerOk,
      supportInbox,

      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Supplier dashboard error:', err);
    req.flash('error', '❌ Failed to load supplier dashboard.');
    res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * Supplier KPIs JSON for auto-refresh (/business/api/supplier/kpis)
 * -------------------------------------------------------- */
router.get('/api/supplier/kpis', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id || business.role !== 'supplier') {
      return res.status(403).json({ ok: false, message: 'Suppliers only' });
    }

    const kpis = await computeSupplierKpis(business._id);
    return res.json({ ok: true, ...kpis });
  } catch (err) {
    console.error('supplier KPI API error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load KPIs' });
  }
});

/* ----------------------------------------------------------
 * Seller KPIs JSON for auto-refresh (/business/api/seller/kpis)
 * (re-use the same helper as supplier so logic is identical)
 * -------------------------------------------------------- */
router.get('/api/seller/kpis', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id || business.role !== 'seller') {
      return res.status(403).json({ ok: false, message: 'Sellers only' });
    }

    // 🔁 Re-use the same KPI computation as supplier
    const kpis = await computeSupplierKpis(business._id);

    return res.json({ ok: true, ...kpis });
  } catch (err) {
    console.error('seller KPI API error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load KPIs' });
  }
});

/* ----------------------------------------------------------
 * BUYER DASHBOARD - UPDATED
 * -------------------------------------------------------- */
router.get('/dashboards/buyer-dashboard', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }
    if (business.role !== 'buyer') {
      req.flash('error', '⛔ Access denied. Buyer accounts only.');
      return res.redirect('/business/dashboard');
    }

    const Order = require('../models/Order');
    const Shipment = require('../models/Shipment');

    // ------------------------------------------------------------
    // 1) Buyer's orders
    // ------------------------------------------------------------
    const orders = await Order.find({ businessBuyer: business._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const totalOrders = await Order.countDocuments({ businessBuyer: business._id });
    const completedOrders = await Order.countDocuments({
      businessBuyer: business._id,
      status: { $in: ['Completed', 'COMPLETED', 'Delivered'] }
    });
    const pendingOrders = await Order.countDocuments({
      businessBuyer: business._id,
      status: { $in: ['Pending', 'Processing', 'PAID', 'Shipped'] }
    });

    // ------------------------------------------------------------
    // 2) Shipping stats
    // ------------------------------------------------------------
    let shipStats = { inTransit: 0, delivered: 0 };
    
    if (orders.length > 0) {
      const orderIds = orders.map(o => o.orderId).filter(Boolean);
      if (orderIds.length > 0) {
        const byStatus = await Shipment.aggregate([
          { $match: { orderId: { $in: orderIds } } },
          { $group: { _id: '$status', count: { $sum: 1 } } },
        ]);
        
        for (const r of byStatus) {
          if (r._id === 'In Transit' || r._id === 'Shipped') {
            shipStats.inTransit += r.count;
          }
          if (r._id === 'Delivered') {
            shipStats.delivered += r.count;
          }
        }
      }
    }

    // ------------------------------------------------------------
    // 3) Products from orders
    // ------------------------------------------------------------
    const orderedCustomIds = new Set();
    for (const o of orders) {
      (o.items || []).forEach((it) => {
        if (it.productId) orderedCustomIds.add(String(it.productId));
        if (it.customId) orderedCustomIds.add(String(it.customId));
      });
    }

    let orderedProducts = [];
    if (orderedCustomIds.size > 0) {
      orderedProducts = await Product.find({ 
        $or: [
          { customId: { $in: Array.from(orderedCustomIds) } },
          { _id: { $in: Array.from(orderedCustomIds) } }
        ]
      })
      .select('customId name price imageUrl category stock')
      .limit(8)
      .lean();
    }

    // ------------------------------------------------------------
    // 4) Mailer status
    // ------------------------------------------------------------
    const mailerOk = !!(
      process.env.SENDGRID_API_KEY ||
      process.env.SMTP_HOST ||
      process.env.SMTP_URL
    );

    // ------------------------------------------------------------
    // 5) Recent orders for display
    // ------------------------------------------------------------
    const recentOrders = orders.slice(0, 5);

    res.render('dashboards/buyer-dashboard', {
      title: 'Buyer Dashboard',
      business,
      totalOrders,
      completedOrders,
      pendingOrders,
      orders: recentOrders,
      shipStats,
      orderedProducts,
      mailerOk, // This was missing - causing the error
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Buyer dashboard error:', err);
    req.flash('error', 'Failed to load buyer dashboard.');
    res.redirect('/business/login');
  }
});

/* ----------------------------------------------------------
 * 🧭 GET: Universal Dashboard Redirector
 * -------------------------------------------------------- */
router.get('/dashboard', requireBusiness, (req, res) => {
  const { role } = req.session.business;

  switch (role) {
    case 'seller':
      return res.redirect('/business/dashboards/seller-dashboard');
    case 'supplier':
      return res.redirect('/business/dashboards/supplier-dashboard');
    case 'buyer':
      return res.redirect('/business/dashboards/buyer-dashboard');
    default:
      req.flash('error', 'Invalid business role.');
      return res.redirect('/business/login');
  }
});

router.post('/logout', (req, res) => {
  if (!req.session) {return res.redirect('/business/login');}

  // ✅ store flash message first
  req.flash('success', 'You’ve been logged out successfully.');

  // ✅ now destroy session
  req.session.destroy((err) => {
    if (err) {
      console.error('❌ Logout error:', err);
      return res.redirect('/business/dashboard');
    }

    res.clearCookie('connect.sid');
    res.redirect('/business/login');
  });
});

/* ----------------------------------------------------------
 * 👤 Profile Management
 * -------------------------------------------------------- */
router.get('/profile', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('business-profile', {
      title: 'Business Profile',
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error('❌ Business profile error:', err);
    req.flash('error', 'Failed to load profile.');
    res.redirect('/business/dashboard');
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Profile
 * -------------------------------------------------------- */
router.get('/profile/edit', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('edit-profile', {
      title: 'Edit Profile',
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error('❌ Edit profile page error:', err);
    req.flash('error', 'Failed to load edit profile page.');
    res.redirect('/business/profile');
  }
});

router.post('/profile/edit', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id);
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/renderlog-in');
    }

    const { name, phone, country, city, address, password } = req.body;
    business.name = name || business.name;
    business.phone = phone || business.phone;
    business.country = country || business.country;
    business.city = city || business.city;
    business.address = address || business.address;

    if (password && password.trim().length >= 6) {
      business.password = await bcrypt.hash(password, 12);
    }

    await business.save();
    req.session.business.name = business.name;

    req.flash('success', '✅ Profile updated successfully.');
    res.redirect('/business/profile');
  } catch (err) {
    console.error('❌ Profile update error:', err);
    req.flash('error', '❌ Failed to update profile.');
    res.redirect('/business/profile');
  }
});

/* ----------------------------------------------------------
 * 🗑️ Delete Profile
 * -------------------------------------------------------- */
router.get('/profile/delete', requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash('error', 'Business not found.');
      return res.redirect('/business/login');
    }

    res.render('delete-profile', {
      title: 'Delete Profile',
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error('❌ Delete profile render error:', err);
    req.flash('error', 'Failed to load delete confirmation page.');
    res.redirect('/business/profile');
  }
});

router.post('/profile/delete', requireBusiness, async (req, res) => {
  try {
    await Business.findByIdAndDelete(req.session.business._id);
    req.session.destroy(() => {
      res.clearCookie('connect.sid');
      req.flash('success', '✅ Business account deleted.');
      res.redirect('/');
    });
  } catch (err) {
    console.error('❌ Delete business error:', err);
    req.flash('error', 'Failed to delete account.');
    res.redirect('/business/profile');
  }
});

module.exports = router;
