// routes/payment.js
const express = require("express");
const router = express.Router();
const Order = require("../models/Order"); // richer schema you added

/**
 * ENV REQUIRED
 *  - PAYPAL_CLIENT_ID
 *  - PAYPAL_CLIENT_SECRET
 *  - PAYPAL_MODE = "sandbox" | "live"   (defaults to sandbox)
 *
 * Optional:
 *  - BASE_CURRENCY      (defaults "USD")
 *  - VAT_RATE           (defaults 0.15)
 *  - SHIPPING_FLAT      (defaults 0)
 *  - BRAND_NAME         (defaults "Phakisi Global")
 *  - SHIPPING_PREF      (defaults "NO_SHIPPING") -> use "GET_FROM_FILE" for seller protection on physical goods
 *
 * Node 18+ recommended (global fetch). If Node <18, install node-fetch.
 */

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = "sandbox",
  BASE_CURRENCY = "USD",
  VAT_RATE: ENV_VAT_RATE,
  SHIPPING_FLAT: ENV_SHIPPING_FLAT,
  BRAND_NAME = "Phakisi Global",
  SHIPPING_PREF = "NO_SHIPPING", // "NO_SHIPPING" for digital; "GET_FROM_FILE" for physical
} = process.env;

if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
  console.warn("⚠️ Missing PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET in env");
}

const PP_API =
  PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

const toMoney = (n) => Number(n || 0).toFixed(2);
const upperCcy = String(BASE_CURRENCY).toUpperCase();

/** OAuth 2.0 client credentials → access token */
async function getAccessToken() {
  const creds = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const text = await r.text();
  let data = {};
  try { data = JSON.parse(text); } catch {}

  if (!r.ok || !data.access_token) {
    console.error("❌ PayPal token error:", r.status, text);
    throw new Error(data.error_description || "Failed to obtain PayPal access token");
  }
  return data.access_token;
}

// -----------------------------
// Expose config to the frontend
// -----------------------------
router.get("/config", (_req, res) => {
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    mode: PAYPAL_MODE,
    currency: upperCcy,
    baseCurrency: upperCcy,
  });
});

// -----------------------------
// GET /payment/orders  → "My Orders" page (lists orders and links to receipts)
// -----------------------------
router.get("/orders", (req, res) => {
  try {
    res.render("orders", {
      title: "My Orders",
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      // layout: 'layout' // uncomment if you use express-ejs-layouts with a layout file
    });
  } catch (err) {
    console.error("❌ /payment/orders render error:", err);
    res.status(500).send("Server error");
  }
});

// -----------------------------
// GET /payment/receipt/:orderId → render a printable receipt page (single order)
// -----------------------------
router.get("/receipt/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).send("Missing orderId");

    // Try DB first
    let doc = await Order.findOne({ orderId }).lean();

    // Optional fallback to PayPal if not found in DB
    if (!doc) {
      const token = await getAccessToken();
      const r = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return res.status(404).send("Order not found");
      const data = await r.json();
      const pu = data?.purchase_units?.[0] || {};
      const cap = pu?.payments?.captures?.[0] || {};
      const bkd = pu?.amount?.breakdown || {};
      const currency = cap?.amount?.currency_code || pu?.amount?.currency_code || (process.env.BASE_CURRENCY || "USD");

      doc = {
        orderId: data.id,
        status: data.status,
        createdAt: data.create_time ? new Date(data.create_time) : new Date(),
        amount: { value: String(cap?.amount?.value ?? pu?.amount?.value ?? "0.00"), currency },
        breakdown: {
          itemTotal: bkd?.item_total ? { value: bkd.item_total.value, currency } : undefined,
          taxTotal:  bkd?.tax_total  ? { value: bkd.tax_total.value,  currency } : undefined,
          shipping:  bkd?.shipping   ? { value: bkd.shipping.value,   currency } : undefined,
        },
        items: (pu.items || []).map(it => ({
          name: it.name,
          price: it.unit_amount ? { value: String(it.unit_amount.value), currency } : { value: "0.00", currency },
          quantity: Number(it.quantity || 1),
          imageUrl: it.image_url,
        })),
        shipping: pu?.shipping?.address ? {
          name: pu?.shipping?.name?.full_name,
          address_line_1: pu.shipping.address.address_line_1,
          admin_area_2: pu.shipping.address.admin_area_2,
          admin_area_1: pu.shipping.address.admin_area_1,
          postal_code:    pu.shipping.address.postal_code,
          country_code:   pu.shipping.address.country_code,
        } : undefined,
      };
    }

    // Normalize for the view
    const currency = doc.amount?.currency || (process.env.BASE_CURRENCY || "USD");
    const items = Array.isArray(doc.items) ? doc.items : [];
    const subtotal = doc.breakdown?.itemTotal?.value
      ? Number(doc.breakdown.itemTotal.value)
      : items.reduce((s, it) => s + Number((it.price?.value) || it.price || 0) * Number(it.quantity || 1), 0);
    const shipping = Number(doc.breakdown?.shipping?.value || 0);
    let tax = Number(doc.breakdown?.taxTotal?.value || 0);
    const total = Number(doc.amount?.value || 0);
    if (!tax && total) {
      const maybeVat = total - (subtotal + shipping);
      if (Number.isFinite(maybeVat) && maybeVat > 0) tax = maybeVat;
    }

    return res.render("receipt", {
      title: "Order receipt",
      order: {
        id: doc.orderId,
        status: doc.status,
        createdAt: doc.createdAt,
        currency,
        items,
        totals: { subtotal, tax, shipping, total },
        shipping: doc.shipping || null,
      },
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
      // layout: 'layout'
    });
  } catch (err) {
    console.error("❌ /payment/receipt error:", err);
    return res.status(500).send("Server error loading receipt");
  }
});


