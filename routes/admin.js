// routes/admin.js
const express = require("express");
const router = express.Router();
const requireAdmin = require("../middleware/requireAdmin");
const ContactMessage = require("../models/ContactMessage");

/* ===========================================================
 * 🧭 GET: Admin Login Page
 * =========================================================== */
router.get("/login", (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

  // If already logged in, redirect to dashboard
  if (req.session.admin) {
    console.log("ℹ️ Admin already logged in, redirecting to dashboard...");
    return res.redirect("/admin/dashboard");
  }

  res.render("admin-login", {
    title: "Admin Login",
    nonce: res.locals.nonce,
    themeCss,
  });
});

/* ===========================================================
 * 🔑 POST: Authenticate Admin (case-insensitive)
 * =========================================================== */
router.post("/login", (req, res) => {
  const usernameInput = (req.body.username || "").trim().toLowerCase();
  const passwordInput = (req.body.password || "").trim();

  const ADMIN_USER = (process.env.ADMIN_USER || "admin").trim().toLowerCase();
  const ADMIN_PASS = (process.env.ADMIN_PASS || "12345").trim();

  console.log("🧩 Incoming admin login:", { usernameInput, passwordInput });
  console.log("🔑 Expected credentials:", { ADMIN_USER, ADMIN_PASS });

  // ✅ Case-insensitive username, exact password
  if (usernameInput === ADMIN_USER && passwordInput === ADMIN_PASS) {
    console.log("✅ Admin authenticated successfully!");
    req.session.admin = { name: process.env.ADMIN_USER || "Admin" };
    req.flash("success", `Welcome back, ${req.session.admin.name}!`);
    return res.redirect("/admin/dashboard");
  }

  console.warn("❌ Invalid admin credentials!");
  req.flash("error", "❌ Invalid credentials. Please try again.");
  res.redirect("/admin/login");
});

/* ===========================================================
 * 🧱 GET: Admin Dashboard (Protected)
 * ===========================================================
 * - Shows message stats
 * - Displays recent messages
 * - Syncs with unified contact route
 * =========================================================== */
router.get("/dashboard", requireAdmin, async (req, res) => {
  try {
    console.log("✅ Admin session:", req.session.admin);

    // 🧮 Stats Calculation
    const total = await ContactMessage.countDocuments();
    const replied = await ContactMessage.countDocuments({
      "thread.sender": "admin",
    });
    const pending = total - replied;
    const unreadForAdmin = await ContactMessage.countDocuments({
      readByAdmin: false,
    });

    // 🕒 Recent messages preview
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

/* ===========================================================
 * 🚪 GET: Admin Logout
 * =========================================================== */
router.get("/logout", (req, res) => {
  try {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      console.log("👋 Admin logged out successfully.");
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
