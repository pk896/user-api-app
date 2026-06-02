// routes/paypalWebhooks.js
'use strict';

const express = require('express');
const router = express.Router();

let Order = null;
try {
  Order = require('../models/Order');
} catch {
  // optional in some deployments
  Order = null;
}

let Product = null;
try {
  Product = require('../models/Product');
} catch {
  Product = null;
}

let debitSellersFromRefund = null;
try {
  ({ debitSellersFromRefund } = require('../utils/payouts/debitSellersFromRefund'));
} catch {
  // optional
  debitSellersFromRefund = null;
}

const { verifyWebhookSignature } = require('../utils/paypal/verifyWebhookSignature');

/* -------------------------------------------------- */
/* Helpers */
/* -------------------------------------------------- */

function safeJsonParse(raw) {
  try {
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
    if (typeof raw === 'string') return JSON.parse(raw);
    if (typeof raw === 'object' && raw) return raw;
    return null;
  } catch {
    return null;
  }
}

function safeStr(v, max = 200) {
  return String(v || '').trim().slice(0, max);
}

function normalizeMoney(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function sumRefunds(order) {
  try {
    const arr = Array.isArray(order?.refunds) ? order.refunds : [];
    let sum = 0;
    for (const r of arr) {
      const n = normalizeMoney(r?.amount);
      if (n != null) sum += n;
    }
    return +sum.toFixed(2);
  } catch {
    return 0;
  }
}

/**
 * PayPal refund webhooks:
 * - resource.id is refundId
 * - capture_id can appear in different places depending on event type
 */
function extractCaptureId(body) {
  // Primary (what you had)
  const a = body?.resource?.supplementary_data?.related_ids?.capture_id;

  // Fallbacks (seen in different webhook payloads)
  const b = body?.resource?.links?.find?.((l) => String(l?.rel || '').toLowerCase() === 'up')?.href || '';
  // sometimes capture id is in a URL path like: /v2/payments/captures/<CAPTURE_ID>
  const m = /\/v2\/payments\/captures\/([^/?#]+)/i.exec(String(b));
  const c = m && m[1] ? m[1] : null;

  // last resort: sometimes present as resource.capture_id (older/edge cases)
  const d = body?.resource?.capture_id;

  const cid = a || c || d || '';
  return cid ? safeStr(cid, 128) : '';
}

function extractRefundId(body) {
  const rid = body?.resource?.id || body?.resource?.refund_id;
  return rid ? safeStr(rid, 128) : null;
}

function extractRefundAmount(body) {
  return body?.resource?.amount?.value ?? body?.resource?.refund_amount?.value ?? null;
}

function extractRefundCurrency(body, fallback = process.env.BASE_CURRENCY || 'USD') {
  return (
    safeStr(body?.resource?.amount?.currency_code, 8).toUpperCase() ||
    safeStr(body?.resource?.refund_amount?.currency_code, 8).toUpperCase() ||
    fallback
  );
}

function isRefundEventType(eventTypeUpper) {
  return (
    eventTypeUpper === 'PAYMENT.CAPTURE.REFUNDED' ||
    eventTypeUpper === 'PAYMENT.CAPTURE.REVERSED' ||
    eventTypeUpper === 'PAYMENT.SALE.REFUNDED' ||
    eventTypeUpper === 'PAYMENT.REFUND.COMPLETED' || // sometimes appears
    eventTypeUpper === 'PAYMENT.REFUND.DENIED' ||     // still useful to record
    eventTypeUpper === 'PAYMENT.REFUND.PENDING'
  );
}

function pickProductKeyFromItem(it) {
  return String(it?.productId || it?.customId || it?.pid || it?.sku || '').trim();
}

async function applyStockDelta(items, deltaSign /* +1 restore */) {
  if (!Product) return { ok: false, reason: 'NO_PRODUCT_MODEL' };

  const arr = Array.isArray(items) ? items : [];
  if (!arr.length) return { ok: true, changed: 0 };

  const ops = [];
  for (const it of arr) {
    const key = pickProductKeyFromItem(it);
    const qty = Number(it?.quantity || 1);

    if (!key) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;

    ops.push({
      updateOne: {
        filter: { customId: key },     // ✅ your productId is Product.customId
        update: { $inc: { stock: deltaSign * qty } },
      },
    });
  }

  if (!ops.length) return { ok: true, changed: 0 };

  const res = await Product.bulkWrite(ops, { ordered: false });
  return { ok: true, changed: Number(res?.modifiedCount || 0) };
}

function getWebhookItemQty(item) {
  const qty = Number(item?.quantity || item?.qty || 0);
  return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function getWebhookMoneyValue(value) {
  if (value === null || value === undefined || value === '') return 0;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }

  if (typeof value === 'object') {
    return getWebhookMoneyValue(value.value ?? value.amount ?? value.price ?? 0);
  }

  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : 0;
}

function getWebhookItemUnitPrice(item) {
  return getWebhookMoneyValue(
    item?.priceGross?.value ?? item?.price?.value ?? item?.price ?? item?.unitPrice ?? 0,
  );
}

function getWebhookOrderCapturedTotal(orderDoc) {
  return getWebhookMoneyValue(orderDoc?.amount?.value ?? orderDoc?.amount ?? 0);
}

function markOrderItemsRefundedFromPaypal(orderDoc, refundAmountRaw) {
  if (!orderDoc || !Array.isArray(orderDoc.items) || !orderDoc.items.length) {
    return {
      ok: false,
      reason: 'NO_ORDER_ITEMS',
      markedItems: 0,
      refundedQuantity: 0,
    };
  }

  const refundAmount = getWebhookMoneyValue(refundAmountRaw);
  const capturedTotal = getWebhookOrderCapturedTotal(orderDoc);
  const now = new Date();

  let markedItems = 0;
  let refundedQuantity = 0;

  const isFullRefund =
    refundAmount > 0 &&
    capturedTotal > 0 &&
    refundAmount >= capturedTotal - 0.00001;

  // ✅ Full refund: mark every order item fully refunded.
  if (isFullRefund) {
    orderDoc.items.forEach((item) => {
      const qty = getWebhookItemQty(item);
      if (qty <= 0) return;

      item.refundStatus = 'REFUNDED';
      item.refundedQuantity = qty;
      item.refundedAt = now;
      item.refundReason = 'PayPal full refund webhook';

      markedItems += 1;
      refundedQuantity += qty;
    });

    return {
      ok: true,
      mode: 'FULL',
      markedItems,
      refundedQuantity,
    };
  }

  // ✅ Partial refund from PayPal dashboard:
  // PayPal gives amount, not exact product. We allocate the amount across items by line value.
  let remainingRefundAmount = refundAmount;

  orderDoc.items.forEach((item) => {
    if (remainingRefundAmount <= 0) return;

    const qty = getWebhookItemQty(item);
    if (qty <= 0) return;

    const alreadyRefundedQty = Number(item?.refundedQuantity || 0);
    const refundableQty = Math.max(0, qty - alreadyRefundedQty);
    if (refundableQty <= 0) return;

    const unitPrice = getWebhookItemUnitPrice(item);
    if (unitPrice <= 0) return;

    const refundableLineValue = unitPrice * refundableQty;
    const amountForThisItem = Math.min(remainingRefundAmount, refundableLineValue);

    let qtyToRefund = Math.ceil(amountForThisItem / unitPrice);
    qtyToRefund = Math.max(0, Math.min(refundableQty, qtyToRefund));

    if (qtyToRefund <= 0) return;

    const nextRefundedQty = Math.min(qty, alreadyRefundedQty + qtyToRefund);

    item.refundedQuantity = nextRefundedQty;
    item.refundedAt = now;
    item.refundReason = 'PayPal partial refund webhook';

    if (nextRefundedQty >= qty) {
      item.refundStatus = 'REFUNDED';
    } else {
      item.refundStatus = 'PARTIAL';
    }

    markedItems += 1;
    refundedQuantity += qtyToRefund;
    remainingRefundAmount -= amountForThisItem;
  });

  return {
    ok: true,
    mode: 'PARTIAL_AMOUNT_ALLOCATED',
    markedItems,
    refundedQuantity,
  };
}

function buildStockItemsFromOrder(orderDoc) {
  // Prefer inventoryAdjustedItems (most accurate), fallback to order.items
  const inv = Array.isArray(orderDoc?.inventoryAdjustedItems) ? orderDoc.inventoryAdjustedItems : [];
  if (inv.length) {
    return inv
      .map((x) => ({
        productId: String(x?.productId || '').trim(),
        quantity: Number(x?.quantity || 1),
      }))
      .filter((x) => x.productId && Number.isFinite(x.quantity) && x.quantity > 0);
  }

  const items = Array.isArray(orderDoc?.items) ? orderDoc.items : [];
  return items
    .map((it) => ({
      productId: pickProductKeyFromItem(it),
      quantity: Number(it?.quantity || 1),
    }))
    .filter((x) => x.productId && Number.isFinite(x.quantity) && x.quantity > 0);
}

async function restoreInventoryOnRefundedOrder(orderDoc, reason = 'webhook-refund') {
  if (!orderDoc) return { ok: false, reason: 'NO_ORDERDOC' };
  if (!Product) return { ok: false, reason: 'NO_PRODUCT_MODEL' };

  // ✅ idempotent: never restore twice
  if (orderDoc.inventoryRestored) return { ok: true, skipped: true, reason: 'ALREADY_RESTORED' };

  // If you deducted stock at capture time, this should be true.
  // But we still restore from items if seller already lost stock.
  const items = buildStockItemsFromOrder(orderDoc);
  if (!items.length) return { ok: false, reason: 'NO_ITEMS_TO_RESTORE' };

  const out = await applyStockDelta(items, +1);

  if (out.ok) {
    orderDoc.inventoryRestored = true;
    orderDoc.raw = orderDoc.raw || {};
    orderDoc.raw._inventoryRestoreReason = String(reason).slice(0, 80);
    await orderDoc.save();
  }

  return out;
}

/* -------------------------------------------------- */
/* Routes */
/* -------------------------------------------------- */

router.get('/_ping', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * ✅ CRITICAL:
 * PayPal signature verification needs the exact raw bytes.
 * So this route uses express.raw({type:'application/json'}) to get a Buffer in req.body.
 *
 * If your app already provides raw body some other way, this still works.
 */
router.post(
  '/paypal',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    console.log('🔔 PAYPAL WEBHOOK HIT', new Date().toISOString(), {
      url: req.originalUrl,
      ct: req.headers['content-type'],
      tid: req.headers['paypal-transmission-id'] ? 'yes' : 'no',
    });

    // req.body is Buffer due to express.raw
    const body = safeJsonParse(req.body);
    if (!body) {
      console.warn('❌ Invalid webhook JSON body (raw expected)');
      return res.status(400).json({ ok: false, error: 'invalid-json' });
    }

    const eventType = safeStr(body?.event_type || '', 128).toUpperCase();
    const eventId = safeStr(body?.id || '', 128);

    console.log('[PAYPAL] Event:', eventType, 'eventId=', eventId);

    // ---- Signature verification ----
    const verification = await verifyWebhookSignature(req, body);

    console.log('[PAYPAL] Signature result:', {
      ok: verification?.ok,
      reason: verification?.reason,
      verification_status: verification?.verification_status,
      status: verification?.status,
      missing: verification?.missing,
    });

    if (!verification?.ok) {
      console.error('❌ Webhook signature FAILED');
      return res.status(400).json({
        ok: false,
        reason: verification?.reason || 'signature-failed',
        verification_status: verification?.verification_status,
        missing: verification?.missing,
      });
    }

    // ---- Refund events only ----
    if (!isRefundEventType(eventType)) {
      return res.json({ ok: true, ignored: true, eventType, eventId });
    }

    const captureId = extractCaptureId(body);
    const refundId = extractRefundId(body);
    const refundAmount = extractRefundAmount(body);
    const refundCurrency = extractRefundCurrency(body);

    console.log('[PAYPAL] Refund payload:', {
      captureId,
      refundId,
      refundAmount,
      refundCurrency,
    });

    if (!captureId) {
      console.warn('[PAYPAL] refund event missing captureId');
      return res.json({
        ok: true,
        ignored: true,
        reason: 'missing-captureId',
        refundId,
        eventType,
        eventId,
      });
    }

    if (!Order) {
      console.warn('[PAYPAL] Order model not available');
      return res.json({ ok: true, ignored: true, reason: 'Order-model-missing' });
    }

    // Find order by captureId (canonical)
    const order = await Order.findOne({
      $or: [
        { 'paypal.captureId': captureId },
        { 'captures.captureId': captureId },
        { captureId: captureId },
      ],
    });

    if (!order) {
      console.warn('⚠️ Order NOT FOUND for captureId:', captureId);
      return res.json({
        ok: true,
        ignored: true,
        reason: 'order-not-found',
        captureId,
        refundId,
        eventType,
        eventId,
      });
    }

    order.refunds = Array.isArray(order.refunds) ? order.refunds : [];

    // ✅ Strong idempotency:
    // 1) refundId match (best)
    // 2) fallback to eventId marker
    const marker = `webhook:${eventType}:${eventId}`;
    const already =
      (refundId && order.refunds.some((r) => String(r?.refundId || '') === refundId)) ||
      order.refunds.some((r) => String(r?.source || '') === marker);

    if (!already) {
      order.refunds.push({
        refundId: refundId || null,
        status: safeStr(body?.resource?.status, 64) || 'COMPLETED',
        amount: refundAmount != null ? String(refundAmount) : null,
        currency: refundCurrency,
        createdAt: new Date(),
        source: marker,
      });
    }

    const refundedSoFar = sumRefunds(order);
    const capturedTotal = normalizeMoney(order?.amount?.value);

    order.refundedTotal = refundedSoFar.toFixed(2);

    // ✅ Set refundedAt only if any refund exists
    if (refundedSoFar > 0) order.refundedAt = new Date();

    // ✅ Correct partial vs full flags (so charts/payouts can filter properly)
    if (capturedTotal != null) {
      if (refundedSoFar >= capturedTotal - 0.00001) {
        order.status = 'REFUNDED';
        order.paymentStatus = 'refunded';
      } else if (refundedSoFar > 0) {
        order.status = 'PARTIALLY_REFUNDED';
        order.paymentStatus = 'partially_refunded';
      }
    } else {
      order.status = 'REFUND_SUBMITTED';
      order.paymentStatus = 'refund_submitted';
    }

    // ✅ Mark item-level refund fields for supplier dashboard.
    // Only do it for a NEW webhook/refund, not duplicate webhook retries.
    let itemRefundMarking = null;

    if (!already) {
      itemRefundMarking = markOrderItemsRefundedFromPaypal(order, refundAmount);
      order.raw = order.raw || {};
      order.raw._itemRefundMarking = itemRefundMarking;
    }

    await order.save();

    // ✅ Restore stock on FULL refund (idempotent)
    let inventoryRestore = null;
    try {
      if (String(order.status || '').toUpperCase() === 'REFUNDED') {
        inventoryRestore = await restoreInventoryOnRefundedOrder(order, 'paypal-webhook');
        if (!inventoryRestore.ok) {
          console.warn('⚠️ Inventory restore failed:', inventoryRestore);
        }
      }
    } catch (e) {
      console.warn('⚠️ Inventory restore exception:', e?.message || String(e));
    }

    // Optional: debit seller ledger (so seller balance + payouts drop immediately)
    if (typeof debitSellersFromRefund === 'function') {
      try {
        await debitSellersFromRefund(order, {
          refundId,
          amount: refundAmount ?? null,
          currency: refundCurrency,
          allowWhenUnpaid: true,
          platformFeeBps: Number(process.env.PLATFORM_FEE_BPS || 1000),
        });
      } catch (e) {
        console.warn('⚠️ debitSellersFromRefund failed:', e?.message || String(e));
      }
    }

    console.log('✅ Refund processed for order:', order.orderId || String(order._id));

    return res.json({
      ok: true,
      handled: 'refund',
      eventType,
      eventId,
      captureId,
      refundId,
      orderId: order.orderId || String(order._id),
      status: order.status,
      paymentStatus: order.paymentStatus,
      refundedTotal: order.refundedTotal,
      newlyInserted: !already,
      itemRefundMarking,
      inventoryRestore,
    });
  }
);

module.exports = router;
