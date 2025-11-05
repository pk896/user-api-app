// routes/payment.js
const express = require("express");
const router = express.Router();

const DeliveryOption = require("../models/DeliveryOption");
let Order = null;
try { Order = require("../models/Order"); } catch { /* optional model */ }

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

const upperCcy = String(BASE_CURRENCY || "USD").toUpperCase();
const vatRate = Number(VAT_RATE || 0);

// ---------- helpers ----------
function resNonce(req){ return (req?.res?.locals?.nonce) || ""; }
function themeCssFrom(req){ return (req.session?.theme === "dark") ? "/css/dark.css" : "/css/light.css"; }

async function cheapestDelivery() {
  const opt = await DeliveryOption.findOne({ active: true })
    .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
    .lean();
  if (!opt) return { opt: null, dollars: 0 };
  const dollars = Number(((opt.priceCents || 0) / 100).toFixed(2));
  return { opt, dollars };
}

function computeTotalsFromSession(cart, delivery = 0) {
  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  let sub = 0;
  const ppItems = itemsArr.map((it, i) => {
    const price = Number(it.price || 0);
    const qty = Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1));
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

// Normalize DB doc into client shape (prefer persisted doc.items)
function shapeOrderForClient(doc){
  const currency = doc.breakdown?.currency || upperCcy;
  const pu = (doc.purchase_units && doc.purchase_units[0]) || {};
  const capture = (pu.payments && pu.payments.captures && pu.payments.captures[0]) || {};
  const amountObj = capture.amount || { currency_code: currency, value: String(doc.breakdown?.grandTotal ?? 0) };

  // Prefer items we persisted on capture
  const items = Array.isArray(doc.items) && doc.items.length
    ? doc.items.map(it => ({
        name: it.name,
        quantity: Number(it.quantity || 1),
        price: { value: Number((it.price && it.price.value != null) ? it.price.value : it.price || 0) }
      }))
    : (Array.isArray(pu.items)
        ? pu.items.map(it => ({
            name: it.name,
            quantity: Number(it.quantity || 1),
            price: {
              currency_code: (it.unit_amount && it.unit_amount.currency_code) || currency,
              value: Number(it.unit_amount?.value || 0)
            }
          }))
        : []);

  return {
    id: doc.paypalOrderId || String(doc._id),
    status: doc.status || "COMPLETED",
    createdAt: doc.createdAt || new Date(),
    currency: amountObj.currency_code || currency,
    amount: { value: Number(amountObj.value || doc.breakdown?.grandTotal || 0) },
    items,
    breakdown: {
      itemTotal: doc.breakdown?.subTotal != null ? { value: Number(doc.breakdown.subTotal) } : null,
      taxTotal:  doc.breakdown?.vatTotal  != null ? { value: Number(doc.breakdown.vatTotal) }  : null,
      shipping:  doc.breakdown?.delivery  != null ? { value: Number(doc.breakdown.delivery) }  : null,
    },
    delivery: doc.delivery ? {
      name: doc.delivery.name || null,
      deliveryDays: (doc.delivery.days != null) ? doc.delivery.days : (doc.delivery.deliveryDays != null ? doc.delivery.deliveryDays : null),
      amount: (doc.delivery.price != null) ? Number(doc.delivery.price) :
              (doc.delivery.amount != null ? Number(doc.delivery.amount) : null)
    } : null,
    shipping: doc.shipping || null,
  };
}

// Build a session snapshot (used when DB isn’t available yet) — now includes items
function buildSessionSnapshot(orderId, pending){
  const items = Array.isArray(pending?.itemsBrief)
    ? pending.itemsBrief.map(it => ({
        name: it.name,
        quantity: Number(it.quantity || 1),
        price: { value: Number(it.unitPrice || 0) }
      }))
    : [];

  return {
    id: orderId,
    status: "COMPLETED",
    createdAt: new Date(),
    currency: pending?.currency || upperCcy,
    amount: { value: Number(pending?.grandTotal || 0) },
    items,
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
router.get("/checkout", async (req, res) => {
  let shippingFlat = 0;
  try {
    const { dollars } = await cheapestDelivery();
    shippingFlat = dollars;
  } catch { /* ignore */ }

  return res.render("checkout", {
    title: "Checkout",
    themeCss: themeCssFrom(req),
    NONCE: resNonce(req),
    paypalClientId: PAYPAL_CLIENT_ID,
    currency: upperCcy,
    brandName: BRAND_NAME,
    vatRate,
    shippingFlat,
    success: req.flash?.("success") || [],
    error: req.flash?.("error") || [],
  });
});

// Optional orders list view
router.get("/orders", (req, res) => {
  return res.render("orders", {
    title: "My Orders",
    themeCss: themeCssFrom(req),
    NONCE: resNonce(req),
    success: [],
    error: []
  });
});

// Printable receipt view (robust items + delivery snapshot)
router.get("/receipt/:id", async (req, res) => {
  const id = String(req.params.id || "");
  let doc = null;

  try {
    const OrderModel = require("../models/Order");
    doc = await OrderModel.findOne({ paypalOrderId: id }).lean();
    if (!doc && /^[0-9a-fA-F]{24}$/.test(id)) {
      doc = await OrderModel.findById(id).lean();
    }
  } catch { /* optional Order model */ }

  const mapItems = (arr) => (Array.isArray(arr) ? arr.map(it => ({
    name: it.name,
    quantity: Number(it.quantity || 1),
    price: { value: Number(
      (it.price && it.price.value != null) ? it.price.value :
      (it.unitPrice != null) ? it.unitPrice :
      (it.unit_amount && it.unit_amount.value != null) ? it.unit_amount.value :
      (it.price != null) ? it.price : 0
    )},
    imageUrl: it.imageUrl || ''
  })) : []);

  // If no DB doc, try session last snapshot
  if (!doc && req.session?.lastOrderSnapshot && String(req.session.lastOrderSnapshot.id) === id) {
    const s = req.session.lastOrderSnapshot;
    const currency = s.currency || upperCcy;
    const itemsFromSnap = mapItems(s.items || s.itemsBrief);

    const totals = {
      subtotal: Number((s.breakdown && s.breakdown.itemTotal && s.breakdown.itemTotal.value) || s.subTotal || 0),
      tax:      Number((s.breakdown && s.breakdown.taxTotal  && s.breakdown.taxTotal.value)  || s.vatTotal  || 0),
      shipping: Number((s.breakdown && s.breakdown.shipping  && s.breakdown.shipping.value)  || s.delivery  || s.deliveryPrice || 0),
    };
    totals.total = Number((s.amount && s.amount.value != null) ? s.amount.value : (totals.subtotal + totals.tax + totals.shipping));

    return res.render("receipt", {
      title: "Order Receipt",
      themeCss: themeCssFrom(req),
      nonce: resNonce(req),
      order: {
        id: s.id,
        status: s.status || "COMPLETED",
        createdAt: s.createdAt || new Date(),
        currency,
        items: itemsFromSnap,
        totals,
        delivery: s.delivery ? {
          name: s.delivery.name || s.deliveryName || null,
          deliveryDays: s.delivery.deliveryDays ?? s.deliveryDays ?? null,
          amount: (s.delivery.amount != null) ? Number(s.delivery.amount) :
                  (s.deliveryPrice != null ? Number(s.deliveryPrice) : null)
        } : null,
        shipping: s.shipping || null
      },
      success: [],
      error: []
    });
  }

  if (!doc) return res.status(404).send("Order not found");

  // Build items with multiple fallbacks
  let items = [];

  // Prefer DB items (from capture save)
  if (Array.isArray(doc.items) && doc.items.length) {
    items = mapItems(doc.items);
  }

  // Then session last snapshot
  if (!items.length && req.session?.lastOrderSnapshot && String(req.session.lastOrderSnapshot.id) === (doc.paypalOrderId || String(doc._id))) {
    const s = req.session.lastOrderSnapshot;
    items = mapItems(s.items || s.itemsBrief);
  }

  // Then PayPal GET /orders/:id
  if (!items.length) {
    try {
      const token = await getAccessToken();
      const r = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (r.ok) {
        const orderJson = await r.json();
        const pu = Array.isArray(orderJson.purchase_units) ? orderJson.purchase_units[0] : null;
        if (pu && Array.isArray(pu.items) && pu.items.length) {
          items = mapItems(pu.items);
        }
      }
    } catch { /* ignore */ }
  }

  // Last resort: DB raw purchase_units[].items
  if (!items.length && Array.isArray(doc.purchase_units?.[0]?.items)) {
    items = mapItems(doc.purchase_units[0].items);
  }

  const currency = doc.breakdown?.currency || upperCcy;

  const totals = {
    subtotal: Number(doc.breakdown?.subTotal || 0),
    tax:      Number(doc.breakdown?.vatTotal  || 0),
    shipping: Number(
      (doc.breakdown && doc.breakdown.delivery != null ? doc.breakdown.delivery : 0) ?? 0
    )
  };
  totals.total = Number(
    (doc.breakdown && doc.breakdown.grandTotal != null)
      ? doc.breakdown.grandTotal
      : (totals.subtotal + totals.tax + totals.shipping)
  );

  const deliveryForView = doc.delivery ? {
    name: doc.delivery.name || null,
    deliveryDays: (doc.delivery.days != null) ? doc.delivery.days : (doc.delivery.deliveryDays != null ? doc.delivery.deliveryDays : null),
    amount: (doc.delivery.price != null) ? Number(doc.delivery.price) :
            (doc.delivery.amount != null ? Number(doc.delivery.amount) : null)
  } : null;

  const orderForView = {
    id: doc.paypalOrderId || String(doc._id),
    status: doc.status || "COMPLETED",
    createdAt: doc.createdAt || new Date(),
    currency,
    items,
    totals,
    delivery: deliveryForView,
    shipping: doc.shipping || null
  };

  return res.render("receipt", {
    title: "Order Receipt",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req), // NOTE: lowercase 'nonce' to match your EJS
    order: orderForView,
    success: [],
    error: []
  });
});

// Frontend config (optional)
router.get("/config", (_req, res) => {
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    currency: upperCcy,
    intent: "capture",
    mode: PAYPAL_MODE,
    baseCurrency: upperCcy,
    brandName: BRAND_NAME,
  });
});

