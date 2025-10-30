// routes/notifications.js
const express = require("express");
const router = express.Router();
const Notification = require("../models/Notification");
const requireBusiness = require("../middleware/requireBusiness");

// 📄 List inbox
router.get("/", requireBusiness, async (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
  const nonce = res.locals.nonce || "";
  const buyer = req.session.business;

  const page = Math.max(1, Number(req.query.page || 1));
  const per  = Math.min(50, Math.max(5, Number(req.query.per || 20)));
  const q    = { buyerId: buyer._id };
  const total = await Notification.countDocuments(q);
  const items = await Notification.find(q)
    .sort({ createdAt: -1 })
    .skip((page - 1) * per)
    .limit(per)
    .lean();

  res.render("notifications/index", {
    title: "Notifications",
    themeCss, nonce,
    notifications: items,
    page, per, total,
    pages: Math.ceil(total / per),
    success: req.flash("success"),
    error: req.flash("error"),
    business: buyer,
  });
});

// dev-only: create one notification for the logged-in business
router.post("/dev/notify", requireBusiness, async (req, res) => {
  const { createNotification } = require("../utils/notify");
  await createNotification({
    buyerId: req.session.business._id,
    type: "match.pending",
    title: "Test notification",
    message: "This is a test."
  });
  res.redirect("/notifications");
});

// ✅ Mark one as read
router.post("/:id/read", requireBusiness, async (req, res) => {
  const buyer = req.session.business;
  await Notification.updateOne(
    { _id: req.params.id, buyerId: buyer._id },
    { $set: { readAt: new Date() } }
  );
  res.redirect("/notifications");
});

// ✅ Mark all as read (used by the view button & optional navbar script)
router.post("/mark-all-read", requireBusiness, async (req, res) => {
  const buyer = req.session.business;
  await Notification.updateMany(
    { buyerId: buyer._id, readAt: null },
    { $set: { readAt: new Date() } }
  );
  req.flash("success", "All notifications marked as read.");
  res.redirect("/notifications");
});

// 🔢 JSON unread count (navbar poller)
router.get("/unread-count", requireBusiness, async (req, res) => {
  const buyer = req.session.business;
  const count = await Notification.countDocuments({ buyerId: buyer._id, readAt: null });
  res.json({ count });
});

module.exports = router;
