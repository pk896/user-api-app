// routes/payment.js
const express = require('express');
const router = express.Router();
//const fetch = require('node-fetch');
const { fetch } = require('undici');

const DeliveryOption = require('../models/DeliveryOption');
let Order = null;
try {
  Order = require('../models/Order');
} catch {
  /* optional model */
}

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_CLIENT_SECRET,
  PAYPAL_MODE = 'sandbox',
  BASE_CURRENCY = 'USD',
  VAT_RATE = '0.15',
  BRAND_NAME = 'Phakisi Global',
  SHIPPING_PREF = 'NO_SHIPPING',
} = process.env;

const PP_API =
  PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

const upperCcy = String(BASE_CURRENCY || 'USD').toUpperCase();
const vatRate = Number(VAT_RATE || 0);

// ---------- helpers ----------
function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}
function themeCssFrom(req) {
  return req.session?.theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

// --- Helper: find order by orderId -> paypalOrderId -> _id ---
async function findOrderByAnyId(id) {
  if (!Order) return null;
  const OrderModel = Order || require('../models/Order');

  // 1) try orderId (canonical)
  let doc = await OrderModel.findOne({ orderId: id }).lean();
  if (doc) return doc;

  // 2) try paypalOrderId (legacy)
  try {
    doc = await OrderModel.findOne({ paypalOrderId: id }).lean();
    if (doc) return doc;
  } catch { /* ignore */ }

  // 3) try Mongo _id (ObjectId)
  if (/^[0-9a-fA-F]{24}$/.test(String(id))) {
    try {
      doc = await OrderModel.findById(id).lean();
      if (doc) return doc;
    } catch { /* ignore cast */ }
  }

  return null;
}

async function cheapestDelivery() {
  const opt = await DeliveryOption.findOne({ active: true })
    .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
    .lean();
  if (!opt) {return { opt: null, dollars: 0 };}
  const dollars = Number(((opt.priceCents || 0) / 100).toFixed(2));
  return { opt, dollars };
}

function computeTotalsFromSession(cart, delivery = 0) {
  const itemsArr = Array.isArray(cart?.items) ? cart.items : [];
  let sub = 0;
  const ppItems = itemsArr.map((it, i) => {
    const price = Number(it.price || 0);
    const qty = Number(it.qty != null ? it.qty : it.quantity != null ? it.quantity : 1);
    const name = (it.name || `Item ${i + 1}`).toString().slice(0, 127);
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
  return {
    items: ppItems,
    subTotal: +sub.toFixed(2),
    vatTotal: vat,
    delivery: del,
    grandTotal: grand,
  };
}

async function getAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);}
  return (await res.json()).access_token;
}

function saveSession(req) {
  return new Promise((resolve) => {
    if (req.session && typeof req.session.save === 'function') {
      req.session.save(() => resolve());
    } else {resolve();}
  });
}