// ---------- create order ----------
router.post("/create-order", express.json(), async (req, res) => {
  try {
    const cart = req.session.cart || { items: [] };
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({ ok:false, code:"CART_EMPTY", message:"Cart is empty (server session)." });
    }

    // Compact items list from the cart for later display/persist
    const itemsBrief = (Array.isArray(cart.items) ? cart.items : []).map((it, i) => ({
      name: (it.name || `Item ${i + 1}`).toString().slice(0, 127),
      quantity: Number(it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1)),
      unitPrice: Number(it.price || 0),
      imageUrl: it.imageUrl || it.image || ''
    }));

    // Delivery selection
    const providedId = String(req.body?.deliveryOptionId || "").trim();
    const simpleDelivery = String(req.body?.delivery || "").trim().toLowerCase();

    let opt = null;
    if (simpleDelivery === "collect") {
      opt = { _id: null, name: "Collect in store", deliveryDays: 0, priceCents: 0, active: true };
    } else if (providedId) {
      try {
        const found = await DeliveryOption.findById(providedId).lean();
        if (found && found.active) opt = found;
      } catch { /* swallow cast errors */ }
    }
    if (!opt) {
      opt = await DeliveryOption.findOne({ active: true })
        .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
        .lean();
    }
    if (!opt) {
      return res.status(404).json({ ok:false, code:"NO_ACTIVE_DELIVERY", message:"No active delivery options available." });
    }

    const deliveryDollars = Number(((opt.priceCents || 0) / 100).toFixed(2));
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

    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      console.error("PayPal token error:", e?.message || e);
      return res.status(502).json({ ok:false, code:"PAYPAL_TOKEN", message:"Failed to get PayPal token. Check client id/secret & network." });
    }

    const ppRes = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type":"application/json" },
      body: JSON.stringify(orderBody)
    });

    const data = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error("PayPal create error:", ppRes.status, data);
      return res.status(502).json({
        ok:false,
        code:"PAYPAL_CREATE_FAILED",
        message: `PayPal create order failed (${ppRes.status}).`,
        details: data
      });
    }

    // snapshot for later (thank-you/receipt fallback) — includes itemsBrief
    req.session.pendingOrder = {
      id: data.id,
      itemsBrief,
      deliveryOptionId: opt._id ? String(opt._id) : null,
      deliveryName: opt.name,
      deliveryDays: opt.deliveryDays || 0,
      deliveryPrice: delivery,
      subTotal, vatTotal, grandTotal,
      currency: upperCcy,
      createdAt: Date.now(),
    };

    return res.json({ ok:true, id: data.id });
  } catch (err) {
    console.error("create-order error:", err?.stack || err);
    return res.status(500).json({
      ok:false,
      code:"SERVER_ERROR",
      message: err?.message || "Server error creating order"
    });
  }
});

