// routes/payment.js
const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");
const Product = require("../models/Product");
const Order = require("../models/Order");

// ✅ Initialize PayPal client (Sandbox)
const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: Environment.Sandbox, // change to Environment.Live in production
  logging: { logLevel: LogLevel.Info },
});

const CURRENCY = process.env.CURRENCY || "USD";

/* ----------------------------------------------------------
 * AuthZ: require logged-in business with buyer role
 * -------------------------------------------------------- */
function requireBuyer(req, res, next) {
  const b = req.session?.business;
  if (!b || !b._id) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  if (b.role !== "buyer") {
    return res.status(403).json({ error: "Only buyers can perform this action." });
  }
  next();
}

/* ----------------------------------------------------------
 * GET /payment/config  → expose client id to frontend
 * -------------------------------------------------------- */
router.get("/config", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
});

/* ----------------------------------------------------------
 * POST /payment/create-order
 * - Validates cart
 * - Re-prices items from DB (never trust client/session price)
 * - Creates PayPal order
 * - Persists a Pending Order tied to the buyer (businessBuyer)
 * -------------------------------------------------------- */
router.post("/create-order", requireBuyer, async (req, res) => {
  try {
    const cart = req.session.cart || { items: [] };
    if (!cart.items.length) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    // 1) Get product ids & fetch fresh prices from DB
    const ids = [...new Set(cart.items.map(i => i.productId))];
    const products = await Product.find({ _id: { $in: ids } })
      .select("_id name price")
      .lean();

    // Build items with authoritative price/name
    const items = cart.items.map(ci => {
      const p = products.find(x => String(x._id) === String(ci.productId));
      if (!p) return null;
      return {
        id: String(p._id),
        name: p.name,
        quantity: Number(ci.quantity) || 1,
        price: Number(p.price) || 0,
      };
    }).filter(Boolean);

    if (!items.length) {
      return res.status(400).json({ error: "No valid items in cart." });
    }

    // 2) Totals (customize tax/shipping if needed)
    const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
    const tax = 0;
    const shipping = 0;
    const total = subtotal + tax + shipping;

    if (total <= 0) {
      return res.status(400).json({ error: "Calculated total is invalid." });
    }

    // 3) Create PayPal order
    const orderRequest = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: CURRENCY,
            value: total.toFixed(2),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: subtotal.toFixed(2) },
              shipping: { currency_code: CURRENCY, value: shipping.toFixed(2) },
              tax_total: { currency_code: CURRENCY, value: tax.toFixed(2) },
            },
          },
        },
      ],
    };

    const ppRes = await client.execute({
      path: "/v2/checkout/orders",
      method: "POST",
      body: orderRequest,
    });

    const paypalOrderId = ppRes.result.id;

    // 4) Persist a Pending order tied to this buyer
    await Order.create({
      businessBuyer: req.session.business._id,   // <-- 🔒 key to buyer scoping
      items,
      subtotal,
      tax,
      shipping,
      total,
      status: "Pending",
      paypalOrderId,
    });

    // 5) Return paypal order id to client
    res.json({ id: paypalOrderId });
  } catch (err) {
    console.error("PayPal Create Order Error:", err);
    res.status(500).json({ error: "Failed to create order." });
  }
});

/* ----------------------------------------------------------
 * POST /payment/capture-order
 * - Captures PayPal order
 * - Updates the persisted order (scoped to this buyer)
 * - Clears the cart
 * -------------------------------------------------------- */
router.post("/capture-order", requireBuyer, async (req, res) => {
  try {
    const { orderID } = req.body;
    if (!orderID) {
      return res.status(400).json({ error: "Missing orderID." });
    }

    const capture = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: "POST",
    });

    // Update order document for this buyer only
    const updated = await Order.findOneAndUpdate(
      { paypalOrderId: orderID, businessBuyer: req.session.business._id },
      { status: "Completed", paymentDetails: capture.result },
      { new: true }
    );

    // If no pending order found (edge case), create one so history stays consistent
    if (!updated) {
      await Order.create({
        businessBuyer: req.session.business._id,
        items: [],
        subtotal: 0,
        tax: 0,
        shipping: 0,
        total: Number(
          capture?.result?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 0
        ),
        status: "Completed",
        paypalOrderId: orderID,
        paymentDetails: capture.result,
      });
    }

    // Clear cart after success
    req.session.cart = { items: [] };

    res.json(capture.result);
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    res.status(500).json({ error: "Failed to capture order." });
  }
});

/* ----------------------------------------------------------
 * GET /payment/my-orders
 * - Convenience endpoint for buyer dashboard
 * - Returns only THIS buyer's orders
 * -------------------------------------------------------- */
router.get("/my-orders", requireBuyer, async (req, res) => {
  try {
    const orders = await Order.find({ businessBuyer: req.session.business._id })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ success: true, orders });
  } catch (err) {
    console.error("Fetch My Orders Error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch orders." });
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
