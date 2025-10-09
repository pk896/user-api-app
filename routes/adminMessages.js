// routes/adminMessages.js
const express = require("express");
const router = express.Router();
const requireBusiness = require("../middleware/requireBusiness");
const ContactMessage = require("../models/ContactMessage");

/* -------------------------------------------
 * 📥 GET: View all recent contact messages
 * ----------------------------------------- */
router.get("/messages", requireBusiness, async (req, res) => {
  try {
    const messages = await ContactMessage.find().sort({ createdAt: -1 });

    res.render("admin/messages", {
      title: "Contact Messages",
      messages,
      business: req.session.business,
      nonce: res.locals.nonce,
      themeCss: req.session.theme || "light.css",
      success: req.flash("success"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("❌ Error loading messages:", err);
    req.flash("error", "Unable to load messages.");
    res.redirect("/business/dashboard");
  }
});

module.exports = router;