// -----------------------------
// GET /payment/order-receipt  → "My Orders" page (lists orders)
// -----------------------------
router.get("/order-receipt", (req, res) => {
  try {
    res.render("order-receipt", {
      title: "My Orders",
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ /payment/order-receipt render error:", err);
    res.status(500).send("Server error");
  }
});

// -----------------------------
// GET /payment/receipt/:orderId → render a printable receipt page
// -----------------------------
router.get("/receipt/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).send("Missing orderId");

    // Try DB first
    let doc = await Order.findOne({ orderId }).lean();

    // Optional fallback to PayPal if not found in DB
    if (!doc) {
      const token = await getAccessToken();
      const r = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return res.status(404).send("Order not found");
      const data = await r.json();
      const pu = data?.purchase_units?.[0] || {};
      const cap = pu?.payments?.captures?.[0] || {};
      const bkd = pu?.amount?.breakdown || {};
      const currency = cap?.amount?.currency_code || pu?.amount?.currency_code || (process.env.BASE_CURRENCY || "USD");

      doc = {
        orderId: data.id,
        status: data.status,
        createdAt: data.create_time ? new Date(data.create_time) : new Date(),
        amount: { value: String(cap?.amount?.value ?? pu?.amount?.value ?? "0.00"), currency },
        breakdown: {
          itemTotal: bkd?.item_total ? { value: bkd.item_total.value, currency } : undefined,
          taxTotal:  bkd?.tax_total  ? { value: bkd.tax_total.value,  currency } : undefined,
          shipping:  bkd?.shipping   ? { value: bkd.shipping.value,   currency } : undefined,
        },
        items: (pu.items || []).map(it => ({
          name: it.name,
          price: it.unit_amount ? { value: String(it.unit_amount.value), currency } : { value: "0.00", currency },
          quantity: Number(it.quantity || 1),
          imageUrl: it.image_url,
        })),
        shipping: pu?.shipping?.address ? {
          name: pu?.shipping?.name?.full_name,
          address_line_1: pu.shipping.address.address_line_1,
          admin_area_2: pu.shipping.address.admin_area_2,
          admin_area_1: pu.shipping.address.admin_area_1,
          postal_code:    pu.shipping.address.postal_code,
          country_code:   pu.shipping.address.country_code,
        } : undefined,
      };
    }

    // Normalize for the view
    const currency = doc.amount?.currency || (process.env.BASE_CURRENCY || "USD");
    const items = Array.isArray(doc.items) ? doc.items : [];
    const subtotal = doc.breakdown?.itemTotal?.value
      ? Number(doc.breakdown.itemTotal.value)
      : items.reduce((s, it) => s + Number((it.price?.value) || it.price || 0) * Number(it.quantity || 1), 0);
    const shipping = Number(doc.breakdown?.shipping?.value || 0);
    let tax = Number(doc.breakdown?.taxTotal?.value || 0);
    const total = Number(doc.amount?.value || 0);
    if (!tax && total) {
      const maybeVat = total - (subtotal + shipping);
      if (Number.isFinite(maybeVat) && maybeVat > 0) tax = maybeVat;
    }

    return res.render("order-receipt", {
      title: "Order receipt",
      order: {
        id: doc.orderId,
        status: doc.status,
        createdAt: doc.createdAt,
        currency,
        items,
        totals: { subtotal, tax, shipping, total },
        shipping: doc.shipping || null,
      },
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ /payment/receipt error:", err);
    return res.status(500).send("Server error loading receipt");
  }
});


// -----------------------------
// GET /payment/my-orders
// Returns recent orders for the current user or last guest payer
// -----------------------------
router.get("/my-orders", async (req, res) => {
  try {
    const email =
      (req.user && req.user.email) ||
      (req.session && req.session.lastPayerEmail) ||
      null;

    if (!email) {
      return res.json({ ok: true, orders: [], message: "No user email found." });
    }

    // Find latest orders for this payer email
    const orders = await Order.find(
      { "payer.email": email },
      {
        orderId: 1,
        status: 1,
        createdAt: 1,
        "amount.value": 1,
        "amount.currency": 1,
        "captures.0.id": 1,                  // first capture (if any)
        "payer.email": 1,
        "payer.name": 1,
        fee: 1,
        net: 1,
      }
    )
      .sort({ createdAt: -1 })
      .limit(25)
      .lean();

    // Shape into a compact list for the client page
    const shaped = (orders || []).map((o) => ({
      orderId: o.orderId,
      status: o.status,
      createdAt: o.createdAt,
      amount: o.amount?.value,
      currency: o.amount?.currency,
      captureId: o.captures?.[0]?.id || null,
      payerEmail: o.payer?.email || null,
      payerName:
        (o.payer?.name?.given ? `${o.payer.name.given} ` : "") +
        ( o.payer?.name?.surname || "" ).trim(),
      fee: o.fee || null,
      net: o.net || null,
    }));

    return res.json({ ok: true, orders: shaped });
  } catch (err) {
    console.error("❌ /payment/my-orders error:", err);
    return res.status(500).json({ ok: false, message: "Failed to load orders" });
  }
});

// GET /payment/order/:orderId  → JSON for a single order (DB first, then PayPal fallback)
router.get("/order/:orderId", async (req, res) => {
  res.type("application/json"); // ensure JSON, not HTML
  try {
    const orderId = req.params.orderId;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    // 1) Try DB
    let doc = await Order.findOne({ orderId }).lean();

    // 2) Fallback to PayPal if not found
    if (!doc) {
      const token = await getAccessToken();
      const pr = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!pr.ok) {
        // Still JSON on miss
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      const pdata = await pr.json().catch(() => ({}));
      const pu = pdata?.purchase_units?.[0] || {};
      const capList = pu?.payments?.captures || [];
      const firstCap = capList[0] || {};
      const bkd = pu?.amount?.breakdown || {};
      const currency =
        firstCap?.amount?.currency_code ||
        pu?.amount?.currency_code ||
        (process.env.BASE_CURRENCY || "USD");

      const items = (pu?.items || []).map((it) => ({
        name: it.name,
        price: it.unit_amount
          ? { value: String(it.unit_amount.value), currency: it.unit_amount.currency_code || currency }
          : { value: "0.00", currency },
        quantity: Number(it.quantity || 1),
      }));

      const out = {
        paypalOrderId: pdata.id,
        status: pdata.status,
        createdAt: pdata.create_time ? new Date(pdata.create_time) : undefined,
        amount: {
          value: String(firstCap?.amount?.value ?? pu?.amount?.value ?? "0.00"),
          currency,
        },
        breakdown: {
          itemTotal: bkd?.item_total
            ? { value: bkd.item_total.value, currency: bkd.item_total.currency_code || currency }
            : undefined,
          taxTotal: bkd?.tax_total
            ? { value: bkd.tax_total.value, currency: bkd.tax_total.currency_code || currency }
            : undefined,
          shipping: bkd?.shipping
            ? { value: bkd.shipping.value, currency: bkd.shipping.currency_code || currency }
            : undefined,
        },
        items,
        shipping: pu?.shipping?.address
          ? {
              name: pu?.shipping?.name?.full_name,
              address: {
                address_line_1: pu.shipping.address.address_line_1,
                admin_area_2: pu.shipping.address.admin_area_2,
                admin_area_1: pu.shipping.address.admin_area_1,
                postal_code: pu.shipping.address.postal_code,
                country_code: pu.shipping.address.country_code,
              },
            }
          : undefined,
        currency,
      };

      // Optional: upsert a minimal record for future reads
      try {
        await Order.updateOne(
          { orderId: pdata.id },
          {
            $setOnInsert: {
              orderId: pdata.id,
              status: pdata.status,
              amount: { value: out.amount.value, currency: out.amount.currency },
              breakdown: out.breakdown,
              items,
              createdAt: out.createdAt || new Date(),
              raw: pdata,
            },
          },
          { upsert: true }
        );
      } catch {}

      return res.json({ success: true, order: out });
    }

    // DB → normalize to the shape client expects
    const currency = doc.amount?.currency || process.env.BASE_CURRENCY || "USD";
    const outDB = {
      paypalOrderId: doc.orderId,
      status: doc.status,
      createdAt: doc.createdAt,
      amount: doc.amount,             // { value, currency }
      breakdown: doc.breakdown || {}, // { itemTotal, taxTotal, shipping }
      items: doc.items || [],         // [{ name, price:{value,currency}, quantity }]
      shipping: doc.shipping
        ? {
            name: doc.shipping.name || undefined,
            address: {
              address_line_1: doc.shipping.address_line_1,
              admin_area_2: doc.shipping.admin_area_2,
              admin_area_1: doc.shipping.admin_area_1,
              postal_code: doc.shipping.postal_code,
              country_code: doc.shipping.country_code,
            },
          }
        : undefined,
      currency,
    };

    return res.json({ success: true, order: outDB });
  } catch (err) {
    console.error("❌ /payment/order error:", err);
    return res.status(500).json({ success: false, message: "Server error fetching order" });
  }
});


// GET /payment/order/:orderId  → return a single order by PayPal order id
/*router.get("/order/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    // 1) Try Mongo first
    let doc = await Order.findOne({ orderId }).lean();

    // 2) Fallback to PayPal (race-safe if DB not written yet)
    if (!doc) {
      const token = await getAccessToken();
      const pr = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderId)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const pdata = await pr.json().catch(() => ({}));
      if (!pr.ok) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }

      // Map PayPal → our normalized shape (same as your DB mapping)
      const pu = pdata?.purchase_units?.[0] || {};
      const capList = pu?.payments?.captures || [];
      const firstCap = capList[0] || {};
      const payer = pdata?.payer || {};
      const shipping = pu?.shipping || {};
      const bkd = pu?.amount?.breakdown || {};
      const currency =
        firstCap?.amount?.currency_code ||
        pu?.amount?.currency_code ||
        (process.env.BASE_CURRENCY || "USD");

      const items =
        // If you store items in Mongo, great; otherwise try to reconstruct from PP PU items (if present)
        (pu?.items || []).map((it) => ({
          name: it.name,
          price: it.unit_amount
            ? { value: String(it.unit_amount.value), currency: it.unit_amount.currency_code || currency }
            : { value: "0.00", currency },
          quantity: Number(it.quantity || 1),
        }));

      // Normalize output identical to your thank-you page expectations
      const out = {
        paypalOrderId: pdata.id,
        status: pdata.status,
        createdAt: pdata.create_time ? new Date(pdata.create_time) : undefined,
        amount: {
          value: String(
            firstCap?.amount?.value ??
            pu?.amount?.value ??
            "0.00"
          ),
          currency
        },
        breakdown: {
          itemTotal: bkd?.item_total
            ? { value: bkd.item_total.value, currency: bkd.item_total.currency_code || currency }
            : undefined,
          taxTotal: bkd?.tax_total
            ? { value: bkd.tax_total.value, currency: bkd.tax_total.currency_code || currency }
            : undefined,
          shipping: bkd?.shipping
            ? { value: bkd.shipping.value, currency: bkd.shipping.currency_code || currency }
            : undefined,
        },
        items,
        shipping: shipping?.address
          ? {
              name: shipping?.name?.full_name,
              address: {
                address_line_1: shipping.address.address_line_1,
                admin_area_2: shipping.address.admin_area_2,
                admin_area_1: shipping.address.admin_area_1,
                postal_code: shipping.address.postal_code,
                country_code: shipping.address.country_code
              }
            }
          : undefined,
        currency
      };

      // Optional: upsert a minimal record so future reads hit Mongo
      try {
        await Order.updateOne(
          { orderId: pdata.id },
          {
            $setOnInsert: {
              orderId: pdata.id,
              status: pdata.status,
              amount: { value: out.amount.value, currency: out.amount.currency },
              breakdown: out.breakdown,
              items,
              createdAt: out.createdAt || new Date(),
              raw: pdata
            }
          },
          { upsert: true }
        );
      } catch {}

      return res.json({ success: true, order: out });
    }

    // 3) When found in Mongo: map to the same shape your thank-you page uses
    const currency = doc.amount?.currency || process.env.BASE_CURRENCY || "USD";
    const out = {
      paypalOrderId: doc.orderId,
      status: doc.status,
      createdAt: doc.createdAt,
      amount: doc.amount,                 // { value, currency }
      breakdown: doc.breakdown || {},     // { itemTotal, taxTotal, shipping }
      items: doc.items || [],             // [{ name, price:{value,currency}, quantity }]
      shipping: doc.shipping
        ? {
            name: doc.shipping.name || undefined,
            address: {
              address_line_1: doc.shipping.address_line_1,
              admin_area_2: doc.shipping.admin_area_2,
              admin_area_1: doc.shipping.admin_area_1,
              postal_code: doc.shipping.postal_code,
              country_code: doc.shipping.country_code
            }
          }
        : undefined,
      currency
    };

    return res.json({ success: true, order: out });
  } catch (err) {
    console.error("❌ /payment/order error:", err);
    return res.status(500).json({ success: false, message: "Server error fetching order" });
  }
});
*/

// GET /payment/order/:orderId  → return a single order by PayPal order id
/*router.get("/order/:orderId", async (req, res) => {
  try {
    const orderId = req.params.orderId;
    if (!orderId) return res.status(400).json({ success: false, message: "orderId is required" });

    const doc = await Order.findOne({ orderId }).lean();
    if (!doc) return res.status(404).json({ success: false, message: "Order not found" });

    // Map to a frontend-friendly shape
    const currency = doc.amount?.currency || (doc.captures?.[0]?.amount?.currency) || (process.env.BASE_CURRENCY || "USD");
    const out = {
      paypalOrderId: doc.orderId,
      status: doc.status,
      createdAt: doc.createdAt,
      amount: doc.amount,            // { value, currency }
      breakdown: doc.breakdown || {},// { itemTotal, taxTotal, shipping } if present
      items: doc.items || [],        // [{ name, price:{value,currency}, quantity }]
      // normalized shipping (if stored in your doc)
      shipping: doc.shipping
        ? {
            name: doc.shipping.name || undefined,
            address: {
              address_line_1: doc.shipping.address_line_1,
              admin_area_2: doc.shipping.admin_area_2,
              admin_area_1: doc.shipping.admin_area_1,
              postal_code: doc.shipping.postal_code,
              country_code: doc.shipping.country_code
            }
          }
        : undefined,
      currency
    };

    return res.json({ success: true, order: out });
  } catch (err) {
    console.error("❌ /payment/order error:", err);
    return res.status(500).json({ success: false, message: "Server error fetching order" });
  }
});*/

// -----------------------------
// Create order  (server-recomputed totals + items + breakdown)
// -----------------------------
router.post("/create-order", async (req, res) => {
  try {
    // Currency must match SDK currency
    const clientCurrency = String(req.body?.currency || BASE_CURRENCY).toUpperCase();
    if (clientCurrency !== upperCcy) {
      return res.status(400).json({ message: `Currency mismatch. Expected ${upperCcy}` });
    }

    // ✅ Recompute from session cart (don’t trust client totals)
    const cart = req.session.cart || { items: [] };
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({ message: "Cart is empty." });
    }

    const vatRate = Number(
      typeof ENV_VAT_RATE !== "undefined" ? ENV_VAT_RATE : 0.15
    );
    const shippingFlat = Number(
      typeof ENV_SHIPPING_FLAT !== "undefined" ? ENV_SHIPPING_FLAT : 0
    );

    // Map cart items → PayPal items
    const items = cart.items.map((i) => ({
      name: (i.name || "Item").slice(0, 127),
      quantity: String(Number(i.quantity || 1)),
      unit_amount: {
        currency_code: upperCcy,
        value: toMoney(i.price),
      },
      sku: i.customId || i.productId || undefined,
    }));

    const subtotal = cart.items.reduce(
      (s, i) => s + Number(i.price || 0) * Number(i.quantity || 1),
      0
    );
    const taxTotal = subtotal * vatRate;
    const finalTotal = subtotal + taxTotal + shippingFlat;

    // (Optional) Accept a custom reference from client
    const referenceId = (req.body?.referenceId || `PK-${Date.now()}`).toString();

    const body = {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: referenceId,
          amount: {
            currency_code: upperCcy,
            value: toMoney(finalTotal),
            breakdown: {
              item_total: { currency_code: upperCcy, value: toMoney(subtotal) },
              tax_total: { currency_code: upperCcy, value: toMoney(taxTotal) },
              shipping: { currency_code: upperCcy, value: toMoney(shippingFlat) },
            },
          },
          items,
        },
      ],
      application_context: {
        user_action: "PAY_NOW",
        shipping_preference: SHIPPING_PREF, // "NO_SHIPPING" vs "GET_FROM_FILE"
        brand_name: BRAND_NAME,
      },
    };

    const token = await getAccessToken();
    const r = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.id) {
      console.error("❌ PayPal create order failed:", r.status, data);
      return res
        .status(r.status)
        .json({ message: data?.message || "Create order failed", paypal: data });
    }

    // (Optional) store a shell here; we upsert on capture anyway
    return res.status(201).json({ id: data.id, status: data.status });
  } catch (err) {
    console.error("❌ /payment/create-order error:", err);
    return res.status(500).json({ message: "Server error creating order" });
  }
});

