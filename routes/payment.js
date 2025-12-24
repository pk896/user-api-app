// routes/payment.js
'use strict';

const express = require('express');
const router = express.Router();
const { fetch } = require('undici');

const DeliveryOption = require('../models/DeliveryOption');
const { creditSellersFromOrder } = require('../utils/payouts/creditSellersFromOrder');

let debitSellersFromRefund = null;
try {
  ({ debitSellersFromRefund } = require('../utils/payouts/debitSellersFromRefund'));
} catch {
  // optional
}

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
  String(PAYPAL_MODE).toLowerCase() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const upperCcy = String(BASE_CURRENCY || 'USD').toUpperCase();
const vatRate = Number(VAT_RATE || 0);

// ✅ platform fee bps (1000 = 10%)
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS || 1000);

// ---------- helpers ----------
function resNonce(req) {
  return req?.res?.locals?.nonce || '';
}
function themeCssFrom(req) {
  return req.session?.theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function normalizeMoneyNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

function safeStr(v, max = 2000) {
  return String(v || '').trim().slice(0, max);
}

function safeMoneyString(v, max = 32) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().slice(0, max);
  return s ? s : null;
}

function toUpper(v, fallback = 'USD') {
  const s = String(v || '').trim().toUpperCase();
  return s || fallback;
}

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
  const cid = String(PAYPAL_CLIENT_ID || '').trim();
  const sec = String(PAYPAL_CLIENT_SECRET || '').trim();
  if (!cid || !sec) {
    throw new Error('Missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET');
  }

  const auth = Buffer.from(`${cid}:${sec}`).toString('base64');
  const res = await fetch(`${PP_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`PayPal token error: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

function saveSession(req) {
  return new Promise((resolve) => {
    if (req.session && typeof req.session.save === 'function') {
      req.session.save(() => resolve());
    } else resolve();
  });
}

// --- find order by orderId or Mongo _id ---
async function findOrderByAnyId(id) {
  if (!Order) return null;

  let doc = await Order.findOne({ orderId: String(id) }).lean();
  if (doc) return doc;

  if (/^[0-9a-fA-F]{24}$/.test(String(id))) {
    try {
      doc = await Order.findById(id).lean();
      if (doc) return doc;
    } catch {
      /* ignore */
    }
  }

  return null;
}

// --- shape DB order for client ---
function shapeOrderForClient(doc) {
  const currency =
    doc?.amount?.currency ||
    doc?.breakdown?.itemTotal?.currency ||
    upperCcy;

  const amountVal =
    normalizeMoneyNumber(doc?.amount?.value) ??
    normalizeMoneyNumber(doc?.raw?.purchase_units?.[0]?.amount?.value) ??
    0;

  const items = Array.isArray(doc?.items)
    ? doc.items.map((it) => ({
        name: it.name,
        quantity: Number(it.quantity || 1),
        price: { value: Number(it.price?.value ?? 0) },
        imageUrl: it.imageUrl || '',
      }))
    : [];

  const b = doc.breakdown || {};

  const itemTotalVal = normalizeMoneyNumber(b?.itemTotal?.value) ?? null;
  const taxTotalVal = normalizeMoneyNumber(b?.taxTotal?.value) ?? null;
  const shipVal = normalizeMoneyNumber(b?.shipping?.value) ?? null;

  return {
    id: doc.orderId || String(doc._id),
    status: doc.status || 'COMPLETED',
    createdAt: doc.createdAt || new Date(),
    currency,
    amount: { value: Number(amountVal || 0) },
    items,
    breakdown: {
      itemTotal: itemTotalVal != null ? { value: itemTotalVal } : null,
      taxTotal: taxTotalVal != null ? { value: taxTotalVal } : null,
      shipping: shipVal != null ? { value: shipVal } : null,
    },
    delivery: doc.delivery
      ? {
          name: doc.delivery.name || null,
          deliveryDays: doc.delivery.deliveryDays ?? null,
          amount: doc.delivery.amount != null ? Number(doc.delivery.amount) : null,
        }
      : null,
    shipping: doc.shipping || null,
  };
}

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
    nonce: resNonce(req),
    paypalClientId: PAYPAL_CLIENT_ID,
    currency: upperCcy,
    brandName: BRAND_NAME,
    vatRate,
    shippingFlat,
    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

router.get('/orders', (req, res) => {
  return res.render('orders', {
    title: 'My Orders',
    themeCss: themeCssFrom(req),
    nonce: resNonce(req),
    success: [],
    error: [],
  });
});

// Printable receipt view
router.get('/receipt/:id', async (req, res) => {
  const id = String(req.params.id || '');
  let doc = null;

  try {
    doc = await findOrderByAnyId(id);
  } catch {
    /* ignore */
  }

  const mapItems = (arr) =>
    Array.isArray(arr)
      ? arr.map((it) => ({
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: { value: Number(it.price?.value ?? it.unitPrice ?? it.unit_amount?.value ?? it.price ?? 0) },
          imageUrl: it.imageUrl || '',
        }))
      : [];

  // session snapshot
  if (!doc && req.session?.lastOrderSnapshot && String(req.session.lastOrderSnapshot.id) === id) {
    const s = req.session.lastOrderSnapshot;
    const currency = s.currency || upperCcy;
    const itemsFromSnap = mapItems(s.items || s.itemsBrief);
    const b = s.breakdown || {};

    const rawSub = (b.itemTotal && (b.itemTotal.value ?? b.itemTotal)) ?? s.subTotal ?? s.subtotal ?? 0;
    const rawTax = (b.taxTotal && (b.taxTotal.value ?? b.taxTotal)) ?? s.vatTotal ?? s.tax ?? 0;
    const rawShip = (b.shipping && (b.shipping.value ?? b.shipping)) ?? s.delivery ?? s.deliveryPrice ?? 0;

    const totals = {
      subtotal: Number(rawSub) || 0,
      tax: Number(rawTax) || 0,
      shipping: Number(rawShip) || 0,
    };
    totals.total = Number(s.amount?.value ?? b.grandTotal ?? b.total ?? totals.subtotal + totals.tax + totals.shipping);

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
              amount: s.delivery.amount != null ? Number(s.delivery.amount) : (s.deliveryPrice != null ? Number(s.deliveryPrice) : null),
            }
          : null,
        shipping: s.shipping || null,
      },
      success: [],
      error: [],
    });
  }

  if (!doc) return res.status(404).send('Order not found');

  // db doc
  let items = mapItems(doc.items);

  if (
    !items.length &&
    req.session?.lastOrderSnapshot &&
    String(req.session.lastOrderSnapshot.id) === (doc.orderId || String(doc._id))
  ) {
    const s = req.session.lastOrderSnapshot;
    items = mapItems(s.items || s.itemsBrief);
  }

  const currency = doc?.amount?.currency || upperCcy;

  const totals = {
    subtotal: normalizeMoneyNumber(doc?.breakdown?.itemTotal?.value) || 0,
    tax: normalizeMoneyNumber(doc?.breakdown?.taxTotal?.value) || 0,
    shipping: normalizeMoneyNumber(doc?.breakdown?.shipping?.value) || 0,
  };
  totals.total = normalizeMoneyNumber(doc?.amount?.value) ?? (totals.subtotal + totals.tax + totals.shipping);

  const orderForView = {
    id: doc.orderId || String(doc._id),
    status: doc.status || 'COMPLETED',
    createdAt: doc.createdAt || new Date(),
    currency,
    items,
    totals,
    delivery: doc.delivery
      ? {
          name: doc.delivery.name || null,
          deliveryDays: doc.delivery.deliveryDays ?? null,
          amount: doc.delivery.amount != null ? Number(doc.delivery.amount) : null,
        }
      : null,
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

// Frontend config
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
      return res.status(422).json({
        ok: false,
        code: 'CART_EMPTY',
        message: 'Cart is empty (server session).',
      });
    }

    const itemsBrief = (Array.isArray(cart.items) ? cart.items : []).map((it, i) => {
      const qty = Number(it.qty != null ? it.qty : it.quantity != null ? it.quantity : 1);
      const unitPrice = Number(it.price || 0);
      const productId = String(
        it.customId != null ? it.customId :
        it.productId != null ? it.productId :
        it.pid != null ? it.pid :
        it.sku != null ? it.sku : ''
      ).trim();

      return {
        productId,
        name: (it.name || `Item ${i + 1}`).toString().slice(0, 127),
        quantity: qty,
        unitPrice,
        imageUrl: it.imageUrl || it.image || '',
      };
    });

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
        /* ignore */
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

    const { items: ppItems, subTotal, vatTotal, delivery: del, grandTotal: grand } =
      computeTotalsFromSession(
        {
          items: itemsBrief.map((it) => ({
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
            currency_code: upperCcy,
            value: grand.toFixed(2),
            breakdown: {
              item_total: { currency_code: upperCcy, value: subTotal.toFixed(2) },
              tax_total: { currency_code: upperCcy, value: vatTotal.toFixed(2) },
              shipping: { currency_code: upperCcy, value: del.toFixed(2) },
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
      return res.status(400).json({
        ok: false,
        code: 'MISSING_ORDER_ID',
        message: 'Missing orderId/orderID',
      });
    }

    const token = await getAccessToken();
    const capRes = await fetch(`${PP_API}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });

    const capture = await capRes.json().catch(() => ({}));

    if (!capRes.ok) {
      console.error('PayPal capture error:', capture);
      return res.status(capRes.status).json({
        ok: false,
        code: 'PAYPAL_CAPTURE_FAILED',
        message: 'PayPal capture failed',
        details: capture,
      });
    }

    const pending = req.session.pendingOrder || null;
    const cart = req.session.cart || { items: [] };

    const pu = capture?.purchase_units?.[0] || {};
    const cap0 = Array.isArray(pu?.payments?.captures) ? pu.payments.captures[0] : null;

    const payer = capture?.payer || {};
    const payerName = payer?.name || {};
    const payerGivenName = payerName.given_name || payerName.given || '';
    const payerSurname = payerName.surname || payerName.family_name || '';
    const payerFullName = [payerGivenName, payerSurname].filter(Boolean).join(' ');

    const puShipping = pu.shipping || {};
    const puAddr = puShipping.address || {};

    const shippingAddress = {
      name:
        puShipping.name?.full_name ||
        puShipping.name?.name ||
        payerFullName ||
        'No name provided',
      address_line_1: puAddr.address_line_1 || puAddr.line1 || '',
      address_line_2: puAddr.address_line_2 || puAddr.line2 || '',
      admin_area_2: puAddr.admin_area_2 || puAddr.city || '',
      admin_area_1: puAddr.admin_area_1 || puAddr.state || '',
      postal_code: puAddr.postal_code || '',
      country_code: puAddr.country_code || '',
    };

    const captureAmount = cap0?.amount || null; // { currency_code, value }
    const orderAmount = pu?.amount || null;

    const finalAmount =
      captureAmount ||
      orderAmount || {
        value: String(pending?.grandTotal || '0'),
        currency_code: upperCcy,
      };

    const captureId = cap0?.id || null;

    const srb = cap0?.seller_receivable_breakdown || null;
    const paypalFeeVal = srb?.paypal_fee?.value ?? null;
    const netVal = srb?.net_amount?.value ?? null;
    const grossVal = srb?.gross_amount?.value ?? null;

    const itemsFromPending = Array.isArray(pending?.itemsBrief)
      ? pending.itemsBrief.map((it) => ({
          productId: String(it.productId || '').trim(),
          name: it.name,
          quantity: Number(it.quantity || 1),
          price: {
            value: String(Number(it.unitPrice || 0).toFixed(2)),
            currency: upperCcy,
          },
          imageUrl: it.imageUrl || '',
        }))
      : [];

    let doc = null;

    try {
      if (Order) {
        const businessBuyer =
          req.session?.business && req.session.business.role === 'buyer'
            ? req.session.business._id
            : null;

        const captureEntry =
          cap0
            ? {
                captureId: cap0.id || undefined,
                status: cap0.status || undefined,
                amount: cap0.amount
                  ? {
                      value: String(cap0.amount.value || '0'),
                      currency: cap0.amount.currency_code || upperCcy,
                    }
                  : undefined,
                sellerReceivable: srb
                  ? {
                      gross: grossVal != null
                        ? { value: String(grossVal), currency: cap0.amount?.currency_code || upperCcy }
                        : undefined,
                      paypalFee: paypalFeeVal != null
                        ? { value: String(paypalFeeVal), currency: cap0.amount?.currency_code || upperCcy }
                        : undefined,
                      net: netVal != null
                        ? { value: String(netVal), currency: cap0.amount?.currency_code || upperCcy }
                        : undefined,
                    }
                  : undefined,
                createTime: cap0?.create_time ? new Date(cap0.create_time) : undefined,
                updateTime: cap0?.update_time ? new Date(cap0.update_time) : undefined,
                links: Array.isArray(cap0?.links) ? cap0.links.map((l) => ({
                  rel: l.rel,
                  href: l.href,
                  method: l.method,
                })) : undefined,
              }
            : null;

        const update = {
          orderId: orderID,
          status: String(capture?.status || 'COMPLETED'),

          payer: {
            payerId: payer.payer_id || null,
            email: payer.email_address || null,
            name: { given: payerGivenName, surname: payerSurname },
            countryCode: payer.address?.country_code || shippingAddress.country_code,
          },

          shipping: shippingAddress,

          amount: {
            value: String(finalAmount.value || '0'),
            currency: finalAmount.currency_code || upperCcy,
          },

          breakdown: pending
            ? {
                itemTotal: pending.subTotal != null
                  ? { value: String(Number(pending.subTotal).toFixed(2)), currency: upperCcy }
                  : undefined,
                taxTotal: pending.vatTotal != null
                  ? { value: String(Number(pending.vatTotal).toFixed(2)), currency: upperCcy }
                  : undefined,
                shipping: pending.deliveryPrice != null
                  ? { value: String(Number(pending.deliveryPrice).toFixed(2)), currency: upperCcy }
                  : undefined,
              }
            : undefined,

          delivery: pending
            ? {
                id: pending.deliveryOptionId || null,
                name: pending.deliveryName || null,
                deliveryDays: pending.deliveryDays ?? null,
                amount: pending.deliveryPrice != null ? String(Number(pending.deliveryPrice).toFixed(2)) : null,
              }
            : null,

          items: itemsFromPending,
          raw: capture,

          userId: req.session?.user?._id || null,
          businessBuyer,
        };

        doc = await Order.findOneAndUpdate(
          { orderId: orderID },
          {
            $set: update,
            $setOnInsert: { createdAt: new Date() },
          },
          { new: true, upsert: true, setDefaultsOnInsert: true }
        );

        if (doc && captureEntry && captureId) {
          const already = Array.isArray(doc.captures)
            ? doc.captures.some((c) => String(c?.captureId || '') === String(captureId))
            : false;

          if (!already) {
            doc.captures = Array.isArray(doc.captures) ? doc.captures : [];
            doc.captures.push(captureEntry);
            await doc.save();
          }
        }

        // ✅ credit sellers (ledger)
        try {
          if (doc && typeof creditSellersFromOrder === 'function') {
            const paidStatus = String(capture?.status || doc.status || '').toUpperCase();
            if (paidStatus === 'COMPLETED' || paidStatus === 'PAID') {
              const feeBps = Number.isFinite(PLATFORM_FEE_BPS) ? PLATFORM_FEE_BPS : 1000;
              const r = await creditSellersFromOrder(doc, {
                platformFeeBps: feeBps,
                onlyIfPaidLike: false,
              });
              console.log('✅ Seller earnings credited (ledger):', r);
            }
          }
        } catch (e) {
          console.error('⚠️ Seller crediting failed (checkout continues):', e?.message || e);
        }
      }
    } catch (e) {
      console.error('❌ Failed to persist Order:', e?.message || e);
    }

    // ---- inventory adjust (unchanged) ----
    try {
      if (Order && doc) {
        if (!doc.inventoryAdjusted) {
          const Product = require('../models/Product');

          const srcItems =
            Array.isArray(pending?.itemsBrief) && pending.itemsBrief.length
              ? pending.itemsBrief
              : Array.isArray(cart.items)
              ? cart.items
              : [];

          const perProduct = new Map();
          for (const it of srcItems) {
            const pid = String(
              it.productId != null ? it.productId :
              it.customId != null ? it.customId :
              it.pid != null ? it.pid :
              it.sku != null ? it.sku : ''
            ).trim();
            if (!pid) continue;

            const qty = Number(it.quantity != null ? it.quantity : it.qty != null ? it.qty : 1);
            const prev = perProduct.get(pid) || { qty: 0, orderBump: 0 };
            prev.qty += qty;
            prev.orderBump = 1;
            perProduct.set(pid, prev);
          }

          if (perProduct.size > 0) {
            const ops = [];
            for (const [pid, t] of perProduct.entries()) {
              ops.push({
                updateOne: {
                  filter: { customId: pid },
                  update: { $inc: { stock: -t.qty, soldCount: t.qty, soldOrders: t.orderBump } },
                },
              });
            }

            if (ops.length) {
              await Product.bulkWrite(ops);
              await Product.updateMany({ stock: { $lt: 0 } }, { $set: { stock: 0 } });
            }
          }

          doc.inventoryAdjusted = true;
          await doc.save();
        }
      }
    } catch (e) {
      console.warn('⚠️ Inventory adjust failed:', e?.message || e);
    }

    // snapshot + clear session
    req.session.lastOrderSnapshot = {
      ...buildSessionSnapshot(orderID, pending),
      shipping: shippingAddress,
      amount: finalAmount,
    };
    req.session.cart = { items: [] };
    req.session.pendingOrder = null;
    await saveSession(req);

    return res.json({
      ok: true,
      orderId: orderID,
      capture,
      hasShipping: !!shippingAddress.address_line_1,
      amount: finalAmount,
    });
  } catch (err) {
    console.error('capture-order error:', err?.stack || err);
    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Server error capturing order',
    });
  }
});

// Thank-you JSON fetch
router.get('/order/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '');

    if (Order) {
      const doc = await findOrderByAnyId(id);
      if (doc) return res.json({ success: true, order: shapeOrderForClient(doc) });
    }

    const snap = req.session?.lastOrderSnapshot;
    if (snap && String(snap.id) === id) {
      return res.json({ success: true, order: snap });
    }

    return res.status(404).json({ success: false, message: 'Order not found' });
  } catch (err) {
    console.error('order fetch error:', err?.stack || err);
    return res.status(500).json({ success: false, message: 'Server error loading order' });
  }
});

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

router.get('/my-orders', async (req, res) => {
  try {
    if (!Order) return res.json({ ok: true, orders: [] });

    const q = {};
    if (req.session?.user?._id) q.userId = req.session.user._id;
    if (req.session?.business?._id && req.session.business.role === 'buyer') {
      q.businessBuyer = req.session.business._id;
    }

    const list = await Order.find(q).sort({ createdAt: -1 }).limit(20).lean();

    const mapped = list.map((o) => ({
      orderId: o.orderId || String(o._id),
      status: o.status || '',
      createdAt: o.createdAt || null,
      amount: Number(normalizeMoneyNumber(o?.amount?.value) ?? 0),
      currency: o?.amount?.currency || upperCcy,
    }));

    return res.json({ ok: true, orders: mapped });
  } catch (err) {
    console.error('my-orders error:', err?.stack || err);
    return res.status(500).json({ ok: false, message: 'Server error fetching orders' });
  }
});

/* -----------------------------------------------------------
 * 💸 Admin Refunds (Full + Partial)
 *  POST /payment/refund
 * --------------------------------------------------------- */

let requireOrdersAdmin = null;
try {
  requireOrdersAdmin = require('../middleware/requireOrdersAdmin');
} catch {
  requireOrdersAdmin = (req, res, next) => {
    if (req.session?.ordersAdmin || req.session?.admin) return next();
    return res.status(401).json({ success: false, message: 'Unauthorized (orders admin only).' });
  };
}

async function findOrderByCaptureId(captureId) {
  if (!Order) return null;
  const cid = String(captureId || '').trim();
  if (!cid) return null;

  return Order.findOne({
    $or: [
      { 'captures.captureId': cid },
      { 'raw.purchase_units.payments.captures.id': cid },
      { 'raw.purchase_units.payments.captures.capture_id': cid },
      { 'raw.purchase_units.0.payments.captures.0.id': cid },
    ],
  });
}

function getCapturedAmountFromOrder(doc) {
  try {
    const val1 = normalizeMoneyNumber(doc?.amount?.value);
    const ccy1 = doc?.amount?.currency || upperCcy;
    if (val1 != null) return { value: val1, currency: ccy1 };

    const cap0 = Array.isArray(doc?.captures) ? doc.captures[0] : null;
    const val2 = normalizeMoneyNumber(cap0?.amount?.value);
    const ccy2 = cap0?.amount?.currency || upperCcy;
    if (val2 != null) return { value: val2, currency: ccy2 };

    const pu = Array.isArray(doc?.raw?.purchase_units) ? doc.raw.purchase_units[0] : null;
    const cap = pu?.payments?.captures?.[0] || null;
    const val3 = normalizeMoneyNumber(cap?.amount?.value);
    const ccy3 = cap?.amount?.currency_code || ccy1;
    return { value: val3 ?? null, currency: ccy3 || upperCcy };
  } catch {
    return { value: null, currency: doc?.amount?.currency || upperCcy };
  }
}

function sumRefundedFromOrder(doc) {
  try {
    const arr = Array.isArray(doc?.refunds) ? doc.refunds : [];
    let sum = 0;
    for (const r of arr) {
      const n = normalizeMoneyNumber(r?.amount);
      if (n != null) sum += n;
    }
    return +sum.toFixed(2);
  } catch {
    return 0;
  }
}

function refundSoFarWouldExceed(captured, refundedSoFar, want) {
  const remaining = captured - refundedSoFar;
  return want > remaining + 0.00001;
}

router.post('/refund', requireOrdersAdmin, express.json(), async (req, res) => {
  try {
    const captureId = safeStr(req.body?.captureId, 128);
    if (!captureId) {
      return res.status(400).json({ success: false, message: 'captureId is required.' });
    }

    const amountNum = normalizeMoneyNumber(req.body?.amount);
    if (amountNum !== null) {
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Amount must be a positive number, or omit for full refund.',
        });
      }
    }

    let currency = safeStr(req.body?.currency || upperCcy, 8).toUpperCase();

    let orderDoc = null;
    if (Order) {
      orderDoc = await findOrderByCaptureId(captureId);

      const bodyOrderId = safeStr(req.body?.orderId, 64);
      if (bodyOrderId && orderDoc) {
        const dbOrderId = String(orderDoc.orderId || orderDoc._id);
        if (dbOrderId !== bodyOrderId) {
          return res.status(400).json({
            success: false,
            message: 'captureId does not match the provided orderId.',
          });
        }
      }
    }

    if (orderDoc) {
      const captured = getCapturedAmountFromOrder(orderDoc);
      const refundedSoFar = sumRefundedFromOrder(orderDoc);

      const capturedCcy = String(captured?.currency || '').toUpperCase();
      if (capturedCcy) currency = capturedCcy;

      if (captured.value != null) {
        const want = amountNum === null ? (captured.value - refundedSoFar) : amountNum;

        if (want <= 0) {
          return res.status(400).json({
            success: false,
            message: 'Nothing left to refund for this capture.',
          });
        }

        if (refundSoFarWouldExceed(captured.value, refundedSoFar, want)) {
          return res.status(400).json({
            success: false,
            message: `Refund exceeds remaining refundable amount (${(captured.value - refundedSoFar).toFixed(2)}).`,
          });
        }
      }
    }

    const payload = {};
    if (amountNum !== null) {
      payload.amount = { value: amountNum.toFixed(2), currency_code: currency };
    }

    const note = safeStr(req.body?.note, 255);
    if (note) payload.note_to_payer = note;

    const token = await getAccessToken();

    const ppRes = await fetch(
      `${PP_API}/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );

    const refundJson = await ppRes.json().catch(() => ({}));
    if (!ppRes.ok) {
      console.error('PayPal refund error:', ppRes.status, refundJson);
      return res.status(502).json({
        success: false,
        message: refundJson?.message || `PayPal refund failed (${ppRes.status}).`,
        details: refundJson,
      });
    }

    // ✅ Persist refund + ✅ Debit sellers ledger (the missing piece)
    try {
      if (orderDoc) {
        const refundId = refundJson?.id ? String(refundJson.id) : null;

        // idempotency by refundId
        if (refundId) {
          const already = Array.isArray(orderDoc.refunds)
            ? orderDoc.refunds.some((r) => String(r?.refundId || '') === refundId)
            : false;

          if (already) {
            return res.json({ success: true, refund: refundJson, duplicated: true });
          }
        }

        const paypalRefundValue = refundJson?.amount?.value ?? null;
        const paypalRefundCurrency = refundJson?.amount?.currency_code ?? null;

        const refundedAmountStr = safeMoneyString(
          paypalRefundValue ?? (amountNum !== null ? amountNum.toFixed(2) : null),
          32
        );

        const refundedCurrencyStr = toUpper(
          paypalRefundCurrency ?? currency,
          currency
        );

        orderDoc.refunds = Array.isArray(orderDoc.refunds) ? orderDoc.refunds : [];
        orderDoc.refunds.push({
          refundId: refundId,
          status: refundJson?.status || null,
          amount: refundedAmountStr,
          currency: refundedCurrencyStr || null,
          createdAt: new Date(),
        });

        // update refundedTotal + status
        const captured = getCapturedAmountFromOrder(orderDoc);
        const refundedSoFar = sumRefundedFromOrder(orderDoc);

        orderDoc.refundedTotal = String(refundedSoFar.toFixed(2));

        if (captured.value != null) {
          if (refundedSoFar >= captured.value - 0.00001) {
            orderDoc.status = 'REFUNDED';
          } else if (refundedSoFar > 0) {
            orderDoc.status = 'PARTIALLY_REFUNDED';
          }
        } else {
          orderDoc.status = 'REFUND_SUBMITTED';
        }

        await orderDoc.save();

        // ✅ IMPORTANT: reverse seller earnings in YOUR ledger
        try {
          if (typeof debitSellersFromRefund === 'function') {
            const isFullRefundRequest = (amountNum === null);

            const r = await debitSellersFromRefund(orderDoc, {
              refundId: refundId,
              amount: isFullRefundRequest
                ? null
                : (paypalRefundValue ?? (amountNum !== null ? amountNum.toFixed(2) : null)),
              currency: refundedCurrencyStr,
              // ✅ keep true so it still works even if status changed to REFUNDED (paidLike might become false)
              allowWhenUnpaid: true,
              platformFeeBps: PLATFORM_FEE_BPS,
            });

            console.log('✅ Seller earnings debited (ledger):', r);
          }
        } catch (e2) {
          console.error('⚠️ Seller debit failed (refund continues):', e2?.message || e2);
        }
      }
    } catch (e) {
      console.warn('Refund saved to PayPal but failed to persist to DB:', e?.message || e);
    }

    return res.json({ success: true, refund: refundJson });
  } catch (err) {
    console.error('refund error:', err?.stack || err);
    return res.status(500).json({ success: false, message: 'Server error refunding payment.' });
  }
});


// ✅ IMPORTANT: export router normally so app.use('/payment', ...) works
module.exports = router;

// Optional: if you used this elsewhere via require('./payment').computeTotalsFromSession
module.exports.computeTotalsFromSession = computeTotalsFromSession;
