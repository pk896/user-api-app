// routes/businessAuth.js
const express = require("express");
const bcrypt = require("bcrypt");
const { body, validationResult } = require("express-validator");
const Business = require("../models/Business");
const Product = require("../models/Product");
const ContactMessage = require("../models/ContactMessage");
const requireBusiness = require("../middleware/requireBusiness");
const redirectIfLoggedIn = require("../middleware/redirectIfLoggedIn");


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

/* ----------------------------------------------------------
 * 🧭 GET: Seller Dashboard
 * -------------------------------------------------------- */
router.get("/dashboards/seller-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }

    // 🧮 Fetch product stats
    const [totalProducts, inStock, lowStock, outOfStock] = await Promise.all([
      Product.countDocuments({ business: business._id }),
      Product.countDocuments({ business: business._id, stock: { $gt: 0 } }),
      Product.countDocuments({ business: business._id, stock: { $lte: 5, $gt: 0 } }),
      Product.countDocuments({ business: business._id, stock: 0 }),
    ]);

    // 🧾 Recent 5 products for seller
    const products = await Product.find({ business: business._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // 💬 Placeholder message stats
    const stats = {
      totalMessages: 2,
      unreadMessages: 1,
    };

    // 🧾 Placeholder order list
    const orders = [
      { _id: "ORD123", status: "Completed", total: 120.0 },
      { _id: "ORD124", status: "Pending", total: 80.5 },
    ];

    res.render("dashboards/seller-dashboard", {
      title: "Seller Dashboard",
      business,
      totalProducts,
      inStock,
      lowStock,
      outOfStock,
      products, // ✅ added back — required by EJS
      orders,
      stats,
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

// ----------------------------------------------------------
// 🧭 GET: Supplier Dashboard (Full Version)
// --------------------------------------------------------
router.get("/dashboards/supplier-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;

    // 🧱 Ensure valid session
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }

    // 🧱 Ensure correct role
    if (business.role !== "supplier") {
      req.flash("error", "⛔ Access denied. Supplier accounts only.");
      return res.redirect("/business/dashboard");
    }

    // 🎨 Theme setup
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    // 📦 Supplier products (latest 5)
    const products = await Product.find({ business: business._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    // 📊 Product statistics
    const totalProducts = await Product.countDocuments({ business: business._id });
    const inStock = await Product.countDocuments({ business: business._id, stock: { $gt: 10 } });
    const lowStock = await Product.countDocuments({ business: business._id, stock: { $gt: 0, $lte: 10 } });
    const outOfStock = await Product.countDocuments({ business: business._id, stock: 0 });

    // 🚚 Shipment placeholders (will integrate real Shipment model later)
    const totalShipments = 4;
    const pendingShipments = 1;
    const shipments = [
      { orderId: "ORD5001", status: "Delivered", updatedAt: new Date("2025-10-01T14:00:00Z") },
      { orderId: "ORD5002", status: "Pending", updatedAt: new Date("2025-10-04T10:30:00Z") },
      { orderId: "ORD5003", status: "In Transit", updatedAt: new Date("2025-10-06T09:00:00Z") },
      { orderId: "ORD5004", status: "Delivered", updatedAt: new Date("2025-10-07T11:15:00Z") },
    ];

    // 💬 Messages statistics
    const totalMessages = await ContactMessage.countDocuments({ business: business._id });
    const unreadMessages = await ContactMessage.countDocuments({
      business: business._id,
      readByBusiness: false,
    });

    // ✅ Render Supplier Dashboard
    res.render("dashboards/supplier-dashboard", {
      title: "Supplier Dashboard",
      business,
      products,
      totalProducts,
      inStock,
      lowStock,
      outOfStock,
      totalShipments,
      pendingShipments,
      shipments, // ✅ Added this line
      stats: { totalMessages, unreadMessages },
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

/* ----------------------------------------------------------
 * 🧭 GET: Buyer Dashboard (Isolated by Buyer)
 * -------------------------------------------------------- */
router.get("/dashboards/buyer-dashboard", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;

    // ✅ Ensure buyer is logged in
    if (!business || !business._id) {
      req.flash("error", "Session expired. Please log in again.");
      return res.redirect("/business/login");
    }

    if (business.role !== "buyer") {
      req.flash("error", "⛔ Access denied. Buyer accounts only.");
      return res.redirect("/business/dashboard");
    }

    const Order = require("../models/Order");
    const ContactMessage = require("../models/ContactMessage");

    // 🧾 Fetch only orders belonging to this buyer
    const orders = await Order.find({ businessBuyer: business._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .lean();

    const totalOrders = await Order.countDocuments({ businessBuyer: business._id });
    const completedOrders = await Order.countDocuments({
      businessBuyer: business._id,
      status: "Completed",
    });
    const pendingOrders = await Order.countDocuments({
      businessBuyer: business._id,
      status: "Pending",
    });

    // 💬 Fetch message stats for this buyer (if available)
    let totalMessages = 0;
    let unreadMessages = 0;
    try {
      totalMessages = await ContactMessage.countDocuments({ business: business._id });
      unreadMessages = await ContactMessage.countDocuments({
        business: business._id,
        readByBusiness: false,
      });
    } catch {
      console.warn("💬 ContactMessage model not active, skipping message counts.");
    }

    // ✅ Render Buyer Dashboard
    res.render("dashboards/buyer-dashboard", {
      title: "Buyer Dashboard",
      business,
      totalOrders,
      completedOrders,
      pendingOrders,
      orders,
      stats: { totalMessages, unreadMessages },
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