// ----------------------------- 
// Capture order  (persist → clear cart → respond)
// -----------------------------
router.post("/capture-order", async (req, res) => {
  try {
    const orderID = req.body?.orderID;
    if (!orderID) {
      return res.status(400).json({ success: false, message: "orderID is required" });
    }

    const token = await getAccessToken();
    const r = await fetch(
      `${PP_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("❌ PayPal capture failed:", r.status, data);
      return res
        .status(r.status)
        .json({ success: false, message: data?.message || "Capture failed", paypal: data });
    }

    // ----- Map PayPal → Order doc -----
    const pu = data?.purchase_units?.[0] || {};
    const capList = pu?.payments?.captures || [];
    const firstCap = capList[0] || {};
    const payer = data?.payer || {};
    const shipping = pu?.shipping || {};
    const bkd = pu?.amount?.breakdown || {};
    const currency =
      firstCap?.amount?.currency_code ||
      pu?.amount?.currency_code ||
      upperCcy;

    // Capture lines
    const captures = capList.map((c) => {
      const srb = c?.seller_receivable_breakdown || {};
      return {
        captureId: c?.id,
        status: c?.status,
        amount: c?.amount
          ? { value: String(c.amount.value), currency: c.amount.currency_code }
          : undefined,
        sellerReceivable: srb?.gross_amount
          ? {
              gross: {
                value: String(srb.gross_amount.value),
                currency: srb.gross_amount.currency_code,
              },
              paypalFee: srb.paypal_fee
                ? {
                    value: String(srb.paypal_fee.value),
                    currency: srb.paypal_fee.currency_code,
                  }
                : undefined,
              net: srb.net_amount
                ? {
                    value: String(srb.net_amount.value),
                    currency: srb.net_amount.currency_code,
                  }
                : undefined,
            }
          : undefined,
        createTime: c?.create_time ? new Date(c.create_time) : undefined,
        updateTime: c?.update_time ? new Date(c.update_time) : undefined,
        links: (c?.links || []).map((l) => ({
          rel: l.rel,
          href: l.href,
          method: l.method,
        })),
      };
    });

    // Sum captured
    const sumCaptured = captures.reduce((sum, c) => {
      const v = c?.amount?.value ? Number(c.amount.value) : 0;
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

    // Top-level fee/net shortcuts (from first capture)
    const srbTop = firstCap?.seller_receivable_breakdown || {};
    const feeTop = srbTop?.paypal_fee?.value;
    const netTop = srbTop?.net_amount?.value;

    const doc = {
      userId: req.user?._id || undefined,
      orderId: data.id,
      status: data.status,
      purchaseUnitRef: pu.reference_id,

      payer: {
        payerId: payer?.payer_id,
        email: payer?.email_address,
        name: { given: payer?.name?.given_name, surname: payer?.name?.surname },
        countryCode: payer?.address?.country_code,
      },

      shipping: shipping?.address
        ? {
            name: shipping?.name?.full_name,
            address_line_1: shipping.address.address_line_1,
            admin_area_2: shipping.address.admin_area_2,
            admin_area_1: shipping.address.admin_area_1,
            postal_code: shipping.address.postal_code,
            country_code: shipping.address.country_code,
          }
        : undefined,

      amount: {
        value: String(
          sumCaptured ? sumCaptured.toFixed(2) : firstCap?.amount?.value || pu?.amount?.value
        ),
        currency,
      },

      breakdown: {
        itemTotal: bkd?.item_total
          ? { value: bkd.item_total.value, currency: bkd.item_total.currency_code || currency }
          : undefined,
        taxTotal: bkd?.tax_total
          ? { value: bkd.tax_total.value, currency: bkd.tax_total.currency_code || currency }
          : undefined,
        shipping: bkd?.shipping
          ? { value: bkd.shipping.value, currency: bkd.shipping.currency_code || currency }
          : undefined,
      },

      // convenience copies
      fee: feeTop ? String(feeTop) : undefined,
      net: netTop ? String(netTop) : undefined,

      captures,

      // snapshot items from session (for your records)
      items: Array.isArray(req.session?.cart?.items)
        ? req.session.cart.items.map((i) => ({
            productId: i.productId,
            name: i.name,
            price: { value: toMoney(i.price), currency }, // unit price
            quantity: Number(i.quantity || 1),
            imageUrl: i.imageUrl,
          }))
        : [],

      raw: data,
    };

    // Upsert by orderId (idempotent)
    await Order.updateOne({ orderId: data.id }, { $set: doc }, { upsert: true });

    // ✅ Remember last order + payer for the thank-you page / my-orders
    if (req.session) {
      req.session.lastOrderId = data?.id || orderID;
      req.session.lastPayerEmail = payer?.email_address || null;
      // ✅ Clear cart and save session BEFORE responding
      req.session.cart = { items: [] };
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve()))
      );
    }

    // Optional: log a concise success line
    const cap = firstCap;
    console.log("✅ CAPTURE OK", {
      orderId: data?.id,
      captureId: cap?.id,
      status: cap?.status,
      amount: cap?.amount?.value,
      currency: cap?.amount?.currency_code,
      fee: feeTop,
      net: netTop,
    });

    // ⬅️ Return orderID so client can redirect to /payment/thank-you?orderID=...
    return res.json({ success: true, order: data, orderID: data?.id });
  } catch (err) {
    console.error("❌ /payment/capture-order error:", err);
    return res.status(500).json({ success: false, message: "Server error capturing order" });
  }
});


/*// -----------------------------
// Capture order  (persist → clear cart → respond)
// -----------------------------
router.post("/capture-order", async (req, res) => {
  try {
    const orderID = req.body?.orderID;
    if (!orderID) {
      return res.status(400).json({ success: false, message: "orderID is required" });
    }

    const token = await getAccessToken();
    const r = await fetch(
      `${PP_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      }
    );

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("❌ PayPal capture failed:", r.status, data);
      return res
        .status(r.status)
        .json({ success: false, message: data?.message || "Capture failed", paypal: data });
    }

    // ----- Map PayPal → Order doc -----
    const pu = data?.purchase_units?.[0] || {};
    const capList = pu?.payments?.captures || [];
    const firstCap = capList[0] || {};
    const payer = data?.payer || {};
    const shipping = pu?.shipping || {};
    const bkd = pu?.amount?.breakdown || {};
    const currency =
      firstCap?.amount?.currency_code ||
      pu?.amount?.currency_code ||
      upperCcy;

    // Capture lines
    const captures = capList.map((c) => {
      const srb = c?.seller_receivable_breakdown || {};
      return {
        captureId: c?.id,
        status: c?.status,
        amount: c?.amount
          ? { value: String(c.amount.value), currency: c.amount.currency_code }
          : undefined,
        sellerReceivable: srb?.gross_amount
          ? {
              gross: {
                value: String(srb.gross_amount.value),
                currency: srb.gross_amount.currency_code,
              },
              paypalFee: srb.paypal_fee
                ? {
                    value: String(srb.paypal_fee.value),
                    currency: srb.paypal_fee.currency_code,
                  }
                : undefined,
              net: srb.net_amount
                ? {
                    value: String(srb.net_amount.value),
                    currency: srb.net_amount.currency_code,
                  }
                : undefined,
            }
          : undefined,
        createTime: c?.create_time ? new Date(c.create_time) : undefined,
        updateTime: c?.update_time ? new Date(c.update_time) : undefined,
        links: (c?.links || []).map((l) => ({
          rel: l.rel,
          href: l.href,
          method: l.method,
        })),
      };
    });

    // Sum captured
    const sumCaptured = captures.reduce((sum, c) => {
      const v = c?.amount?.value ? Number(c.amount.value) : 0;
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);

    // Top-level fee/net shortcuts (from first capture)
    const srbTop = firstCap?.seller_receivable_breakdown || {};
    const feeTop = srbTop?.paypal_fee?.value;
    const netTop = srbTop?.net_amount?.value;

    const doc = {
      userId: req.user?._id || undefined,
      orderId: data.id,
      status: data.status,
      purchaseUnitRef: pu.reference_id,

      payer: {
        payerId: payer?.payer_id,
        email: payer?.email_address,
        name: { given: payer?.name?.given_name, surname: payer?.name?.surname },
        countryCode: payer?.address?.country_code,
      },

      shipping: shipping?.address
        ? {
            name: shipping?.name?.full_name,
            address_line_1: shipping.address.address_line_1,
            admin_area_2: shipping.address.admin_area_2,
            admin_area_1: shipping.address.admin_area_1,
            postal_code: shipping.address.postal_code,
            country_code: shipping.address.country_code,
          }
        : undefined,

      amount: {
        value: String(sumCaptured ? sumCaptured.toFixed(2) : firstCap?.amount?.value || pu?.amount?.value),
        currency,
      },

      breakdown: {
        itemTotal: bkd?.item_total
          ? { value: bkd.item_total.value, currency: bkd.item_total.currency_code || currency }
          : undefined,
        taxTotal: bkd?.tax_total
          ? { value: bkd.tax_total.value, currency: bkd.tax_total.currency_code || currency }
          : undefined,
        shipping: bkd?.shipping
          ? { value: bkd.shipping.value, currency: bkd.shipping.currency_code || currency }
          : undefined,
      },

      // convenience copies
      fee: feeTop ? String(feeTop) : undefined,
      net: netTop ? String(netTop) : undefined,

      captures,

      // snapshot items from session (for your records)
      items: Array.isArray(req.session?.cart?.items)
        ? req.session.cart.items.map((i) => ({
            productId: i.productId,
            name: i.name,
            price: { value: toMoney(i.price), currency }, // unit price
            quantity: Number(i.quantity || 1),
            imageUrl: i.imageUrl,
          }))
        : [],

      raw: data,
    };

    // Upsert by orderId (idempotent)
    await Order.updateOne({ orderId: data.id }, { $set: doc }, { upsert: true });

    // ✅ Clear cart and save session BEFORE responding
    if (req.session) {
      req.session.cart = { items: [] };
      await new Promise((resolve, reject) =>
        req.session.save((err) => (err ? reject(err) : resolve()))
      );
    }

    // Optional: log a concise success line
    const cap = firstCap;
    console.log("✅ CAPTURE OK", {
      orderId: data?.id,
      captureId: cap?.id,
      status: cap?.status,
      amount: cap?.amount?.value,
      currency: cap?.amount?.currency_code,
      fee: feeTop,
      net: netTop,
    });

    return res.json({ success: true, order: data });
  } catch (err) {
    console.error("❌ /payment/capture-order error:", err);
    return res.status(500).json({ success: false, message: "Server error capturing order" });
  }
});*/

