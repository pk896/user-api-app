// routes/adminOrders.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order");

const {
  PAYPAL_MODE = "sandbox",
} = process.env;

const PP_ACTIVITY_BASE =
  PAYPAL_MODE === "live"
    ? "https://www.paypal.com/activity/payment/"
    : "https://www.sandbox.paypal.com/activity/payment/";

// --- Page (EJS) ---
router.get("/admin/orders", async (req, res) => {
  res.render("orders-admin", {
    title: "Orders (Admin)",
    nonce: res.locals.nonce,
    themeCss: res.locals.themeCss,
    paypalMode: PAYPAL_MODE,
    ppActivityBase: PP_ACTIVITY_BASE,
  });
});

// --- Data API (recent orders) ---
router.get("/api/admin/orders", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 50), 200);
    const orders = await Order
      .find({}, {
        orderId: 1,
        status: 1,
        amount: 1,
        fee: 1,
        net: 1,
        payer: 1,
        captures: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // flatten for the UI
    const rows = orders.map(o => {
      const firstCap = (o.captures && o.captures[0]) || {};
      return {
        orderId: o.orderId,
        status: o.status,
        amount: o.amount?.value,
        currency: o.amount?.currency,
        fee: o.fee,
        net: o.net,
        payerEmail: o.payer?.email,
        payerName: [o.payer?.name?.given, o.payer?.name?.surname].filter(Boolean).join(" "),
        captureId: firstCap.captureId,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
      };
    });

    res.json({ ok: true, orders: rows });
  } catch (e) {
    console.error("❌ /api/admin/orders error:", e);
    res.status(500).json({ ok: false, message: "Failed to load orders" });
  }
});

module.exports = router;
