// routes/payment.js
const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");
const Product = require("../models/Product");
const Order = require("../models/Order");

// ───────────────────────────────────────────────────────────
// PayPal client / config
// ───────────────────────────────────────────────────────────
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_ENV = (process.env.PAYPAL_ENV || "sandbox").toLowerCase(); // "live" for prod
const CURRENCY = (process.env.CURRENCY || "ZAR").toUpperCase(); // Your shop shows Rands
const VAT_RATE = process.env.VAT_RATE ? Number(process.env.VAT_RATE) : 0.15; // 15% default
const SHIPPING_FLAT = process.env.SHIPPING_FLAT ? Number(process.env.SHIPPING_FLAT) : 0; // R0 default
const BRAND_NAME = process.env.BRAND_NAME || "Your Store";

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing.");
}

const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: PAYPAL_CLIENT_ID,
    oAuthClientSecret: PAYPAL_CLIENT_SECRET,
  },
  environment: PAYPAL_ENV === "live" ? Environment.Live : Environment.Sandbox,
  logging: { logLevel: LogLevel.Info },
});

// ───────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────
function ensureCart(req) {
  if (!req.session.cart) req.session.cart = { items: [] };
  return req.session.cart;
}

function toMoney(n) {
  return Number(n || 0).toFixed(2);
}

function pickCaptureSummary(ppOrder) {
  const pu = ppOrder?.purchase_units?.[0] || {};
  const capture = pu?.payments?.captures?.[0] || {};
  const payer = ppOrder?.payer || {};
  const shipping = pu?.shipping || {};

  return {
    status:
      ppOrder?.status || capture?.status || "UNKNOWN",
    captureId: capture?.id || null,
    amount: capture?.amount?.value ? Number(capture.amount.value) : null,
    currency: capture?.amount?.currency_code || null,
    payerEmail: payer?.email_address || null,
    payerName:
      payer?.name?.given_name || payer?.name?.surname
        ? `${payer?.name?.given_name || ""} ${payer?.name?.surname || ""}`.trim()
        : null,
    shipToName: shipping?.name?.full_name || null,
    shipToAddress: shipping?.address || null,
  };
}

// ───────────────────────────────────────────────────────────
// GET /payment/client-id  → used by checkout.ejs to load SDK
// ───────────────────────────────────────────────────────────
router.get("/client-id", (_req, res) => {
  return res.json({
    clientId: PAYPAL_CLIENT_ID,
    intent: "CAPTURE",
    // If you want SDK URL to enforce currency on the client:
    // currency: CURRENCY,
  });
});