// Normalize DB doc into client shape (prefer persisted doc.items)
function shapeOrderForClient(doc) {
  const b = doc.breakdown || {};

  // Currency: from breakdown or default
  const currency = b.currency || upperCcy;

  // Pull capture amount from stored PayPal payload if present
  const pu = Array.isArray(doc.purchase_units) && doc.purchase_units.length
    ? doc.purchase_units[0]
    : {};
  const capture =
    pu.payments && Array.isArray(pu.payments.captures) && pu.payments.captures.length
      ? pu.payments.captures[0]
      : {};

  // ---- unified totals (support both old + new shapes) ----
  const rawItemTotal =
    (b.itemTotal && (b.itemTotal.value ?? b.itemTotal)) ??
    (b.subTotal ?? b.subtotal ?? null);

  const rawTaxTotal =
    (b.taxTotal && (b.taxTotal.value ?? b.taxTotal)) ??
    (b.vatTotal ?? b.tax ?? null);

  const rawShipping =
    (b.shipping && (b.shipping.value ?? b.shipping)) ??
    (b.delivery ?? b.shippingTotal ?? null);

  const itemTotalVal = rawItemTotal != null ? Number(rawItemTotal) : null;
  const taxTotalVal = rawTaxTotal != null ? Number(rawTaxTotal) : null;
  const shippingVal = rawShipping != null ? Number(rawShipping) : null;

  const grandFromBreakdown =
    b.grandTotal ??
    b.total ??
    ((itemTotalVal || 0) + (taxTotalVal || 0) + (shippingVal || 0));

  const amountObj = capture.amount || {
    currency_code: currency,
    value: String(grandFromBreakdown || 0),
  };

  // ---- items (prefer persisted items from our DB) ----
  const items =
    Array.isArray(doc.items) && doc.items.length
      ? doc.items.map((it) => ({
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: {
            value: Number(
              it.price && it.price.value != null ? it.price.value : it.price || 0
            ),
          },
          imageUrl: it.imageUrl || '',
        }))
      : Array.isArray(pu.items)
      ? pu.items.map((it) => ({
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: {
            currency_code:
              (it.unit_amount && it.unit_amount.currency_code) || currency,
            value: Number(it.unit_amount?.value || 0),
          },
          imageUrl: it.image_url || '',
        }))
      : [];

  return {
    id: doc.paypalOrderId || doc.orderId || String(doc._id),
    status: doc.status || 'COMPLETED',
    createdAt: doc.createdAt || new Date(),
    currency: amountObj.currency_code || currency,
    amount: {
      value: Number(
        amountObj.value != null ? amountObj.value : grandFromBreakdown || 0
      ),
    },
    items,
    breakdown: {
      itemTotal: itemTotalVal != null ? { value: itemTotalVal } : null,
      taxTotal: taxTotalVal != null ? { value: taxTotalVal } : null,
      shipping: shippingVal != null ? { value: shippingVal } : null,
    },
    delivery: doc.delivery
      ? {
          name: doc.delivery.name || null,
          deliveryDays:
            doc.delivery.days != null
              ? doc.delivery.days
              : doc.delivery.deliveryDays != null
              ? doc.delivery.deliveryDays
              : null,
          amount:
            doc.delivery.price != null
              ? Number(doc.delivery.price)
              : doc.delivery.amount != null
              ? Number(doc.delivery.amount)
              : null,
        }
      : null,
    shipping: doc.shipping || null,
  };
}

// Build a session snapshot (used when DB isn’t available yet) — now includes items
function buildSessionSnapshot(orderId, pending) {
  const items = Array.isArray(pending?.itemsBrief)
    ? pending.itemsBrief.map((it) => ({
        name: it.name,
        quantity: Number(it.quantity || 1),
        price: { value: Number(it.unitPrice || 0) },
      }))
    : [];

  return {
    id: orderId,
    status: 'COMPLETED',
    createdAt: new Date(),
    currency: pending?.currency || upperCcy,
    amount: { value: Number(pending?.grandTotal || 0) },
    items,
    breakdown: {
      itemTotal: pending?.subTotal != null ? { value: Number(pending.subTotal) } : null,
      taxTotal: pending?.vatTotal != null ? { value: Number(pending.vatTotal) } : null,
      shipping: pending?.deliveryPrice != null ? { value: Number(pending.deliveryPrice) } : null,
    },
    delivery:
      pending && (pending.deliveryName || pending.deliveryDays != null)
        ? {
            name: pending.deliveryName || null,
            deliveryDays: pending.deliveryDays ?? null,
            amount: pending.deliveryPrice != null ? Number(pending.deliveryPrice) : null,
          }
        : null,
    shipping: null,
  };
}

