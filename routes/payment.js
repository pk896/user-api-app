// routes/payment.js
const express = require("express");
const router = express.Router();

const DeliveryOption = require("../models/DeliveryOption");
let Order = null;
try { Order = require("../models/Order"); } catch { /* optional */ }

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = "sandbox",
  BASE_CURRENCY = "USD",
  VAT_RATE = "0.15",
  BRAND_NAME = "Phakisi Global",
  SHIPPING_PREF = "NO_SHIPPING",
} = process.env;

const PP_API = PAYPAL_MODE === "live"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

const upperCcy = String(BASE_CURRENCY).toUpperCase();
const vatRate = Number(VAT_RATE || 0);

// ---------- helpers ----------
function resNonce(req){ return (req?.res?.locals?.nonce) || ""; }
function themeCssFrom(req){ return (req.session?.theme === "dark") ? "/css/dark.css" : "/css/light.css"; }

function computeTotalsFromSession(cart, delivery = 0) {
  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  let sub = 0;
  const ppItems = itemsArr.map((it, i) => {
    const price = Number(it.price || 0);
    const qty = Number(it.quantity || 1);
    const name = (it.name || `Item ${i + 1}`).toString().slice(0,127);
    sub += price * qty;
    return {
      name,
      quantity: String(qty),
      unit_amount: { currency_code: upperCcy, value: price.toFixed(2) },
    };
  });
  const vat = +(sub * vatRate).toFixed(2);
  const del = +Number(delivery || 0).toFixed(2);
  const grand = +(sub + vat + del).toFixed(2);
  return { items: ppItems, subTotal: +sub.toFixed(2), vatTotal: vat, delivery: del, grandTotal: grand };
}

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString("base64");
  const res = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

function saveSession(req){
  return new Promise((resolve) => {
    if (req.session && typeof req.session.save === "function") {
      req.session.save(() => resolve());
    } else resolve();
  });
}

// Normalize DB doc into client shape
function shapeOrderForClient(doc){
  const currency = doc.breakdown?.currency || upperCcy;
  const pu = (doc.purchase_units && doc.purchase_units[0]) || {};
  const capture = (pu.payments && pu.payments.captures && pu.payments.captures[0]) || {};
  const amountObj = capture.amount || { currency_code: currency, value: String(doc.breakdown?.grandTotal ?? 0) };

  return {
    id: doc.paypalOrderId || String(doc._id),
    status: doc.status || "COMPLETED",
    createdAt: doc.createdAt || new Date(),
    currency: amountObj.currency_code || currency,
    amount: { value: Number(amountObj.value || doc.breakdown?.grandTotal || 0) },
    items: Array.isArray(pu.items) ? pu.items.map(it => ({
      name: it.name,
      quantity: Number(it.quantity || 1),
      price: { currency_code: (it.unit_amount && it.unit_amount.currency_code) || currency, value: Number(it.unit_amount?.value || 0) }
    })) : [],
    breakdown: {
      itemTotal: doc.breakdown?.subTotal != null ? { value: Number(doc.breakdown.subTotal) } : null,
      taxTotal:  doc.breakdown?.vatTotal  != null ? { value: Number(doc.breakdown.vatTotal) }  : null,
      shipping:  doc.breakdown?.delivery  != null ? { value: Number(doc.breakdown.delivery) }  : null,
    },
    delivery: doc.delivery ? {
      name: doc.delivery.name || null,
      deliveryDays: doc.delivery.days ?? null,
      amount: (doc.delivery.price != null) ? Number(doc.delivery.price) : null
    } : null,
    shipping: doc.shipping || null,
  };
}

