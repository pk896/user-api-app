// routes/businessAuth.js
const express = require("express");
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const Business = require("../models/Business");
const Product = require("../models/Product");
const ContactMessage = require("../models/ContactMessage");
const requireBusiness = require("../middleware/requireBusiness");
const redirectIfLoggedIn = require("../middleware/redirectIfLoggedIn");
const DeliveryOption = require("../models/DeliveryOption");



const router = express.Router();

// Optional models for extended dashboards
let Order = null;
let Shipment = null;
try {
  Order = require("../models/Order");
  Shipment = require("../models/Shipment");
} catch {
  console.warn("⚠️ Order/Shipment models not found (optional).");
}

// Normalize emails
const normalizeEmail = (email) => (email || "").trim().toLowerCase();

/* ----------------------------------------------------------
 * 📝 GET: Business Signup
 * -------------------------------------------------------- */
router.get("/signup", (req, res) => {
  res.render("business-signup", {
    title: "Business Sign Up",
    active: "business-signup",
    success: req.flash("success"),
    error: req.flash("error"),
    errors: [],
    themeCss: res.locals.themeCss,
  });
});

/* ----------------------------------------------------------
 * 📨 POST: Business Signup
 * -------------------------------------------------------- */
router.post(
  "/signup",
  redirectIfLoggedIn,
  [
    body("name").notEmpty().withMessage("Business name is required"),
    body("email").isEmail().withMessage("Valid email is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 characters"),
    body("role")
      .isIn(["seller", "supplier", "buyer"])
      .withMessage("Role must be seller, supplier, or buyer"),
    body("businessNumber").notEmpty().withMessage("Business number is required"),
    body("phone").notEmpty().withMessage("Phone number is required"),
    body("country").notEmpty().withMessage("Country is required"),
    body("city").notEmpty().withMessage("City is required"),
    body("address").notEmpty().withMessage("Address is required"),
    body("idOrPassport").notEmpty().withMessage("ID or Passport is required"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash("error", "Please fix the highlighted errors.");
      return res.status(400).render("business-signup", {
        title: "Business Sign Up",
        active: "business-signup",
        errors: errors.array(),
        success: req.flash("success"),
        error: req.flash("error"),
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
        req.flash("error", "An account with that email already exists.");
        return res.status(409).render("business-signup", {
          title: "Business Sign Up",
          active: "business-signup",
          errors: [{ msg: "Email already in use", param: "email" }],
          success: req.flash("success"),
          error: req.flash("error"),
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

      req.flash("success", `🎉 Welcome ${business.name}! Your account was created successfully.`);

      // ✅ Role-based redirect after signup
      switch (business.role) {
        case "seller":
          return res.redirect("/business/dashboards/seller-dashboard");
        case "supplier":
          return res.redirect("/business/dashboards/supplier-dashboard");
        case "buyer":
          return res.redirect("/business/dashboards/buyer-dashboard");
        default:
          req.flash("error", "Invalid business role.");
          return res.redirect("/business/login");
      }
    } catch (err) {
      console.error("❌ Signup error:", err);
      req.flash("error", "Server error during signup. Please try again.");
      return res.status(500).render("business-signup", {
        title: "Business Sign Up",
        errors: [{ msg: "Server error" }],
        success: req.flash("success"),
        error: req.flash("error"),
        themeCss: res.locals.themeCss,
      });
    }
  }
);

/* ----------------------------------------------------------
 * 🔐 GET: Business Login
 * -------------------------------------------------------- */
router.get("/login", redirectIfLoggedIn, (req, res) => {
  res.render("business-login", {
    title: "Business Login",
    active: "business-login",
    success: req.flash("success"),
    error: req.flash("error"),
    errors: [],
    themeCss: res.locals.themeCss,
  });
});

/* ----------------------------------------------------------
 * 🔑 POST: Business Login
 * -------------------------------------------------------- */
router.post(
  "/login",
  [
    body("email").isEmail().withMessage("Valid email is required"),
    body("password").notEmpty().withMessage("Password is required"),
  ],
  async (req, res) => {
    console.log("✅ Session created:", req.session);

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash("error", "Please fix the errors and try again.");
      return res.status(400).render("business-login", {
        title: "Business Login",
        active: "business-login",
        errors: errors.array(),
        success: req.flash("success"),
        error: req.flash("error"),
        themeCss: res.locals.themeCss,
      });
    }

    try {
      const { email, password } = req.body;
      const emailNorm = normalizeEmail(email);
      const business = await Business.findOne({ email: emailNorm });

      if (!business || !(await bcrypt.compare(password, business.password))) {
        req.flash("error", "❌ Invalid email or password.");
        return res.status(401).render("business-login", {
          title: "Business Login",
          active: "business-login",
          errors: [{ msg: "Invalid credentials" }],
          success: req.flash("success"),
          error: req.flash("error"),
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

      req.flash("success", `✅ Welcome back, ${business.name}!`);

      // ✅ Role-based redirect after login
      switch (business.role) {
        case "seller":
          return res.redirect("/business/dashboards/seller-dashboard");
        case "supplier":
          return res.redirect("/business/dashboards/supplier-dashboard");
        case "buyer":
          return res.redirect("/business/dashboards/buyer-dashboard");
        default:
          req.flash("error", "Invalid business role.");
          return res.redirect("/business/login");
      }
    } catch (err) {
      console.error("❌ Login error:", err);
      req.flash("error", "❌ Login failed. Please try again later.");
      return res.status(500).render("business-login", {
        title: "Business Login",
        errors: [{ msg: "Server error" }],
        success: req.flash("success"),
        error: req.flash("error"),
        themeCss: res.locals.themeCss,
      });
    }
  }
);

router.get("/dashboards/seller-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }

     // 🔒 Role gate: sellers only
    if (business.role !== "seller") {
      req.flash("error", "⛔ Access denied. Seller accounts only.");
      return res.redirect("/business/dashboard");
    }

    // Load models that are optional in your file header
    const Order = require("../models/Order");
    const Shipment = require("../models/Shipment");

    // --- Load all products for this business
    const products = await Product.find({ business: business._id })
      .select("customId name price stock category imageUrl createdAt soldCount soldOrders")
      .sort({ createdAt: -1 })
      .lean();

    // --- Product totals
    const totalProducts = products.length;
    const totalStock = products.reduce((sum, p) => sum + (Number(p.stock) || 0), 0);
    const lowStock = products.filter(p => (Number(p.stock) || 0) > 0 && (Number(p.stock) || 0) <= 5).length;
    const outOfStock = products.filter(p => (Number(p.stock) || 0) <= 0).length;

    // --- Shipment totals by status for this business
    const shipmentsAgg = await Shipment.aggregate([
      { $match: { business: business._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const shipmentsByStatus = shipmentsAgg.reduce((m, r) => {
      m[r._id] = Number(r.count || 0);
      return m;
    }, {});
    const shipmentsTotal = Object.values(shipmentsByStatus).reduce((a, b) => a + b, 0);

    // --- Orders that include this seller’s products
    // Match Order.items[].productId (string) with Product.customId you store
    const sellerCustomIds = products.map(p => p.customId);
    let ordersTotal = 0;
    let ordersByStatus = {};
    let recentOrders = [];

    if (sellerCustomIds.length) {
      const ordersAgg = await Order.aggregate([
        { $match: { "items.productId": { $in: sellerCustomIds } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      ordersByStatus = ordersAgg.reduce((m, r) => {
        m[r._id || "Unknown"] = Number(r.count || 0);
        return m;
      }, {});
      ordersTotal = await Order.countDocuments({ "items.productId": { $in: sellerCustomIds } });

      recentOrders = await Order.find({ "items.productId": { $in: sellerCustomIds } })
        .select("orderId status amount createdAt")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
    }

    // Delivery options (you were already sending these)
    const deliveryOptions = await DeliveryOption.find({ active: true })
      .sort({ deliveryDays: 1, priceCents: 1 })
      .lean();

    // Optional messages (keep your placeholder or wire to your ContactMessage)
    let totalMessages = 0, unreadMessages = 0;
    try {
      totalMessages = await ContactMessage.countDocuments({ business: business._id });
      unreadMessages = await ContactMessage.countDocuments({ business: business._id, readByBusiness: false });
    } catch {
      console.warn("💬 ContactMessage model not active, skipping message counts.");
    }

    return res.render("dashboards/seller-dashboard", {
      title: "Seller Dashboard",
      business,                       // includes name + role (for the role badge)
      // product totals
      totals: {
        totalProducts,
        totalStock,
        lowStock,
        outOfStock,
      },
      products,                       // full list for per-product stock
      // shipments
      shipments: {
        total: shipmentsTotal,
        byStatus: shipmentsByStatus,
      },
      // orders
      orders: {
        total: ordersTotal,
        byStatus: ordersByStatus,
        recent: recentOrders,
      },
      // messages + delivery
      stats: { totalMessages, unreadMessages },
      deliveryOptions,
      isOrdersAdmin: Boolean(req.session.ordersAdmin),

      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ Seller dashboard error:", err);
    req.flash("error", "Failed to load seller dashboard.");
    res.redirect("/business/login");
  }
});

router.get("/dashboards/supplier-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }
    // 🔒 Supplier-only
    if (business.role !== "supplier") {
      req.flash("error", "⛔ Access denied. Supplier accounts only.");
      return res.redirect("/business/dashboard");
    }

    const LOW_STOCK_THRESHOLD = 10; // adjust if you prefer

    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    // --- Products (owned by this business)
    const [totalProducts, inStock, lowStock, outOfStock, products] = await Promise.all([
      Product.countDocuments({ business: business._id }),
      Product.countDocuments({ business: business._id, stock: { $gt: 0 } }),
      Product.countDocuments({ business: business._id, stock: { $gt: 0, $lte: LOW_STOCK_THRESHOLD } }),
      Product.countDocuments({ business: business._id, stock: 0 }),
      Product.find({ business: business._id })
        .select("name customId stock price category imageUrl updatedAt")
        .sort({ updatedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    // --- Shipments (group + recent)
    const Shipment = require("../models/Shipment");
    const shipmentsAgg = await Shipment.aggregate([
      { $match: { business: business._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const shipmentsByStatus = shipmentsAgg.reduce((m, r) => {
      m[r._id] = Number(r.count || 0);
      return m;
    }, {});
    const totalShipments = Object.values(shipmentsByStatus).reduce((a, b) => a + b, 0);
    const pendingShipments = (shipmentsByStatus["Pending"] || 0) + (shipmentsByStatus["Processing"] || 0);

    const shipments = await Shipment.find({ business: business._id })
      .populate("product", "name customId")
      .select("orderId status updatedAt")
      .sort({ updatedAt: -1 })
      .limit(8)
      .lean();

    // --- Messages + Delivery options
    const [totalMessages, unreadMessages, deliveryOptions] = await Promise.all([
      ContactMessage.countDocuments({ business: business._id }),
      ContactMessage.countDocuments({ business: business._id, readByBusiness: false }),
      DeliveryOption.find({ active: true }).sort({ deliveryDays: 1, priceCents: 1 }).lean(),
    ]);

    res.render("dashboards/supplier-dashboard", {
      title: "Supplier Dashboard",
      business,

      // product stats
      totalProducts,
      inStock,
      lowStock,
      outOfStock,
      products,

      // shipments
      totalShipments,
      pendingShipments,
      shipments,          // recent list
      shipmentsByStatus,  // available if you want per-status chips in the view

      // messages / delivery
      stats: { totalMessages, unreadMessages },
      deliveryOptions,
      isOrdersAdmin: Boolean(req.session.ordersAdmin),

      success: req.flash("success"),
      error: req.flash("error"),
      themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ Supplier dashboard error:", err);
    req.flash("error", "❌ Failed to load supplier dashboard.");
    res.redirect("/business/login");
  }
});

router.get("/dashboards/buyer-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }
    if (business.role !== "buyer") {
      req.flash("error", "⛔ Access denied. Buyer accounts only.");
      return res.redirect("/business/dashboard");
    }

    const Order = require("../models/Order");
    const Shipment = require("../models/Shipment");
    const ContactMessage = require("../models/ContactMessage");

    // Only this buyer’s orders
    const orders = await Order.find({ businessBuyer: business._id })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const totalOrders = await Order.countDocuments({ businessBuyer: business._id });
    const completedOrders = await Order.countDocuments({ businessBuyer: business._id, status: "Completed" });
    const pendingOrders = await Order.countDocuments({ businessBuyer: business._id, status: "Pending" });

    // Shipping stats for THIS buyer’s orders
    const orderIds = orders.map(o => o.orderId).filter(Boolean);
    let shipStats = { inTransit: 0, delivered: 0 };
    if (orderIds.length) {
      const byStatus = await Shipment.aggregate([
        { $match: { orderId: { $in: orderIds } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]);
      for (const r of byStatus) {
        if (r._id === "In Transit") shipStats.inTransit += r.count;
        if (r._id === "Delivered") shipStats.delivered += r.count;
      }
    }

    // Product details seen in their orders
    const orderedCustomIds = new Set();
    for (const o of orders) {
      (o.items || []).forEach(it => {
        if (it.productId) orderedCustomIds.add(String(it.productId));
      });
    }

    let orderedProducts = [];
    if (orderedCustomIds.size) {
      orderedProducts = await Product.find({ customId: { $in: Array.from(orderedCustomIds) } })
        .select("customId name price imageUrl category stock")
        .lean();
    }

    let totalMessages = 0, unreadMessages = 0;
    try {
      totalMessages = await ContactMessage.countDocuments({ business: business._id });
      unreadMessages = await ContactMessage.countDocuments({ business: business._id, readByBusiness: false });
    } catch {
      console.warn("💬 ContactMessage model not active, skipping message counts.");
    }

    res.render("dashboards/buyer-dashboard", {
      title: "Buyer Dashboard",
      business,
      totalOrders,
      completedOrders,
      pendingOrders,
      orders,            // still listing recent orders below
      shipStats,         // ✅ for your in-transit & delivered pills
      orderedProducts,   // ✅ product details for what they actually bought
      stats: { totalMessages, unreadMessages },

      // buttons/links can stay
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ Buyer dashboard error:", err);
    req.flash("error", "Failed to load buyer dashboard.");
    res.redirect("/business/login");
  }
});

/* ----------------------------------------------------------
 * 🧭 GET: Universal Dashboard Redirector
 * -------------------------------------------------------- */
router.get("/dashboard", requireBusiness, (req, res) => {
  const { role } = req.session.business;

  switch (role) {
    case "seller":
      return res.redirect("/business/dashboards/seller-dashboard");
    case "supplier":
      return res.redirect("/business/dashboards/supplier-dashboard");
    case "buyer":
      return res.redirect("/business/dashboards/buyer-dashboard");
    default:
      req.flash("error", "Invalid business role.");
      return res.redirect("/business/login");
  }
});

router.post("/logout", (req, res) => {
  if (!req.session) return res.redirect("/business/login");

  // ✅ store flash message first
  req.flash("success", "You’ve been logged out successfully.");

  // ✅ now destroy session
  req.session.destroy(err => {
    if (err) {
      console.error("❌ Logout error:", err);
      return res.redirect("/business/dashboard");
    }

    res.clearCookie("connect.sid");
    res.redirect("/business/login");
  });
});




/* ----------------------------------------------------------
 * 👤 Profile Management
 * -------------------------------------------------------- */
router.get("/profile", requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business/renderlog-in");
    }

    res.render("business-profile", {
      title: "Business Profile",
      business,
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error("❌ Business profile error:", err);
    req.flash("error", "Failed to load profile.");
    res.redirect("/business/dashboard");
  }
});

/* ----------------------------------------------------------
 * ✏️ Edit Profile
 * -------------------------------------------------------- */
router.get("/profile/edit", requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business/login");
    }

    res.render("edit-profile", {
      title: "Edit Profile",
      business,
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error("❌ Edit profile page error:", err);
    req.flash("error", "Failed to load edit profile page.");
    res.redirect("/business/profile");
  }
});

router.post("/profile/edit", requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id);
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business/renderlog-in");
    }

    const { name, phone, country, city, address, password } = req.body;
    business.name = name || business.name;
    business.phone = phone || business.phone;
    business.country = country || business.country;
    business.city = city || business.city;
    business.address = address || business.address;

    if (password && password.trim().length >= 6)
      business.password = await bcrypt.hash(password, 12);

    await business.save();
    req.session.business.name = business.name;

    req.flash("success", "✅ Profile updated successfully.");
    res.redirect("/business/profile");
  } catch (err) {
    console.error("❌ Profile update error:", err);
    req.flash("error", "❌ Failed to update profile.");
    res.redirect("/business/profile");
  }
});

/* ----------------------------------------------------------
 * 🗑️ Delete Profile
 * -------------------------------------------------------- */
router.get("/profile/delete", requireBusiness, async (req, res) => {
  try {
    const business = await Business.findById(req.session.business._id).lean();
    if (!business) {
      req.flash("error", "Business not found.");
      return res.redirect("/business/login");
    }

    res.render("delete-profile", {
      title: "Delete Profile",
      business,
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error("❌ Delete profile render error:", err);
    req.flash("error", "Failed to load delete confirmation page.");
    res.redirect("/business/profile");
  }
});

router.post("/profile/delete", requireBusiness, async (req, res) => {
  try {
    await Business.findByIdAndDelete(req.session.business._id);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      req.flash("success", "✅ Business account deleted.");
      res.redirect("/");
    });
  } catch (err) {
    console.error("❌ Delete business error:", err);
    req.flash("error", "Failed to delete account.");
    res.redirect("/business/profile");
  }
});

module.exports = router;
