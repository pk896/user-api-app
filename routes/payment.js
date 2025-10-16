// routes/payment.js
const express = require("express");
const router = express.Router();

// ✅ Mongo model to persist successful captures
const Order = require("../models/Order");

/**
 * ENV REQUIRED
 *  - PAYPAL_CLIENT_ID
 *  - PAYPAL_CLIENT_SECRET
 *  - PAYPAL_MODE = "sandbox" | "live" (defaults to sandbox)
 * Optional:
 *  - BASE_CURRENCY (defaults to "USD")
 *  - PUBLIC_BASE_URL (e.g. https://your-app.example.com)
 */
// const _fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
// const fetch = global.fetch || _fetch;

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = "sandbox",
  BASE_CURRENCY = "USD",
  PUBLIC_BASE_URL,
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET");
}

const PP_API = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

/* ---------------------------------------------
 * Helpers
 * ------------------------------------------- */
function getBaseUrl(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
function toCents(v) {
  const n = typeof v === "string" ? v.trim() : v;
  const num = Number(n);
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}
function centsToString(c) { return (c / 100).toFixed(2); }
function safeQty(q) { const n = Number(q); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1; }

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const data = await r.json();
  if (!r.ok) { console.error("❌ OAuth failed:", data); throw new Error(`OAuth failed: ${r.status}`); }
  return data.access_token;
}

/* ---------------------------------------------
 * GET /payment/config  (kept for reference)
 * ------------------------------------------- */
router.get("/config", (_req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, mode: PAYPAL_MODE, currency: BASE_CURRENCY, baseCurrency: BASE_CURRENCY });
});

/* ---------------------------------------------
 * POST /payment/create-order
 *  - Creates an order with return/cancel URLs
 *  - Returns JSON (id + links). You can redirect client-side if you want.
 * Body: { items, shipping?, tax?, reference? }
 * ------------------------------------------- */
router.post("/create-order", async (req, res) => {
  try {
    const { items = [], shipping = 0, tax = 0, reference } = req.body || {};
    const baseUrl = getBaseUrl(req);

    let itemsTotalCents = 0;
    const ppItems = (Array.isArray(items) ? items : []).map((it, i) => {
      const name = (it?.name ?? `Item ${i + 1}`).toString();
      const qty = safeQty(it?.quantity);
      const unitCents = toCents(it?.unit_amount);
      if (unitCents > 0 && qty > 0) itemsTotalCents += unitCents * qty;
      return { name, quantity: String(qty), unit_amount: { currency_code: BASE_CURRENCY, value: centsToString(unitCents) } };
    });

    const shippingCents = toCents(shipping);
    const taxCents = toCents(tax);
    const grandTotalCents = itemsTotalCents + shippingCents + taxCents;
    if (grandTotalCents <= 0) {
      return res.status(422).json({ success: false, message: "Order total must be greater than zero." });
    }

    const token = await getAccessToken();
    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: reference || `PK-${Date.now()}`,
        amount: {
          currency_code: BASE_CURRENCY,
          value: centsToString(grandTotalCents),
          breakdown: {
            item_total: { currency_code: BASE_CURRENCY, value: centsToString(itemsTotalCents) },
            shipping:   { currency_code: BASE_CURRENCY, value: centsToString(shippingCents) },
            tax_total:  { currency_code: BASE_CURRENCY, value: centsToString(taxCents) },
          },
        },
        ...(itemsTotalCents > 0 ? { items: ppItems } : {}),
      }],
      application_context: {
        return_url: `${baseUrl}/payment/return`,
        cancel_url: `${baseUrl}/payment/cancel`,
        brand_name: "Phakisi Global E-commerce",
        user_action: "PAY_NOW",
        landing_page: "LOGIN",
      },
    };

    const r = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) { console.error("❌ PayPal create order failed:", data); return res.status(r.status).json({ success:false, paypal: data }); }

    res.status(201).json({ id: data.id, status: data.status, links: data.links });
  } catch (err) {
    console.error("❌ /payment/create-order error:", err);
    res.status(500).json({ success: false, message: err.message || "Server error" });
  }
});

/* ---------------------------------------------
 * GET /payment/start  (easy browser test, no JS)
 * Example:
 * /payment/start?name=New%20Test&price=12.00&qty=1&shipping=2.00&tax=1.00
 * ------------------------------------------- */