// Build a session snapshot (used when DB isn’t available yet)
function buildSessionSnapshot(orderId, pending){
  return {
    id: orderId,
    status: "COMPLETED",
    createdAt: new Date(),
    currency: pending?.currency || upperCcy,
    amount: { value: Number(pending?.grandTotal || 0) },
    items: [], // optional — PayPal/DB has full line items; we don’t need them here
    breakdown: {
      itemTotal: pending?.subTotal != null ? { value: Number(pending.subTotal) } : null,
      taxTotal:  pending?.vatTotal  != null ? { value: Number(pending.vatTotal) }  : null,
      shipping:  pending?.deliveryPrice != null ? { value: Number(pending.deliveryPrice) } : null,
    },
    delivery: (pending && (pending.deliveryName || pending.deliveryDays != null))
      ? { name: pending.deliveryName || null, deliveryDays: pending.deliveryDays ?? null, amount: pending.deliveryPrice != null ? Number(pending.deliveryPrice) : null }
      : null,
    shipping: null,
  };
}

// ---------- views ----------
router.get("/payment/checkout", (req, res) => {
  return res.render("checkout", {
    title: "Checkout",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    vatRate,
    success: req.flash?.("success"),
    error: req.flash?.("error"),
  });
});

// ✅ Render the "My Orders" page (HTML view)
router.get("/payment/orders", (req, res) => {
  return res.render("orders", {
    title: "My Orders",
    themeCss: (req.session?.theme === "dark") ? "/css/dark.css" : "/css/light.css",
    nonce: (res.locals && res.locals.nonce) || "",
    success: [],
    error: []
  });
});

// GET /payment/receipt/:id  -> renders views/receipt.ejs
router.get("/payment/receipt/:id", async (req, res) => {
  const id = String(req.params.id || "");
  let doc = null;

  // Try DB (if your Order model exists)
  try {
    const Order = require("../models/Order");
    doc = await Order.findOne({ paypalOrderId: id }).lean();
    if (!doc) {
      try { doc = await Order.findById(id).lean(); } catch { /* ignore invalid ObjectId */ }
    }
  } catch {
    // Order model optional
  }

  // Fallback to session snapshot (set during capture)
  if (!doc && req.session && req.session.lastOrderSnapshot && String(req.session.lastOrderSnapshot.id) === id) {
    const s = req.session.lastOrderSnapshot;
    doc = {
      paypalOrderId: s.id,
      status: s.status || "COMPLETED",
      createdAt: s.createdAt || new Date(),
      breakdown: {
        currency: s.currency || "USD",
        subTotal: (s.breakdown && s.breakdown.itemTotal && s.breakdown.itemTotal.value) || s.subTotal || 0,
        vatTotal:  (s.breakdown && s.breakdown.taxTotal  && s.breakdown.taxTotal.value)  || s.vatTotal  || 0,
        delivery:  (s.breakdown && s.breakdown.shipping  && s.breakdown.shipping.value)  || s.delivery  || s.deliveryPrice || 0,
        grandTotal: s.amount?.value ?? s.grandTotal ?? 0,
      },
      delivery: s.delivery ? {
        name: s.delivery.name || s.deliveryName || null,
        days: s.delivery.deliveryDays || s.deliveryDays || null,
        price: s.delivery.amount || s.deliveryPrice || null,
      } : null,
      // items are optional for the printable view; we compute totals separately
      purchase_units: [],
    };
  }

  if (!doc) {
    // You can flash + redirect if you prefer
    return res.status(404).send("Order not found");
  }

  // ---- Map to the shape your receipt.ejs expects ----
  // receipt.ejs expects: { id, status, createdAt, currency, items[], totals{subtotal,tax,shipping,total}, shipping? }
  const currency = (doc.breakdown && doc.breakdown.currency) || "USD";
  const totals = {
    subtotal: Number(doc.breakdown?.subTotal || 0),
    tax:      Number(doc.breakdown?.vatTotal  || 0),
    shipping: Number(doc.breakdown?.delivery  || 0),
  };
  totals.total = Number(
    doc.breakdown?.grandTotal ??
    (totals.subtotal + totals.tax + totals.shipping)
  );

  // Try to extract line items if present (optional)
  let items = [];
  const pu = Array.isArray(doc.purchase_units) ? doc.purchase_units[0] : null;
  if (pu && Array.isArray(pu.items)) {
    items = pu.items.map(it => ({
      name: it.name,
      quantity: Number(it.quantity || 1),
      price: { value: Number(it.unit_amount?.value || 0) }
    }));
  }

  const orderForView = {
    id: doc.paypalOrderId || String(doc._id),
    status: doc.status || "COMPLETED",
    createdAt: doc.createdAt || new Date(),
    currency,
    items,
    totals,
    // If you ever stored a shipping address, pass it here in this flat shape:
    shipping: doc.shipping || null
  };

  return res.render("receipt", {
    title: "Order Receipt",
    themeCss: (req.session?.theme === "dark") ? "/css/dark.css" : "/css/light.css",
    nonce: (res.locals && res.locals.nonce) || "",
    order: orderForView,
    success: [],
    error: []
  });
});