// ---------- capture order ----------
router.post("/capture-order", express.json(), async (req, res) => {
  try {
    const orderID = String(req.body?.orderID || req.query?.orderId || "");
    if (!orderID) return res.status(400).json({ ok:false, code:"MISSING_ORDER_ID", message:"Missing orderId/orderID" });

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

    // Build items from pending snapshot so DB always has line items
    const itemsFromPending = Array.isArray(pending?.itemsBrief)
      ? pending.itemsBrief.map(it => ({
          name: it.name,
          quantity: Number(it.quantity || 1),
          // store in Money schema shape; value as String
          price: { value: String(Number(it.unitPrice || 0).toFixed(2)) },
          imageUrl: it.imageUrl || ""
        }))
      : [];

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
          // ensure items are persisted for receipts
          items: itemsFromPending,
          raw: capture,
          userId: req.session?.user?._id || null,
          createdAt: new Date(),
        });
      }
    } catch (e) { console.warn("⚠️ Failed to persist Order:", e.message); }

    // snapshot for thank-you/receipt fallback (now includes items)
    req.session.lastOrderSnapshot = buildSessionSnapshot(orderID, pending);

    // clear cart + pending
    req.session.cart = { items: [] };
    req.session.pendingOrder = null;
    await saveSession(req);

    return res.json({ ok:true, orderId: orderID, capture });
  } catch (err) {
    console.error("capture-order error:", err);
    return res.status(500).json({ ok:false, code:"SERVER_ERROR", message:"Server error capturing order" });
  }
});

