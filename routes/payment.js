const express = require('express');
const router = express.Router();
const paypal = require('@paypal/checkout-server-sdk');

// PayPal environment (Sandbox for testing)
const Environment = paypal.core.SandboxEnvironment;
const paypalClient = new paypal.core.PayPalHttpClient(
  new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// Create an order
router.post('/create-order', async (req, res) => {
  const request = new paypal.orders.OrdersCreateRequest();
  request.prefer("return=representation");
  request.requestBody({
    intent: "CAPTURE",
    purchase_units: [
      {
        amount: {
          currency_code: "USD", // or "ZAR"
          value: "10.00" // Example: $10
        }
      }
    ]
  });

  try {
    const order = await paypalClient.execute(request);
    res.json({ id: order.result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Capture payment
router.post('/capture-order/:orderID', async (req, res) => {
  const orderID = req.params.orderID;
  const request = new paypal.orders.OrdersCaptureRequest(orderID);
  request.requestBody({});

  try {
    const capture = await paypalClient.execute(request);
    res.json(capture.result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;