router.get("/payment/config", (_req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, currency: upperCcy, intent: "capture", mode: PAYPAL_MODE, baseCurrency: upperCcy });
});

// ---------- create order ----------
router.post("/payment/create-order", express.json(), async (req, res) => {
  try {
    const cart = req.session.cart || { items: [] };
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({ ok:false, code:"CART_EMPTY", message:"Cart is empty." });
    }

    // resolve delivery option
    const providedId = String(req.body?.deliveryOptionId || "").trim();
    let opt = null;
    if (providedId) {
      opt = await DeliveryOption.findOne({ _id: providedId, active: true }).lean();
      if (!opt) opt = await DeliveryOption.findOne({ active: true }).sort({ priceCents:1, deliveryDays:1, name:1 }).lean();
    } else {
      opt = await DeliveryOption.findOne({ active: true }).sort({ priceCents:1, deliveryDays:1, name:1 }).lean();
    }
    if (!opt) return res.status(404).json({ ok:false, code:"NO_ACTIVE_DELIVERY", message:"No active delivery options available." });

    const deliveryDollars = Number(((opt.priceCents || 0)/100).toFixed(2));
    const { items, subTotal, vatTotal, delivery, grandTotal } = computeTotalsFromSession(cart, deliveryDollars);

    const orderBody = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: `PK-${Date.now()}`,
        amount: {
          currency_code: upperCcy,
          value: grandTotal.toFixed(2),
          breakdown: {
            item_total: { currency_code: upperCcy, value: subTotal.toFixed(2) },
            tax_total:  { currency_code: upperCcy, value: vatTotal.toFixed(2) },
            shipping:   { currency_code: upperCcy, value: delivery.toFixed(2) },
          }
        },
        items,
        description: `Delivery: ${opt.name} (${opt.deliveryDays || 0} days)`,
      }],
      application_context: { brand_name: BRAND_NAME, user_action: "PAY_NOW", shipping_preference: SHIPPING_PREF }
    };

    const token = await getAccessToken();
    const ppRes = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify(orderBody)
    });
    const data = await ppRes.json();
    if (!ppRes.ok) {
      console.error("PayPal create error:", data);
      return res.status(ppRes.status).json({ ok:false, code:"PAYPAL_CREATE_FAILED", message:"PayPal create order failed", details:data });
    }

    // snapshot for later (thank-you fallback)
    req.session.pendingOrder = {
      id: data.id,
      deliveryOptionId: String(opt._id),
      deliveryName: opt.name,
      deliveryDays: opt.deliveryDays || 0,
      deliveryPrice: delivery,
      subTotal, vatTotal, grandTotal,
      currency: upperCcy,
      createdAt: Date.now(),
    };

    return res.json({ ok:true, id: data.id });
  } catch (err) {
    console.error("create-order error:", err);
    return res.status(500).json({ ok:false, code:"SERVER_ERROR", message:"Server error creating order" });
  }
});

