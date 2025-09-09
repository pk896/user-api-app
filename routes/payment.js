// routes/payment.js
const express = require("express");
const router = express.Router();
const paypal = require("@paypal/paypal-server-sdk");

// Create PayPal client
const client = new paypal.Client({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  environment: "sandbox", // or "live" in production
});

// ✅ Expose PayPal client ID to frontend (safe)
router.get("/config", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
});

// Create order
router.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;
    const order = await client.orders.create({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "ZAR", // ✅ South African Rand
            value: amount || "10.00",
          },
        },
      ],
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Capture order
router.post("/capture-order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  try {
    const capture = await client.orders.capture(orderId);
    res.json(capture);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;















// routes/payment.js
/*const express = require("express");
const router = express.Router();
const paypal = require("@paypal/paypal-server-sdk");

// Create PayPal client
const client = new paypal.Client({
  clientId: process.env.PAYPAL_CLIENT_ID,
  clientSecret: process.env.PAYPAL_CLIENT_SECRET,
  environment: "sandbox", // or "live" for production
});

// Create order
router.post("/create-order", async (req, res) => {
  try {
    const order = await client.orders.create({
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: "10.00",
          },
        },
      ],
    });
    res.json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Capture order
router.post("/capture-order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  try {
    const capture = await client.orders.capture(orderId);
    res.json(capture);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
*/