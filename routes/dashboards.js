// routes/dashboards.js
const express = require('express');
const router = express.Router();

const requireBusiness = require('../middleware/requireBusiness');
const Product = require('../models/Product');
const Shipment = require('../models/Shipment');
const Order = require('../models/Order');

/** Helper to map array of {_id,count} into an object {key: count} */
function aggToMap(rows) {
  const map = {};
  for (const r of rows) {map[r._id || 'Unknown'] = Number(r.count || 0);}
  return map;
}

/** Choose your low-stock threshold here */
const LOW_STOCK_THRESHOLD = 5;

/* -----------------------------------------------------------
 * GET /dashboards/seller  (Seller dashboard)
 * --------------------------------------------------------- */
router.get('/dashboards/seller', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Please log in with a business account.');
      return res.redirect('/business/login');
    }

    // 1) Load seller products
    const products = await Product.find({ business: business._id })
      .select('customId name price stock category imageUrl createdAt soldCount soldOrders')
      .sort({ createdAt: -1 })
      .lean();

    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    const lowStock = products.filter(
      (p) => (Number(p.stock) || 0) > 0 && (Number(p.stock) || 0) <= LOW_STOCK_THRESHOLD,
    ).length;
    const outOfStock = products.filter((p) => (Number(p.stock) || 0) <= 0).length;

    // 2) Shipments, grouped by status (for this business)
    const shipmentsAgg = await Shipment.aggregate([
      { $match: { business: business._id } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const shipmentsByStatus = aggToMap(shipmentsAgg);

    // 3) Orders that include this seller's products
    //    Your Order.items[].productId is a String — we’ll match against Product.customId set.
    const sellerCustomIds = products.map((p) => p.customId);
    let ordersCount = 0;
    let ordersByStatus = {};
    if (sellerCustomIds.length) {
      const ordersAgg = await Order.aggregate([
        { $match: { 'items.productId': { $in: sellerCustomIds } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]);
      ordersByStatus = aggToMap(ordersAgg);

      ordersCount = await Order.countDocuments({
        'items.productId': { $in: sellerCustomIds },
      });
    }

    // Optional recent orders preview (limit 5)
    const recentOrders = sellerCustomIds.length
      ? await Order.find({ 'items.productId': { $in: sellerCustomIds } })
          .select('orderId status amount createdAt')
          .sort({ createdAt: -1 })
          .limit(5)
          .lean()
      : [];

    // Pass everything to the EJS
    return res.render('dashboards/seller-dashboard', {
      title: 'Seller Dashboard',
      business,
      totals: {
        totalProducts,
        totalStock,
        lowStock,
        outOfStock,
      },
      products, // for per-product stock listing
      shipments: {
        byStatus: shipmentsByStatus,
        total: Object.values(shipmentsByStatus).reduce((a, b) => a + b, 0),
      },
      orders: {
        total: ordersCount,
        byStatus: ordersByStatus,
        recent: recentOrders,
      },
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss, // keep your theming
      nonce: res.locals.nonce, // CSP nonce for inline script
    });
  } catch (err) {
    console.error('❌ Seller dashboard error:', err);
    req.flash('error', 'Could not load seller dashboard.');
    return res.redirect('/business/dashboard');
  }
});

module.exports = router;