// ───────────────────────────────────────────────────────────
// POST /payment/create-order
// Re-price from DB, compute VAT + shipping, create PayPal order,
// persist a Pending Order (guest checkout allowed).
// Optional: accept shipping provided by your form and pass to PayPal.
// ───────────────────────────────────────────────────────────
router.post("/create-order", async (req, res) => {
  try {
    const cart = ensureCart(req);
    if (!cart.items.length) {
      return res.status(400).json({ message: "Cart is empty." });
    }

    // Fetch authoritative product data
    const ids = [...new Set(cart.items.map((i) => i.productId))];
    const dbProducts = await Product.find({ _id: { $in: ids } })
      .select("_id name price")
      .lean();

    // Build items from DB (never trust client/session price)
    const items = cart.items
      .map((ci) => {
        const p = dbProducts.find((x) => String(x._id) === String(ci.productId));
        if (!p) return null;
        return {
          id: String(p._id),
          name: p.name,
          quantity: Math.max(1, Number(ci.quantity || 1)),
          price: Number(p.price || 0),
        };
      })
      .filter(Boolean);

    if (!items.length) {
      return res.status(400).json({ message: "No valid items in cart." });
    }

    // Compute totals
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const tax = subtotal * VAT_RATE;
    const shipping = SHIPPING_FLAT;
    const total = subtotal + tax + shipping;

    if (!(total > 0)) {
      return res.status(400).json({ message: "Calculated total is invalid." });
    }

    // If you collected shipping via a form (optional), you can pass it to PayPal
    // by setting shipping_preference: "SET_PROVIDED_ADDRESS" and providing shipping.
    // Otherwise, let PayPal use the buyer's profile address.
    const useProvidedShipping = false; // set true if you post address in req.body

    const orderRequest = {
      intent: "CAPTURE",
      application_context: {
        brand_name: BRAND_NAME,
        user_action: "PAY_NOW",
        landing_page: "LOGIN", // or "NO_PREFERENCE"
        shipping_preference: useProvidedShipping ? "SET_PROVIDED_ADDRESS" : "GET_FROM_FILE",
        // return_url / cancel_url not required with JS SDK buttons
      },
      purchase_units: [
        {
          amount: {
            currency_code: CURRENCY,
            value: toMoney(total),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: toMoney(subtotal) },
              tax_total: { currency_code: CURRENCY, value: toMoney(tax) },
              shipping: { currency_code: CURRENCY, value: toMoney(shipping) },
            },
          },
          // If you collected shipping on your site:
          // shipping: useProvidedShipping ? {
          //   name: { full_name: req.body.name || "Customer" },
          //   address: {
          //     address_line_1: req.body.address1,
          //     address_line_2: req.body.address2 || "",
          //     admin_area_2: req.body.city,
          //     admin_area_1: req.body.province || "",
          //     postal_code: req.body.postalCode,
          //     country_code: (req.body.countryCode || "ZA").toUpperCase(),
          //   },
          // } : undefined,

          // Optional: line items (omit to reduce mismatch risks)
          // items: items.map(i => ({
          //   name: i.name,
          //   unit_amount: { currency_code: CURRENCY, value: toMoney(i.price) },
          //   quantity: String(i.quantity),
          // })),
        },
      ],
    };

    // Create order
    const ppRes = await client.execute({
      path: "/v2/checkout/orders",
      method: "POST",
      body: orderRequest,
      // headers: { "PayPal-Request-Id": someIdempotencyKey } // optional idempotency
    });

    const paypalOrderId = ppRes?.result?.id;
    if (!paypalOrderId) {
      return res.status(500).json({ message: "Failed to create PayPal order." });
    }

    // Persist Pending order (guest-friendly; store buyer if present)
    try {
      await Order.create({
        businessBuyer: req.session.business?._id || null,
        items,
        subtotal,
        tax,
        shipping,
        total,
        status: "Pending",
        paypalOrderId,
      });
    } catch (e) {
      console.warn("⚠️ Could not persist pending Order:", e?.message);
    }

    return res.json({ id: paypalOrderId });
  } catch (err) {
    console.error("PayPal Create Order Error:", err);
    return res.status(500).json({ message: "Failed to create order." });
  }
});

// ───────────────────────────────────────────────────────────
// POST /payment/capture-order
// Captures payment, enriches order with payer/shipping details,
// marks Completed, clears cart.
// ───────────────────────────────────────────────────────────
router.post("/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body || {};
    if (!orderID) {
      return res.status(400).json({ success: false, message: "Missing orderID." });
    }

    const capture = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: "POST",
    });

    const summary = pickCaptureSummary(capture?.result);

    // Update existing pending order (prefer scoping to buyer if present)
    let updated = null;
    try {
      const query = { paypalOrderId: orderID };
      if (req.session.business?._id) query.businessBuyer = req.session.business._id;

      updated = await Order.findOneAndUpdate(
        query,
        {
          status: "Completed",
          paymentDetails: capture.result,
          payerEmail: summary.payerEmail || undefined,
          payerName: summary.payerName || undefined,
          shipToName: summary.shipToName || undefined,
          shipToAddress: summary.shipToAddress || undefined,
        },
        { new: true }
      );
    } catch (e) {
      console.warn("⚠️ Could not update Order:", e?.message);
    }

    // If no pending order existed (edge case), create a minimal completed record
    if (!updated) {
      try {
        await Order.create({
          businessBuyer: req.session.business?._id || null,
          items: [],
          subtotal: 0,
          tax: 0,
          shipping: 0,
          total: summary.amount || 0,
          status: "Completed",
          paypalOrderId: orderID,
          paymentDetails: capture.result,
          payerEmail: summary.payerEmail || undefined,
          payerName: summary.payerName || undefined,
          shipToName: summary.shipToName || undefined,
          shipToAddress: summary.shipToAddress || undefined,
        });
      } catch (e) {
        console.warn("⚠️ Could not create fallback Order record:", e?.message);
      }
    }

    // Clear cart after success
    req.session.cart = { items: [] };

    return res.json({ success: true, status: summary.status, capture: capture.result });
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    return res.status(500).json({ success: false, message: "Failed to capture order." });
  }
});

