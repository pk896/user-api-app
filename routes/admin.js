const express = require("express");
const router = express.Router();
const requireAdmin = require("../middleware/requireAdmin");
const ContactMessage = require("../models/ContactMessage");

// -- Login page (reuses admin-login.ejs)
router.get("/login", (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
  if (req.session.admin) return res.redirect("/admin/dashboard");
  res.render("admin-login", {
    title: "🔐 Admin Login",
    formAction: "/admin/login",
    themeCss,
    nonce: res.locals.nonce,
    success: req.flash("success"),
    error: req.flash("error"),
  });
});

// -- POST login
router.post("/login", (req, res) => {
  const usernameInput = (req.body.username || "").trim().toLowerCase();
  const passwordInput = (req.body.password || "").trim();
  const ADMIN_USER = (process.env.ADMIN_USER || "admin").trim().toLowerCase();
  const ADMIN_PASS = (process.env.ADMIN_PASS || "12345").trim();

  if (usernameInput === ADMIN_USER && passwordInput === ADMIN_PASS) {
    req.session.admin = { name: process.env.ADMIN_USER || "Admin" };
    req.flash("success", `Welcome back, ${req.session.admin.name}!`);
    return res.redirect("/admin/dashboard");
  }
  req.flash("error", "❌ Invalid credentials. Please try again.");
  res.redirect("/admin/login");
});

// -- Dashboard (protected)
router.get("/dashboard", requireAdmin, async (req, res) => {
  try {
    const total = await ContactMessage.countDocuments();
    const replied = await ContactMessage.countDocuments({ "thread.sender": "admin" });
    const pending = total - replied;
    const unreadForAdmin = await ContactMessage.countDocuments({ readByAdmin: false });

    const recentMessages = await ContactMessage.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select("name email thread createdAt readByAdmin");

    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    res.render("dashboards/admin-dashboard", {
      title: "Admin Dashboard",
      nonce: res.locals.nonce,
      themeCss,
      admin: req.session.admin,
      stats: { total, replied, pending, unreadForAdmin },
      recentMessages,
    });
  } catch (err) {
    console.error("❌ Error loading admin dashboard:", err);
    req.flash("error", "❌ Could not load dashboard data.");
    res.redirect("/admin/login");
  }
});

// -- Orders page (protected)
router.get("/orders", requireAdmin, (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
  const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
  const ppActivityBase = mode === "live"
    ? "https://www.paypal.com/activity/payment/"
    : "https://www.sandbox.paypal.com/activity/payment/";

  res.render("orders-admin", {
    title: "Orders (Admin)",
    nonce: res.locals.nonce,
    themeCss,
    ppActivityBase,
  });
});

// -- Logout
router.get("/logout", (req, res) => {
  try {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      req.flash("info", "👋 You have been logged out successfully.");
      res.redirect("/admin/login");
    });
  } catch (err) {
    console.error("❌ Error logging out admin:", err);
    req.flash("error", "⚠️ Logout failed. Please try again.");
    res.redirect("/admin/dashboard");
  }
});

module.exports = router;