router.get("/start", async (req, res) => {
  try {
    const name = (req.query.name || "Test Item").toString();
    const price = req.query.price || "10.00";
    const qty = Number(req.query.qty || 1);
    const shipping = req.query.shipping || "0.00";
    const tax = req.query.tax || "0.00";

    // compute totals
    const toCents = (v) => Math.round(Number(v) * 100);
    const centsToString = (c) => (c / 100).toFixed(2);
    const q = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;

    const itemsTotalCents = toCents(price) * q;
    const shippingCents   = toCents(shipping);
    const taxCents        = toCents(tax);
    const grandTotalCents = itemsTotalCents + shippingCents + taxCents;
    if (grandTotalCents <= 0) return res.status(422).send("Total must be > 0");

    const baseUrl = (function getBaseUrl() {
      if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL.replace(/\/+$/, "");
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
      const host = req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3000";
      return `${proto}://${host}`;
    })();

    const token = await getAccessToken();

    const body = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: `PK-${Date.now()}`,
        amount: {
          currency_code: BASE_CURRENCY,
          value: centsToString(grandTotalCents),
          breakdown: {
            item_total: { currency_code: BASE_CURRENCY, value: centsToString(itemsTotalCents) },
            shipping:   { currency_code: BASE_CURRENCY, value: centsToString(shippingCents) },
            tax_total:  { currency_code: BASE_CURRENCY, value: centsToString(taxCents) },
          },
        },
        items: [{
          name,
          quantity: String(q),
          unit_amount: { currency_code: BASE_CURRENCY, value: centsToString(toCents(price)) }
        }]
      }],
      application_context: {
        return_url: `${baseUrl}/payment/return`,
        cancel_url: `${baseUrl}/payment/cancel`,
        brand_name: "Phakisi Global E-commerce",
        user_action: "PAY_NOW",
        landing_page: "LOGIN",
      },
    };

    const r = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("❌ PayPal create (redirect) failed:", data);
      return res.status(r.status).send(data?.message || "Create order failed");
    }

    const approve = (data.links || []).find(l => l.rel === "approve")?.href;
    if (!approve) return res.status(500).send("No approve link from PayPal");
    return res.redirect(302, approve);
  } catch (e) {
    console.error("❌ /payment/start error:", e);
    res.status(500).send(e.message || "fetch failed");
  }
});


/* ---------------------------------------------
 * GET /payment/start  (easy browser test, no JS)
 * Example:
 * /payment/start?name=New%20Test&price=12.00&qty=1&shipping=2.00&tax=1.00
 * ------------------------------------------- */
/*router.get("/start", async (req, res) => {
  try {
    const name = (req.query.name || "Test Item").toString();
    const price = req.query.price || "10.00";
    const qty = Number(req.query.qty || 1);
    const shipping = req.query.shipping || "0.00";
    const tax = req.query.tax || "0.00";

    // call our own API to build the order
    const r = await fetch(`${getBaseUrl(req)}/payment/create-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ name, quantity: qty, unit_amount: price }], shipping, tax }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).send(data?.message || "Create order failed");

    const approve = (data.links || []).find(l => l.rel === "approve")?.href;
    if (!approve) return res.status(500).send("No approve link from PayPal");
    return res.redirect(302, approve);
  } catch (e) {
    console.error("❌ /payment/start error:", e);
    res.status(500).send(e.message);
  }
});*/

/* ---------------------------------------------
 * GET /payment/return  (PayPal redirects here)
 * We capture, save, clear cart, then render receipt using your layout.
 * ------------------------------------------- */