// ---------- views ----------
router.get('/checkout', async (req, res) => {
  let shippingFlat = 0;
  try {
    const { dollars } = await cheapestDelivery();
    shippingFlat = dollars;
  } catch {
    /* ignore */
  }

  return res.render('checkout', {
    title: 'Checkout',
    themeCss: themeCssFrom(req),
    NONCE: resNonce(req),
    paypalClientId: PAYPAL_CLIENT_ID,
    currency: upperCcy,
    brandName: BRAND_NAME,
    vatRate,
    shippingFlat,
    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

// Optional orders list view
router.get('/orders', (req, res) => {
  return res.render('orders', {
    title: 'My Orders',
    themeCss: themeCssFrom(req),
    NONCE: resNonce(req),
    success: [],
    error: [],
  });
});

// Printable receipt view (robust items + delivery snapshot)
router.get('/receipt/:id', async (req, res) => {
  const id = String(req.params.id || '');
  let doc = null;

  // Try DB lookups in this order: orderId -> paypalOrderId -> _id
  try {
    doc = await findOrderByAnyId(id);
  } catch {
    /* ignore */
  }

  // Helper for mapping items into a simple shape
  const mapItems = (arr) =>
    Array.isArray(arr)
      ? arr.map((it) => ({
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: {
            value: Number(
              it.price?.value ??
                it.unitPrice ??
                it.unit_amount?.value ??
                it.price ??
                0
            ),
          },
          imageUrl: it.imageUrl || '',
        }))
      : [];

  // ---------- Session snapshot path ----------
  if (
    !doc &&
    req.session?.lastOrderSnapshot &&
    String(req.session.lastOrderSnapshot.id) === id
  ) {
    const s = req.session.lastOrderSnapshot;

    const currency = s.currency || upperCcy;
    const itemsFromSnap = mapItems(s.items || s.itemsBrief);

    const b = s.breakdown || {};

    const rawSub =
      (b.itemTotal && (b.itemTotal.value ?? b.itemTotal)) ??
      s.subTotal ??
      s.subtotal ??
      0;

    const rawTax =
      (b.taxTotal && (b.taxTotal.value ?? b.taxTotal)) ??
      s.vatTotal ??
      s.tax ??
      0;

    const rawShip =
      (b.shipping && (b.shipping.value ?? b.shipping)) ??
      s.delivery ??
      s.deliveryPrice ??
      0;

    const totals = {
      subtotal: Number(rawSub) || 0,
      tax: Number(rawTax) || 0,
      shipping: Number(rawShip) || 0,
    };
    totals.total = Number(
      s.amount?.value ??
        b.grandTotal ??
        b.total ??
        totals.subtotal + totals.tax + totals.shipping
    );

    return res.render('receipt', {
      title: 'Order Receipt',
      themeCss: themeCssFrom(req),
      nonce: resNonce(req),
      order: {
        id: s.id,
        status: s.status || 'COMPLETED',
        createdAt: s.createdAt || new Date(),
        currency,
        items: itemsFromSnap,
        totals,
        delivery: s.delivery
          ? {
              name: s.delivery.name || s.deliveryName || null,
              deliveryDays: s.delivery.deliveryDays ?? s.deliveryDays ?? null,
              amount:
                s.delivery.amount != null
                  ? Number(s.delivery.amount)
                  : s.deliveryPrice != null
                  ? Number(s.deliveryPrice)
                  : null,
            }
          : null,
        shipping: s.shipping || null,
      },
      success: [],
      error: [],
    });
  }

  // Still nothing?
  if (!doc) return res.status(404).send('Order not found');

  // ---------- DB doc path ----------

  // Prefer persisted items
  let items = mapItems(doc.items);

  // Fallback: session snapshot if same id
  if (
    !items.length &&
    req.session?.lastOrderSnapshot &&
    String(req.session.lastOrderSnapshot.id) ===
      (doc.orderId || doc.paypalOrderId || String(doc._id))
  ) {
    const s = req.session.lastOrderSnapshot;
    items = mapItems(s.items || s.itemsBrief);
  }

  // Fallback: fetch from PayPal as last resort
  if (!items.length) {
    try {
      const token = await getAccessToken();
      const r = await fetch(
        `${PP_API}/v2/checkout/orders/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (r.ok) {
        const orderJson = await r.json();
        const pu = Array.isArray(orderJson.purchase_units)
          ? orderJson.purchase_units[0]
          : null;
        if (pu && Array.isArray(pu.items) && pu.items.length) {
          items = mapItems(pu.items);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const b = doc.breakdown || {};
  const currency = b.currency || upperCcy;

  // Pull from flat fields first, then nested money objects, then delivery.amount
  const rawSub =
    b.subTotal ??
    b.subtotal ??
    (b.itemTotal && (b.itemTotal.value ?? b.itemTotal)) ??
    0;

  const rawTax =
    b.vatTotal ??
    b.tax ??
    (b.taxTotal && (b.taxTotal.value ?? b.taxTotal)) ??
    0;

  const rawShip =
    b.delivery ??
    (b.shipping && (b.shipping.value ?? b.shipping)) ??
    (doc.delivery && (doc.delivery.amount ?? doc.delivery.price)) ??
    0;

  const totals = {
    subtotal: Number(rawSub) || 0,
    tax: Number(rawTax) || 0,
    shipping: Number(rawShip) || 0,
  };

  totals.total = Number(
    b.grandTotal ??
      b.total ??
      (doc.amount && doc.amount.value != null
        ? doc.amount.value
        : totals.subtotal + totals.tax + totals.shipping)
  );

  const deliveryForView = doc.delivery
    ? {
        name: doc.delivery.name || null,
        deliveryDays:
          (doc.delivery.days ?? doc.delivery.deliveryDays) ?? null,
        amount:
          doc.delivery.price != null
            ? Number(doc.delivery.price)
            : doc.delivery.amount != null
            ? Number(doc.delivery.amount)
            : null,
      }
    : null;

  const orderForView = {
    id: doc.orderId || doc.paypalOrderId || String(doc._id),
    status: doc.status || 'COMPLETED',
    createdAt: doc.createdAt || new Date(),
    currency,
    items,
    totals,
    delivery: deliveryForView,
    shipping: doc.shipping || null,
  };

  return res.render('receipt', {
    title: 'Order Receipt',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    order: orderForView,
    success: [],
    error: [],
  });
});

// Frontend config (optional)
router.get('/config', (_req, res) => {
  res.json({
    clientId: PAYPAL_CLIENT_ID,
    currency: upperCcy,
    intent: 'capture',
    mode: PAYPAL_MODE,
    baseCurrency: upperCcy,
    brandName: BRAND_NAME,
  });
});

router.post('/create-order', express.json(), async (req, res) => {
  try {
    const cart = req.session.cart || { items: [] };
    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res
        .status(422)
        .json({ ok: false, code: 'CART_EMPTY', message: 'Cart is empty (server session).' });
    }

    // Compact items list from the cart for later display/persist
    // ✅ Include productId (Product.customId) so we can decrement stock after capture
    const itemsBrief = (Array.isArray(cart.items) ? cart.items : []).map((it, i) => {
      const qty = Number(it.qty != null ? it.qty : it.quantity != null ? it.quantity : 1);
      const unitPrice = Number(it.price || 0);
      const productId = String(
        it.customId != null
          ? it.customId
          : it.productId != null
            ? it.productId
            : it.pid != null
              ? it.pid
              : it.sku != null
                ? it.sku
                : ''
      ).trim();

      return {
        productId, // 👈 critical for inventory decrement
        name: (it.name || `Item ${i + 1}`).toString().slice(0, 127),
        quantity: qty,
        unitPrice,
        imageUrl: it.imageUrl || it.image || '',
      };
    });

    // Delivery selection
    const providedId = String(req.body?.deliveryOptionId || '').trim();
    const simpleDelivery = String(req.body?.delivery || '').trim().toLowerCase();

    let opt = null;
    if (simpleDelivery === 'collect') {
      opt = { _id: null, name: 'Collect in store', deliveryDays: 0, priceCents: 0, active: true };
    } else if (providedId) {
      try {
        const found = await DeliveryOption.findById(providedId).lean();
        if (found && found.active) opt = found;
      } catch {
        /* ignore cast errors */
      }
    }
    if (!opt) {
      opt = await DeliveryOption.findOne({ active: true })
        .sort({ priceCents: 1, deliveryDays: 1, name: 1 })
        .lean();
    }
    if (!opt) {
      return res.status(404).json({
        ok: false,
        code: 'NO_ACTIVE_DELIVERY',
        message: 'No active delivery options available.',
      });
    }

    const deliveryDollars = Number(((opt.priceCents || 0) / 100).toFixed(2));

    // Build PayPal items + totals using the helper
    const {
      items: ppItems,
      subTotal,
      vatTotal,
      delivery: del,
      grandTotal: grand,
    } = computeTotalsFromSession(
      {
        items: itemsBrief.map(it => ({
          name: it.name,
          price: it.unitPrice,
          quantity: it.quantity,
        })),
      },
      deliveryDollars
    );

    const orderBody = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: `PK-${Date.now()}`,
          amount: {
            currency_code: upperCcy,              // assume defined above (e.g. "USD")
            value: grand.toFixed(2),
            breakdown: {
              item_total: {
                currency_code: upperCcy,
                value: subTotal.toFixed(2),       // ✅ FIXED
              },
              tax_total: {
                currency_code: upperCcy,
                value: vatTotal.toFixed(2),       // ✅ FIXED
              },
              shipping: {
                currency_code: upperCcy,
                value: del.toFixed(2),
              },
            },
          },
          items: ppItems,
          description: `Delivery: ${opt.name} (${opt.deliveryDays || 0} days)`,
        },
      ],
      application_context: {
        brand_name: BRAND_NAME,
        user_action: 'PAY_NOW',
        shipping_preference: SHIPPING_PREF,
      },
    };

    let token;
    try {
      token = await getAccessToken();
    } catch (e) {
      console.error('PayPal token error:', e?.message || e);
      return res.status(502).json({
        ok: false,
        code: 'PAYPAL_TOKEN',
        message: 'Failed to get PayPal token. Check client id/secret & network.',
      });
    }

    const ppRes = await fetch(`${PP_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody),
    });

    const data = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error('PayPal create error:', ppRes.status, data);
      return res.status(502).json({
        ok: false,
        code: 'PAYPAL_CREATE_FAILED',
        message: `PayPal create order failed (${ppRes.status}).`,
        details: data,
      });
    }

    req.session.pendingOrder = {
      id: data.id,
      itemsBrief,
      deliveryOptionId: opt._id ? String(opt._id) : null,
      deliveryName: opt.name,
      deliveryDays: opt.deliveryDays || 0,
      deliveryPrice: del,
      subTotal,
      vatTotal,
      grandTotal: grand,
      currency: upperCcy,
      createdAt: Date.now(),
    };

    return res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error('create-order error:', err?.stack || err);
    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: err?.message || 'Server error creating order',
    });
  }
});

router.post('/capture-order', express.json(), async (req, res) => {
  try {
    const orderID = String(req.body?.orderID || req.query?.orderId || '');
    if (!orderID) {
      return res
        .status(400)
        .json({ ok: false, code: 'MISSING_ORDER_ID', message: 'Missing orderId/orderID' });
    }

    const token = await getAccessToken();
    const capRes = await fetch(`${PP_API}/v2/checkout/orders/${orderID}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const capture = await capRes.json();

    if (!capRes.ok) {
      console.error('PayPal capture error:', capture);
      return res
        .status(capRes.status)
        .json({
          ok: false,
          code: 'PAYPAL_CAPTURE_FAILED',
          message: 'PayPal capture failed',
          details: capture,
        });
    }

    const pending = req.session.pendingOrder || null;
    const cart = req.session.cart || { items: [] };

    // Build items to persist (with productId)
    const itemsFromPending = Array.isArray(pending?.itemsBrief)
      ? pending.itemsBrief.map((it) => ({
          productId: String(it.productId || '').trim(), // 👈 critical for inventory
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: { value: String(Number(it.unitPrice || 0).toFixed(2)) }, // Money schema (string)
          imageUrl: it.imageUrl || '',
        }))
      : [];

    // Persist order (if model available)
    let doc = null;
    try {
      if (Order) {
        // Pull business buyer if available
        const businessBuyer =
          req.session?.business && req.session.business.role === 'buyer'
            ? req.session.business._id
            : null;

        doc = await Order.findOneAndUpdate(
          { orderId: orderID }, // canonical key
          {
            orderId: orderID,
            paypalOrderId: orderID, // legacy key if schema supports it
            status: capture.status,
            payer: capture?.payer || null,
            purchase_units: capture?.purchase_units || [],
            amount:
              capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount || null,
            delivery: pending
              ? {
                  id: pending.deliveryOptionId || null,
                  name: pending.deliveryName || null,
                  deliveryDays: pending.deliveryDays ?? null,
                  amount:
                    pending.deliveryPrice != null
                      ? String(Number(pending.deliveryPrice).toFixed(2))
                      : null,
                }
              : null,
            breakdown: pending
              ? {
                  // flat numeric fields
                  subTotal:
                    pending.subTotal != null
                      ? Number(pending.subTotal)
                      : undefined,
                  vatTotal:
                    pending.vatTotal != null
                      ? Number(pending.vatTotal)
                      : undefined,
                  delivery:
                    pending.deliveryPrice != null
                      ? Number(pending.deliveryPrice)
                      : undefined,
                  grandTotal:
                    pending.grandTotal != null
                      ? Number(pending.grandTotal)
                      : undefined,
                  currency: upperCcy,

                  // nested "money" objects for compatibility
                  itemTotal:
                    pending.subTotal != null
                      ? {
                          value: String(
                            Number(pending.subTotal).toFixed(2)
                          ),
                          currency: upperCcy,
                        }
                      : undefined,
                  taxTotal:
                    pending.vatTotal != null
                      ? {
                          value: String(
                            Number(pending.vatTotal).toFixed(2)
                          ),
                          currency: upperCcy,
                        }
                      : undefined,
                  shipping:
                    pending.deliveryPrice != null
                      ? {
                          value: String(
                            Number(pending.deliveryPrice).toFixed(2)
                          ),
                          currency: upperCcy,
                        }
                      : undefined,
                }
              : undefined,
            items: itemsFromPending, // includes productId
            raw: capture,
            userId: req.session?.user?._id || null,
            businessBuyer,
            $setOnInsert: { createdAt: new Date() },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );
      }
    } catch (e) {
      console.warn('⚠️ Failed to persist Order:', e.message);
    }

    // ---- Idempotent inventory adjustment ----
    try {
      if (Order && doc) {
        if (!doc.inventoryAdjusted) {
          const Product = require('../models/Product');

          // Build per-product totals from pending snapshot (fallback to cart)
          const srcItems =
            Array.isArray(pending?.itemsBrief) && pending.itemsBrief.length
              ? pending.itemsBrief
              : Array.isArray(cart.items)
              ? cart.items
              : [];

          const perProduct = new Map(); // customId -> { qty, orderBump: 1 }
          for (const it of srcItems) {
            const pid = String(
              it.productId != null
                ? it.productId
                : it.customId != null
                ? it.customId
                : it.pid != null
                ? it.pid
                : it.sku != null
                ? it.sku
                : ''
            ).trim();
            if (!pid) continue;

            const qty = Number(
              it.quantity != null ? it.quantity : it.qty != null ? it.qty : 1
            );
            const prev = perProduct.get(pid) || { qty: 0, orderBump: 0 };
            prev.qty += qty;
            prev.orderBump = 1; // exactly once per product per order
            perProduct.set(pid, prev);
          }

          if (perProduct.size > 0) {
            const ops = [];
            for (const [pid, t] of perProduct.entries()) {
              ops.push({
                updateOne: {
                  filter: { customId: pid },
                  update: {
                    $inc: {
                      stock: -t.qty,
                      soldCount: t.qty,
                      soldOrders: t.orderBump,
                    },
                  },
                },
              });
            }

            if (ops.length) {
              await Product.bulkWrite(ops);
              await Product.updateMany(
                { stock: { $lt: 0 } },
                { $set: { stock: 0 } }
              );
            }
          }

          doc.inventoryAdjusted = true;
          await doc.save();
        }
      }
    } catch (e) {
      console.warn('⚠️ Inventory adjust failed:', e.message);
    }

    // ---- Build thank-you snapshot & clear session ----
    req.session.lastOrderSnapshot = buildSessionSnapshot(orderID, pending);
    req.session.cart = { items: [] };
    req.session.pendingOrder = null;
    await saveSession(req);

    return res.json({ ok: true, orderId: orderID, capture });
  } catch (err) {
    console.error('capture-order error:', err);
    return res
      .status(500)
      .json({ ok: false, code: 'SERVER_ERROR', message: 'Server error capturing order' });
  }
});

// Thank-you page JSON fetch (order details)
router.get('/order/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');

    // Try DB (orderId -> paypalOrderId -> _id)
    if (Order) {
      const doc = await findOrderByAnyId(id);
      if (doc) {
        return res.json({ success: true, order: shapeOrderForClient(doc) });
      }
    }

    // Fallback: session snapshot
    const snap = req.session?.lastOrderSnapshot;
    if (snap && String(snap.id) === id) {
      return res.json({ success: true, order: snap });
    }

    return res.status(404).json({ success: false, message: 'Order not found' });
  } catch (err) {
    console.error('order fetch error:', err);
    return res.status(500).json({ success: false, message: 'Server error loading order' });
  }
});

// Nice thank-you alias that matches the checkout redirect
router.get('/thank-you', (req, res) => {
  const id = String(req.query.orderId || '');
  const snapId = req.session?.lastOrderSnapshot?.id;
  if (!id && snapId) {
    return res.redirect(`/payment/thank-you?orderId=${encodeURIComponent(snapId)}`);
  }
  return res.render('thank-you', {
    title: 'Thank you',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ['Payment captured successfully.'],
    error: [],
  });
});

// Legacy aliases
router.get('/success', (req, res) => {
  const qid = String(req.query.id || '');
  const snapId = req.session?.lastOrderSnapshot?.id;
  if (!qid && snapId) {
    return res.redirect(`/payment/success?id=${encodeURIComponent(snapId)}`);
  }
  return res.render('thank-you', {
    title: 'Thank you',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: ['Payment captured successfully.'],
    error: [],
  });
});

router.get('/cancel', (req, res) => {
  return res.render('payment-cancel', {
    title: 'Payment Cancelled',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: [],
    error: ['Payment was cancelled or failed.'],
  });
});

// JSON list for your Orders page
router.get('/my-orders', async (req, res) => {
  try {
    if (!Order) {return res.json({ ok: true, orders: [] });}
    const q = {};
    if (req.session?.user?._id) {q.userId = req.session.user._id;}
    const list = await Order.find(q).sort({ createdAt: -1 }).limit(20).lean();
    const mapped = list.map((o) => ({
      orderId: o.paypalOrderId || String(o._id),
      status: o.status || '',
      createdAt: o.createdAt || null,
      amount: Number(o.breakdown?.grandTotal || o.amount?.value || 0),
      currency: o.breakdown?.currency || upperCcy,
    }));
    return res.json({ ok: true, orders: mapped });
  } catch (err) {
    console.error('my-orders error:', err);
    return res.status(500).json({ ok: false, message: 'Server error fetching orders' });
  }
});

module.exports = {
  router,
  computeTotalsFromSession,
};

