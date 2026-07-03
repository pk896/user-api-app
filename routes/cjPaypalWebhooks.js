'use strict';

const express = require('express');

const CjOrder = require('../models/CjOrder');
const { verifyCjPaypalWebhook } = require('../utils/cj/verifyCjPaypalWebhook');

const router = express.Router();

function safeString(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseBody(rawBody) {
  if (Buffer.isBuffer(rawBody)) {
    return JSON.parse(rawBody.toString('utf8'));
  }

  if (typeof rawBody === 'string') {
    return JSON.parse(rawBody);
  }

  if (rawBody && typeof rawBody === 'object') {
    return rawBody;
  }

  return null;
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function amountsMatch(expected, actual) {
  return Math.abs(round2(expected) - round2(actual)) < 0.01;
}

function captureOrderId(event) {
  return safeString(
    event?.resource?.supplementary_data?.related_ids?.order_id,
    200,
  );
}

function captureId(event) {
  return safeString(event?.resource?.id, 200);
}

function captureStatus(event) {
  return safeString(event?.resource?.status, 100).toUpperCase();
}

async function findCjOrder(event) {
  const paypalOrderId = captureOrderId(event);
  const paypalCaptureId = captureId(event);

  const filters = [];

  if (paypalOrderId) {
    filters.push({ 'paypal.orderId': paypalOrderId });
  }

  if (paypalCaptureId) {
    filters.push({ 'paypal.captureId': paypalCaptureId });
  }

  if (!filters.length) {
    return null;
  }

  return CjOrder.findOne({ $or: filters });
}

router.post('/paypal', async (req, res) => {
  let event;

  try {
    event = parseBody(req.body);
  } catch (error) {
    return res.status(400).json({ received: false, message: 'Invalid JSON body.' });
  }

  if (!event) {
    return res.status(400).json({ received: false, message: 'Webhook body is missing.' });
  }

  const verification = await verifyCjPaypalWebhook(req, event);

  if (!verification?.ok) {
    console.warn('[CJ PayPal webhook] Signature verification failed:', verification);
    return res.status(400).json({ received: false, message: 'Invalid webhook signature.' });
  }

  const eventType = safeString(event?.event_type, 200).toUpperCase();

  const supportedEvents = new Set([
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.REVERSED',
    'PAYMENT.CAPTURE.REFUNDED',
  ]);

  if (!supportedEvents.has(eventType)) {
    return res.status(200).json({ received: true, ignored: true });
  }

  try {
    const order = await findCjOrder(event);

    if (!order) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const resource = event.resource || {};
    const incomingCaptureId = captureId(event);
    const incomingStatus = captureStatus(event);
    const incomingAmount = round2(resource?.amount?.value);
    const incomingCurrency = safeString(resource?.amount?.currency_code, 3).toUpperCase();
    const expectedAmount = round2(order?.paypal?.amount?.value || order?.payableTotal?.value);
    const expectedCurrency = safeString(
      order?.paypal?.amount?.currency || order?.payableTotal?.currency,
      3,
    ).toUpperCase();

    if (
      eventType === 'PAYMENT.CAPTURE.COMPLETED' &&
      (!amountsMatch(expectedAmount, incomingAmount) || incomingCurrency !== expectedCurrency)
    ) {
      order.status = 'PAYMENT_FAILED';
      order.paymentStatus = 'FAILED';
      order.lastPaymentErrorCode = 'PAYPAL_WEBHOOK_AMOUNT_MISMATCH';
      order.lastPaymentErrorMessage = 'PayPal webhook amount or currency did not match the CJ order.';
      await order.save();

      return res.status(200).json({ received: true, rejected: true });
    }

    if (incomingCaptureId) {
      order.paypal.captureId = incomingCaptureId;
    }

    order.paypal.captureStatus = incomingStatus || eventType.replace('PAYMENT.CAPTURE.', '');
    order.paypal.capturedAt = resource?.create_time ? new Date(resource.create_time) : new Date();

    if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      order.status = 'PAYMENT_PENDING';
      order.paymentStatus = 'PENDING';
      order.fulfillmentStatus = 'PENDING';
      order.lastPaymentErrorCode = 'PAYPAL_CAPTURE_PENDING';
      order.lastPaymentErrorMessage = safeString(
        resource?.status_details?.reason || 'PayPal capture is pending.',
      );
    }

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      order.status = 'PAID';
      order.paymentStatus = 'COMPLETED';
      order.fulfillmentStatus = 'CJ_ORDER_PENDING';
      order.paidAt = resource?.create_time ? new Date(resource.create_time) : new Date();
      order.lastPaymentErrorCode = '';
      order.lastPaymentErrorMessage = '';
      order.supplierOrder.createStatus = 'PENDING';
    }

    if (
      eventType === 'PAYMENT.CAPTURE.DENIED' ||
      eventType === 'PAYMENT.CAPTURE.REVERSED'
    ) {
      order.status = 'PAYMENT_FAILED';
      order.paymentStatus = 'FAILED';
      order.fulfillmentStatus = 'PENDING';
      order.lastPaymentErrorCode = eventType.replace(/\./g, '_');
      order.lastPaymentErrorMessage = safeString(
        resource?.status_details?.reason || `PayPal reported ${eventType}.`,
      );
    }

    if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      order.status = 'REFUNDED';
      order.paymentStatus = 'REFUNDED';
      order.fulfillmentStatus = 'CANCELLED';
    }

    await order.save();

    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('[CJ PayPal webhook] Processing failed:', error?.stack || error);
    return res.status(500).json({ received: false });
  }
});

module.exports = router;