router.get("/return", async (req, res) => {
  try {
    const orderID = req.query.token; // PayPal sends ?token=<orderId>
    if (!orderID) return res.status(400).send("Missing token");

    const token = await getAccessToken();
    const capRes = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const data = await capRes.json();

    if (!capRes.ok) {
      console.error("❌ Capture on return failed:", data);
      return res.status(capRes.status).render("order-cancel", {
        layout: "layout",
        title: "Payment Error",
        reason: (data && data.name) || "CAPTURE_FAILED",
        themeCss: "/css/light.css",
        active: "checkout",
        nonce: req.nonce || "",
      });
    }

    // Save order (best-effort) + clear cart
    try {
      const pu = data.purchase_units?.[0] || {};
      const cap = pu.payments?.captures?.[0] || {};
      const payer = data.payer || {};
      const addr = pu.shipping?.address || {};
      const breakdown = cap.seller_receivable_breakdown || {};

      await Order.create({
        orderId: data.id,
        captureId: cap.id,
        status: data.status,
        currency: cap.amount?.currency_code,
        amount: cap.amount?.value,
        fee: breakdown.paypal_fee?.value,
        net: breakdown.net_amount?.value,
        payer: {
          id: payer.payer_id,
          email: payer.email_address,
          name: { given: payer.name?.given_name, surname: payer.name?.surname },
          country: payer.address?.country_code,
        },
        shipping: {
          name: pu.shipping?.name?.full_name,
          address_line_1: addr.address_line_1,
          city: addr.admin_area_2,
          state: addr.admin_area_1,
          postal_code: addr.postal_code,
          country_code: addr.country_code,
        },
        raw: data,
      });

      if (req.session) delete req.session.cart; // ⬅️ this is where to clear cart
    } catch (e) {
      console.error("⚠️ Order save failed:", e.message);
    }

    // Render receipt inside your layout
    res.render("order-success", {
      layout: "layout",
      title: "Payment Successful",
      order: data,
      showDebug: process.env.NODE_ENV !== "production", // ⬅️ add this
      themeCss: "/css/light.css",
      active: "checkout",
      nonce: req.nonce || "",
    });
  } catch (err) {
    console.error("❌ /payment/return error:", err);
    res.status(500).render("order-cancel", {
      layout: "layout",
      title: "Payment Error",
      reason: err.message,
      themeCss: "/css/light.css",
      active: "checkout",
      nonce: req.nonce || "",
    });
  }
});

/* ---------------------------------------------
 * GET /payment/cancel  (buyer canceled at PayPal)
 * ------------------------------------------- */
// routes/payment.js
router.get("/cancel", (req, res) => {
  const { token, reason, message } = req.query || {};
  res.render("order-cancel", {
    title: "Payment Cancelled",
    token: token || null,
    reason: reason || null,   // let template choose fallback
    message: message || null, // let template choose fallback
    paypal: null,             // or a PayPal error object if you have it
    showDebug: false
  });
});


/* ---------------------------------------------
 * POST /payment/refund (kept; supports partial)
 * Body: { captureId, amount?, currency? }
 * ------------------------------------------- */
router.post("/refund", async (req, res) => {
  try {
    const { captureId, amount, currency } = req.body || {};
    if (!captureId) return res.status(400).json({ success: false, message: "captureId is required" });

    const token = await getAccessToken();

    // Check capture so we don't double-refund
    const capGet = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const capInfo = await capGet.json();
    if (!capGet.ok) {
      console.error("❌ Capture lookup failed:", capInfo);
      return res.status(capGet.status).json({ success: false, paypal: capInfo });
    }
    if (capInfo.status === "REFUNDED") {
      return res.status(409).json({ success: false, message: "Capture already fully refunded", paypalStatus: "REFUNDED" });
    }

    const body = amount
      ? { amount: { value: String(amount), currency_code: currency || capInfo.amount?.currency_code || BASE_CURRENCY } }
      : {};

    const r = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("❌ PayPal refund failed:", data);
      return res.status(r.status).json({ success: false, paypal: data });
    }

    // (optional) persist refund against Order
    try {
      const order = await Order.findOne({ captureId });
      if (order) {
        order.refunds = order.refunds || [];
        order.refunds.push({
          refundId: data.id,
          status: data.status,
          amount: data.amount?.value || body.amount?.value || capInfo.amount?.value,
          currency: data.amount?.currency_code || body.amount?.currency_code || capInfo.amount?.currency_code || BASE_CURRENCY,
          createdAt: new Date(),
        });
        const prev = Number(order.refundedTotal || "0");
        const add = Number(data.amount?.value || body.amount?.value || 0);
        order.refundedTotal = (prev + add).toFixed(2);
        if (Number(order.refundedTotal) >= Number(capInfo.amount?.value || 0)) {
          order.captureStatus = "REFUNDED";
        } else if (add > 0) {
          order.captureStatus = "PARTIALLY_REFUNDED";
        }
        await order.save();
      }
    } catch (dbErr) {
      console.error("⚠️ Failed to record refund:", dbErr.message);
    }

    res.json({ success: true, refund: data });
  } catch (e) {
    console.error("❌ /payment/refund error:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

/* ---------------------------------------------
 * GET /payment/debug/order/:id (for troubleshooting)
 * ------------------------------------------- */
router.get("/debug/order/:id", async (req, res) => {
  try {
    const token = await getAccessToken();
    const r = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(req.params.id)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
