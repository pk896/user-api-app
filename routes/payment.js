/**
 * routes/payment.js
 * PayPal REST integration (no deprecated @paypal/checkout-server-sdk).
 * Requires Node 18+ for global fetch (or add a fetch polyfill).
 */
const express = require("express");
const router = express.Router();

// ---- Env & Defaults ---------------------------------------------------------
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";
const PAYPAL_BASE_URL =
  process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com";
const CURRENCY = (process.env.CURRENCY || "USD").toUpperCase();

const isSandbox = /sandbox/i.test(String(PAYPAL_BASE_URL));
const ENV_NAME = isSandbox ? "sandbox" : "live";

// ---- Utilities --------------------------------------------------------------
const s = (v) => (v ?? "").toString().trim();

async function getAccessToken() {
  if (!s(PAYPAL_CLIENT_ID) || !s(PAYPAL_CLIENT_SECRET)) {
    throw new Error("Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in env");
  }
  const basic = Buffer.from(
    `${s(PAYPAL_CLIENT_ID)}:${s(PAYPAL_CLIENT_SECRET)}`
  ).toString("base64");

  const res = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OAuth failed: ${res.status} ${res.statusText} ${t}`.trim());
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("OAuth response missing access_token");
  return data.access_token;
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function paypalApi(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${PAYPAL_BASE_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const txt = await res.text().catch(() => "");
  const json = txt ? safeJson(txt) : null;
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} failed: ${res.status}`);
    err.details = json || txt;
    throw err;
  }
  return json;
}

function buildAmountFromBody(body = {}) {
  if (body.total != null) {
    const value = Number(body.total);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Invalid total");
    return { currency_code: CURRENCY, value: value.toFixed(2) };
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length) {
    let sum = 0;
    for (const it of items) {
      const qty = Number(it.quantity ?? 1);
      const price =
        it.unit_amount?.value != null ? Number(it.unit_amount.value) : Number(it.price ?? 0);
      if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0 || price < 0) {
        throw new Error("Invalid item row");
      }
      sum += qty * price;
    }
    return { currency_code: CURRENCY, value: sum.toFixed(2) };
  }
  return { currency_code: CURRENCY, value: "1.00" }; // safe default for testing
}

// ---- Routes (relative to /payment mount) ------------------------------------

router.get("/client-id", (req, res) => {
  try {
    res.json({ clientId: s(PAYPAL_CLIENT_ID), currency: CURRENCY, env: ENV_NAME });
  } catch (err) {
    console.error("client-id error:", err);
    res.status(500).json({ message: "Failed to read PayPal client id." });
  }
});

router.post("/create-order", async (req, res) => {
  try {
    const amount = buildAmountFromBody(req.body);

    const purchaseUnit = { amount };
    if (Array.isArray(req.body?.items) && req.body.items.length) {
      purchaseUnit.items = req.body.items.map((it) => ({
        name: s(it.name) || "Item",
        quantity: s(it.quantity || 1),
        unit_amount: {
          currency_code: CURRENCY,
          value: (it.unit_amount?.value ?? it.price ?? 0).toString(),
        },
      }));
    }

    const payload = {
      intent: "CAPTURE",
      purchase_units: [purchaseUnit],
      application_context: {
        shipping_preference: "NO_SHIPPING",
        user_action: "PAY_NOW",
        brand_name: s(process.env.BRAND_NAME) || "My Store",
        landing_page: "NO_PREFERENCE",
      },
    };

    const order = await paypalApi("/v2/checkout/orders", { method: "POST", body: payload });
    if (!order?.id) throw new Error("Create order response missing id");
    res.json({ id: order.id });
  } catch (err) {
    console.error("Create Order Error:", err?.message, err?.details || "");
    res.status(500).json({ message: "Failed to create order." });
  }
});

router.post("/capture-order", async (req, res) => {
  try {
    const orderID = s(req.body?.orderID);
    if (!orderID) return res.status(400).json({ message: "orderID is required" });

    const capture = await paypalApi(`/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      body: {}, // must be {}
    });
    res.json(capture);
  } catch (err) {
    console.error("Capture Error:", err?.message, err?.details || "");
    res.status(500).json({ message: "Failed to capture order." });
  }
});

module.exports = router;