// -----------------------------
// (Optional) Refund capture
// POST /payment/refund
// body: { captureId: string, amount?: string, currency?: string }
// If amount omitted → full refund
// -----------------------------
router.post("/refund", express.json(), async (req, res) => {
  try {
    const captureId = req.body?.captureId;
    if (!captureId) {
      return res.status(400).json({ success: false, message: "captureId is required" });
    }

    const token = await getAccessToken();

    let body = undefined;
    if (req.body?.amount) {
      // partial refund
      const currency = String(req.body?.currency || upperCcy).toUpperCase();
      body = { amount: { value: toMoney(req.body.amount), currency_code: currency } };
    }

    const r = await fetch(`${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error("❌ PayPal refund failed:", r.status, data);
      return res
        .status(r.status)
        .json({ success: false, message: data?.message || "Refund failed", paypal: data });
    }

    // Update our Order doc
    const refundId = data?.id;
    const amt = data?.amount?.value;
    const cur = data?.amount?.currency_code || upperCcy;
    const status = data?.status;

    const order = await Order.findOne({ "captures.captureId": captureId });
    if (order) {
      // push refund line
      await Order.updateOne(
        { _id: order._id },
        {
          $push: {
            refunds: {
              refundId,
              status,
              amount: amt ? String(amt) : undefined,
              currency: cur,
              createdAt: new Date(),
            },
          },
          $set: {
            refundedTotal: toMoney(
              Number(order.refundedTotal || 0) + Number(amt || 0)
            ),
          },
        }
      );
    }

    return res.json({ success: true, refund: data });
  } catch (err) {
    console.error("❌ /payment/refund error:", err);
    return res.status(500).json({ success: false, message: "Server error issuing refund" });
  }
});

module.exports = router;