// ---------- capture order ----------
router.post("/payment/capture-order", express.json(), async (req, res) => {
  try {
    const orderID = String(req.body?.orderID || "");
    if (!orderID) return res.status(400).json({ ok:false, code:"MISSING_ORDER_ID", message:"Missing orderID" });

    const token = await getAccessToken();
    const capRes = await fetch(`${PP_API}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" }
    });
    const capture = await capRes.json();

    if (!capRes.ok) {
      console.error("PayPal capture error:", capture);
      return res.status(capRes.status).json({ ok:false, code:"PAYPAL_CAPTURE_FAILED", message:"PayPal capture failed", details:capture });
    }

    const pending = req.session.pendingOrder || null;

    // Optional: persist to DB
    try {
      if (Order) {
        await Order.create({
          paypalOrderId: orderID,
          status: capture.status,
          payer: capture?.payer || null,
          purchase_units: capture?.purchase_units || [],
          amount: capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount || null,
          delivery: pending ? {
            optionId: pending.deliveryOptionId || null,
            name: pending.deliveryName || null,
            days: pending.deliveryDays || null,
            price: pending.deliveryPrice != null ? Number(pending.deliveryPrice) : null,
          } : null,
          breakdown: pending ? {
            currency: pending.currency || upperCcy,
            subTotal: pending.subTotal ?? null,
            vatTotal: pending.vatTotal ?? null,
            delivery: pending.deliveryPrice != null ? Number(pending.deliveryPrice) : null,
            grandTotal: pending.grandTotal ?? null,
          } : null,
          raw: capture,
          userId: req.session?.user?._id || null,
          createdAt: new Date(),
        });
      }
    } catch (e) { console.warn("⚠️ Failed to persist Order:", e.message); }

    // ✅ Build a session snapshot for /payment/order/:id fallback
    req.session.lastOrderSnapshot = buildSessionSnapshot(orderID, pending);

    // ✅ Clear cart + pending; ensure session saved
    req.session.cart = { items: [] };
    req.session.pendingOrder = null;
    await saveSession(req);

    return res.json({ ok:true, orderId: orderID, capture });
  } catch (err) {
    console.error("capture-order error:", err);
    return res.status(500).json({ ok:false, code:"SERVER_ERROR", message:"Server error capturing order" });
  }
});

// ---------- thank-you data: GET /payment/order/:id ----------
router.get("/payment/order/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");

    // 1) Try DB first (if model available)
    if (Order) {
      let doc = await Order.findOne({ paypalOrderId: id }).lean();
      if (!doc) {
        try { doc = await Order.findById(id).lean(); } catch { /* ignore */ }
      }
      if (doc) return res.json({ success:true, order: shapeOrderForClient(doc) });
    }

    // 2) Fall back to session snapshot set during capture
    const snap = req.session?.lastOrderSnapshot;
    if (snap && String(snap.id) === id) {
      return res.json({ success:true, order: snap });
    }

    // (Optional) 3) Could call PayPal Orders GET here if needed.
    return res.status(404).json({ success:false, message:"Order not found" });
  } catch (err) {
    console.error("order fetch error:", err);
    return res.status(500).json({ success:false, message:"Server error loading order" });
  }
});

// ---------- simple pages ----------
router.get("/payment/success", (req, res) => {
  return res.render("payment-success", {
    title: "Payment Successful",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ["Payment captured successfully."],
    error: [],
  });
});

router.get("/payment/cancel", (req, res) => {
  return res.render("payment-cancel", {
    title: "Payment Cancelled",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: [],
    error: ["Payment was cancelled or failed."],
  });
});

// JSON list for your Orders page
router.get("/payment/my-orders", async (req, res) => {
  try {
    if (!Order) return res.json({ ok:true, orders: [] });
    const q = {};
    if (req.session?.user?._id) q.userId = req.session.user._id;
    const list = await Order.find(q).sort({ createdAt: -1 }).limit(20).lean();
    const mapped = list.map(o => ({
      orderId: o.paypalOrderId || String(o._id),
      status: o.status || "",
      createdAt: o.createdAt || null,
      amount: Number(o.breakdown?.grandTotal || o.amount?.value || 0),
      currency: o.breakdown?.currency || upperCcy,
    }));
    return res.json({ ok:true, orders: mapped });
  } catch (err) {
    console.error("my-orders error:", err);
    return res.status(500).json({ ok:false, message:"Server error fetching orders" });
  }
});

module.exports = router;
