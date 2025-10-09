// routes/businessDashboard.js
const express = require("express");
const router = express.Router();
const requireBusiness = require("../middleware/requireBusiness");
const Product = require("../models/Product");
const ContactMessage = require("../models/ContactMessage");

/* -------------------------------------------
 * 🏠 GET: Business Dashboard
 * ----------------------------------------- */
router.get("/dashboard", requireBusiness, async (req, res) => {
  try {
    const businessId = req.session.business._id;

    // 🧮 Stats
    const totalProducts = await Product.countDocuments({ business: businessId });
    const totalMessages = await ContactMessage.countDocuments({ business: businessId });
    const unreadMessages = await ContactMessage.countDocuments({
      business: businessId,
      readByBusiness: false, // ✅ unread for this business
    });

    // 🕓 Recent messages
    const recentMessages = await ContactMessage.find({ business: businessId })
      .sort({ createdAt: -1 })
      .limit(5);

    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    res.render("dashboards/business-dashboard", {
      title: "Business Dashboard",
      nonce: res.locals.nonce,
      themeCss,
      business: req.session.business,
      stats: { totalProducts, totalMessages, unreadMessages },
      recentMessages,
    });
  } catch (err) {
    console.error("❌ Error loading business dashboard:", err);
    req.flash("error", "❌ Could not load dashboard.");
    res.redirect("/business/login");
  }
});

/* -------------------------------------------
 * 💬 GET: All messages (search + pagination)
 * ----------------------------------------- */
router.get("/messages", requireBusiness, async (req, res) => {
  try {
    const businessId = req.session.business._id;
    const search = req.query.search ? req.query.search.trim() : "";
    const page = parseInt(req.query.page) || 1;
    const limit = 6;

    // 🔍 Filter by business and optional search
    const filter = { business: businessId };
    if (search) {
      filter.$or = [
        { "thread.message": new RegExp(search, "i") },
        { name: new RegExp(search, "i") },
        { email: new RegExp(search, "i") },
      ];
    }

    const skip = (page - 1) * limit;
    const totalMessages = await ContactMessage.countDocuments(filter);
    const totalPages = Math.ceil(totalMessages / limit);

    const messages = await ContactMessage.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    res.render("business-messages", {
      title: "Your Messages",
      nonce: res.locals.nonce,
      themeCss,
      business: req.session.business,
      messages,
      currentPage: page,
      totalPages,
      search,
    });
  } catch (err) {
    console.error("❌ Error loading business messages:", err);
    req.flash("error", "❌ Could not load your messages.");
    res.redirect("/business/dashboard");
  }
});

/* -------------------------------------------
 * 💬 POST: Reply to message
 * ----------------------------------------- */
router.post("/reply/:id", requireBusiness, async (req, res) => {
  try {
    const { reply } = req.body;
    if (!reply || !reply.trim()) {
      req.flash("error", "⚠️ Please write a message before sending.");
      return res.redirect("/business/messages");
    }

    const message = await ContactMessage.findById(req.params.id);
    if (!message) {
      req.flash("error", "Message not found.");
      return res.redirect("/business/messages");
    }

    // ✅ Append reply to thread
    message.thread.push({
      sender: "business",
      message: reply.trim(),
      timestamp: new Date(),
    });

    // 🔁 Update read flags
    message.readByAdmin = false; // notify admin
    message.readByBusiness = true; // mark as read for this business

    await message.save();

    req.flash("success", "✅ Reply sent to admin.");
    res.redirect("/business/messages");
  } catch (err) {
    console.error("❌ Error sending business reply:", err);
    req.flash("error", "❌ Could not send your reply.");
    res.redirect("/business/messages");
  }
});

/* -------------------------------------------
 * 📬 PATCH: Mark message as read (AJAX)
 * ----------------------------------------- */
router.patch("/mark-read/:id", requireBusiness, async (req, res) => {
  try {
    await ContactMessage.findByIdAndUpdate(req.params.id, {
      readByBusiness: true,
    });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Error marking message as read:", err);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