// ---------- thank-you data for client fetch ----------
router.get("/order/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");

    if (Order) {
      let doc = await Order.findOne({ paypalOrderId: id }).lean();
      if (!doc) {
        try { doc = await Order.findById(id).lean(); } catch { /* ignore */ }
      }
      if (doc) return res.json({ success:true, order: shapeOrderForClient(doc) });
    }

    const snap = req.session?.lastOrderSnapshot;
    if (snap && String(snap.id) === id) {
      return res.json({ success:true, order: snap });
    }

    return res.status(404).json({ success:false, message:"Order not found" });
  } catch (err) {
    console.error("order fetch error:", err);
    return res.status(500).json({ success:false, message:"Server error loading order" });
  }
});

// Nice thank-you alias that matches the checkout redirect
router.get("/thank-you", (req, res) => {
  const id = String(req.query.orderId || "");
  const snapId = req.session?.lastOrderSnapshot?.id;
  if (!id && snapId) {
    return res.redirect(`/payment/thank-you?orderId=${encodeURIComponent(snapId)}`);
  }
  return res.render("thank-you", {
    title: "Thank you",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ["Payment captured successfully."],
    error: []
  });
});

// Legacy aliases
router.get("/success", (req, res) => {
  const qid = String(req.query.id || "");
  const snapId = req.session?.lastOrderSnapshot?.id;
  if (!qid && snapId) {
    return res.redirect(`/payment/success?id=${encodeURIComponent(snapId)}`);
  }
  return res.render("thank-you", {
    title:"Thank you",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success:["Payment captured successfully."],
    error:[]
  });
});

router.get("/cancel", (req, res) => {
  return res.render("payment-cancel", {
    title: "Payment Cancelled",
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: [],
    error: ["Payment was cancelled or failed."],
  });
});

// JSON list for your Orders page
router.get("/my-orders", async (req, res) => {
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
