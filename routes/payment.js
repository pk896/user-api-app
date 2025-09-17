// routes/payment.js
const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");

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















// routes/payment.js
/*const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");

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

// ✅ Create PayPal order
router.post("/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const orderRequest = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD", // change to "ZAR" if needed
            value: amount || "10.00",
          },
        },
      ],
    };

    const response = await client.execute({
      path: "/v2/checkout/orders",
      method: "POST",
      body: orderRequest,
    });

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

    const response = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: "POST",
    });

    res.json(response.result);
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;*/



















// routes/payment.js
/*const express = require("express");
const router = express.Router();
const { Client, Environment, LogLevel } = require("@paypal/paypal-server-sdk");

// ✅ Initialize PayPal client
const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: Environment.Sandbox, // Use Environment.Live in production
  logging: { logLevel: LogLevel.Info },
});

// ✅ Expose PayPal client ID to frontend (safe)
router.get("/config", (req, res) => {
  res.json({ clientId: process.env.PAYPAL_CLIENT_ID });
});

// ✅ Create order
router.post("/create-order", async (req, res) => {
  try {
    const { amount, items } = req.body; // frontend can send amount & cart items

    const orderRequest = {
      intent: "CAPTURE",
      purchase_units: [
        {
          amount: {
            currency_code: "USD",
            value: amount || "10.00",
          },
          items: items || [],
        },
      ],
    };

    const response = await client.execute({
      path: "/v2/checkout/orders",
      method: "POST",
      body: orderRequest,
    });

    res.json({ id: response.result.id });
  } catch (err) {
    console.error("PayPal Create Order Error:", err);
    res.status(500).send("Error creating PayPal order");
  }
});

// ✅ Capture order
router.post("/capture-order/:orderID", async (req, res) => {
  try {
    const { orderID } = req.params;

    const response = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: "POST",
    });

    res.json(response.result);
  } catch (err) {
    console.error("PayPal Capture Error:", err);
    res.status(500).send("Error capturing PayPal order");
  }
});

module.exports = router;*/










// routes/payment.js
/*const express = require('express');
const { Client, Environment, LogLevel } = require('@paypal/paypal-server-sdk');

const router = express.Router();

// ✅ Initialize PayPal client
const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: Environment.Sandbox, // switch to Environment.Live in production
  logging: { logLevel: LogLevel.Info },
});

// ✅ Create order
router.post('/create-order', async (req, res) => {
  try {
    const orderRequest = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: 'USD',
            value: req.body.amount || '10.00',
          },
        },
      ],
    };

    const response = await client.execute({
      path: '/v2/checkout/orders',
      method: 'POST',
      body: orderRequest,
    });

    res.json({ id: response.result.id });
  } catch (err) {
    console.error('PayPal Create Order Error:', err);
    res.status(500).send('Error creating PayPal order');
  }
});

// ✅ Capture order
router.post('/capture-order', async (req, res) => {
  try {
    const { orderID } = req.body;

    const response = await client.execute({
      path: `/v2/checkout/orders/${orderID}/capture`,
      method: 'POST',
    });

    res.json(response.result);
  } catch (err) {
    console.error('PayPal Capture Error:', err);
    res.status(500).send('Error capturing PayPal order');
  }
});

module.exports = router;
*/





































// routes/payment.js
/*const express = require("express");
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
*/