// ───────────────────────────────────────────────────────────
// (Optional) GET /payment/my-orders
// If logged-in business exists, scope to them.
// Otherwise, return all (guest orders included) — customize as needed.
// ───────────────────────────────────────────────────────────
router.get("/my-orders", async (req, res) => {
  try {
    if (!Order) return res.json({ success: true, orders: [] });
    const query = {};
    if (req.session.business?._id) query.businessBuyer = req.session.business._id;
    const orders = await Order.find(query).sort({ createdAt: -1 }).lean();
    return res.json({ success: true, orders });
  } catch (err) {
    console.error("Fetch My Orders Error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch orders." });
  }
});

// ───────────────────────────────────────────────────────────
// GET /payment/order/:orderID  → minimal order summary for Thank You page
// ───────────────────────────────────────────────────────────
router.get("/order/:orderID", async (req, res) => {
  try {
    const { orderID } = req.params;
    if (!orderID) return res.status(400).json({ success: false, message: "Missing orderID." });

    const ord = await Order.findOne({ paypalOrderId: orderID }).lean();
    if (!ord) return res.status(404).json({ success: false, message: "Order not found." });

    return res.json({
      success: true,
      order: {
        id: ord._id,
        paypalOrderId: ord.paypalOrderId,
        status: ord.status,
        subtotal: ord.subtotal,
        tax: ord.tax,
        shipping: ord.shipping,
        total: ord.total,
        createdAt: ord.createdAt,
        items: (ord.items || []).map(i => ({
          name: i.name,
          quantity: i.quantity,
          price: i.price,
        })),
        payerEmail: ord.payerEmail || null,
        payerName: ord.payerName || null,
        shipToName: ord.shipToName || null,
        shipToAddress: ord.shipToAddress || null,
      }
    });
  } catch (err) {
    console.error("Order lookup error:", err);
    return res.status(500).json({ success: false, message: "Failed to fetch order." });
  }
});


module.exports = router;


















/*// routes/payment.js
const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");
const Order = require("../models/Order"); // add at top


// ✅ Initialize PayPal client (Sandbox)
const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: Environment.Sandbox, // change to Environment.Live in production
  logging: { logLevel: LogLevel.Info },
});

// ✅ Expose PayPal client ID to frontend
router.get("/config", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
});

// ✅ Create PayPal order using backend cart
router.post("/create-order", async (req, res) => {
  try {
    const cart = req.session.cart || { items: [] };
    if (cart.items.length === 0) {
      return res.status(400).json({ error: "Cart is empty" });
    }

    // 🚨 IMPORTANT: In production, fetch product prices from DB
    // For now, assume items have { productId, name, price, quantity }
    const total = cart.items.reduce((sum, item) => {
      return sum + (item.price || 0) * item.quantity;
    }, 0);

    if (total <= 0) {
      return res.status(400).json({ error: "Invalid cart total" });
    }

    const orderRequest = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD", // change to "ZAR" if needed
            value: total.toFixed(2),
          },
        },
      ],
    };

    const response = await client.execute({
      path: "/v2/checkout/orders",
      method: "POST",
      body: orderRequest,
    });

    // ✅ Save the completed order in MongoDB
try {
  const cart = req.session.cart || { items: [] };

  await Order.create({
    items: cart.items.map(item => ({
      id: item.productId,
      name: item.name,
      quantity: item.quantity,
      price: item.price,
    })),
    subtotal: cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0),
    tax: 0,
    shipping: 0,
    total: response.result.purchase_units[0].amount.value,
    status: "Completed",
    paypalOrderId: orderID,
    paymentDetails: response.result,
  });

  console.log("✅ Order saved to MongoDB");
} catch (saveErr) {
  console.error("❌ Failed to save order:", saveErr);
}


    res.json({ id: response.result.id });
  } catch (err) {
    console.error("PayPal Create Order Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ✅ Capture PayPal order
router.post("/capture-order", async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: "Missing orderID" });
    }

    const response = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: "POST",
    });

    // ✅ Clear cart after successful payment
    req.session.cart = { items: [] };

    res.json(response.result);
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
*/
