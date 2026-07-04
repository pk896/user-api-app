// routes/cjPaypalWebhooks.js
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

function checkoutOrderId(event) {
  return safeString(event?.resource?.id, 200);
}

async function findCjOrder(event) {
  const paypalOrderId =
    captureOrderId(event) ||
    checkoutOrderId(event);

  const paypalCaptureId = captureId(event);

  const filters = [];

  if (paypalOrderId) {
    filters.push({
      'paypal.orderId': paypalOrderId,
    });
  }

  if (paypalCaptureId) {
    filters.push({
      'paypal.captureId': paypalCaptureId,
    });
  }

  if (!filters.length) {
    return null;
  }

  return CjOrder.findOne({
    $or: filters,
  });
}

router.post('/paypal', async (req, res) => {
  let event;

  try {
    event = parseBody(req.body);
  } catch {
    return res.status(400).json({
      received: false,
      message: 'Invalid JSON body.',
    });
  }

  if (!event) {
    return res.status(400).json({
      received: false,
      message: 'Webhook body is missing.',
    });
  }

  const verification =
    await verifyCjPaypalWebhook(req, event);

  if (!verification?.ok) {
    console.warn(
      '[CJ PayPal webhook] Signature verification failed:',
      verification,
    );

    return res.status(400).json({
      received: false,
      message: 'Invalid webhook signature.',
    });
  }

  const eventType = safeString(
    event?.event_type,
    200,
  ).toUpperCase();

  const supportedEvents = new Set([
    'PAYMENT.CAPTURE.PENDING',
    'PAYMENT.CAPTURE.COMPLETED',
    'PAYMENT.CAPTURE.DECLINED',
    'PAYMENT.CAPTURE.DENIED',
    'PAYMENT.CAPTURE.REVERSED',
    'PAYMENT.CAPTURE.REFUNDED',
    'CHECKOUT.ORDER.CANCELLED',
  ]);

  if (!supportedEvents.has(eventType)) {
    return res.status(200).json({
      received: true,
      ignored: true,
      eventType,
    });
  }

  try {
    const order = await findCjOrder(event);

    if (!order) {
      return res.status(200).json({
        received: true,
        ignored: true,
        reason: 'CJ order not found for PayPal webhook.',
        eventType,
      });
    }

    const resource = event.resource || {};

    const incomingCaptureId = captureId(event);

    const incomingStatus =
      captureStatus(event) ||
      eventType.replace('PAYMENT.CAPTURE.', '');

    const incomingAmount = round2(
      resource?.amount?.value,
    );

    const incomingCurrency = safeString(
      resource?.amount?.currency_code,
      3,
    ).toUpperCase();

    const expectedAmount = round2(
      order?.paypal?.amount?.value ||
        order?.payableTotal?.value,
    );

    const expectedCurrency = safeString(
      order?.paypal?.amount?.currency ||
        order?.payableTotal?.currency,
      3,
    ).toUpperCase();

    if (
      eventType === 'PAYMENT.CAPTURE.COMPLETED' &&
      (
        !amountsMatch(
          expectedAmount,
          incomingAmount,
        ) ||
        incomingCurrency !== expectedCurrency
      )
    ) {
      order.status = 'PAYMENT_FAILED';
      order.paymentStatus = 'FAILED';
      order.fulfillmentStatus = 'PENDING';
      order.supplierOrder.createStatus = 'NOT_CREATED';
      order.lastPaymentErrorCode =
        'PAYPAL_WEBHOOK_AMOUNT_MISMATCH';
      order.lastPaymentErrorMessage =
        'PayPal webhook amount or currency did not match the CJ order.';

      await order.save();

      return res.status(200).json({
        received: true,
        rejected: true,
        reason: 'amount-or-currency-mismatch',
      });
    }

    if (incomingCaptureId) {
      order.paypal.captureId =
        incomingCaptureId;
    }

    if (eventType.startsWith('PAYMENT.CAPTURE.')) {
      order.paypal.captureStatus =
        incomingStatus;

      order.paypal.capturedAt =
        resource?.create_time
          ? new Date(resource.create_time)
          : new Date();
    }

    if (eventType === 'PAYMENT.CAPTURE.PENDING') {
      order.status = 'PAYMENT_PENDING';
      order.paymentStatus = 'PENDING';
      order.fulfillmentStatus = 'PENDING';
      order.supplierOrder.createStatus = 'NOT_CREATED';
      order.lastPaymentErrorCode =
        'PAYPAL_CAPTURE_PENDING';
      order.lastPaymentErrorMessage = safeString(
        resource?.status_details?.reason ||
          'PayPal capture is pending.',
      );
    }

    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      order.status = 'PAID';
      order.paymentStatus = 'COMPLETED';
      order.fulfillmentStatus = 'CJ_ORDER_PENDING';
      order.paidAt = resource?.create_time
        ? new Date(resource.create_time)
        : new Date();

      order.lastPaymentErrorCode = '';
      order.lastPaymentErrorMessage = '';
      order.supplierOrder.createStatus = 'PENDING';
    }

    if (
      eventType === 'PAYMENT.CAPTURE.DECLINED' ||
      eventType === 'PAYMENT.CAPTURE.DENIED' ||
      eventType === 'PAYMENT.CAPTURE.REVERSED'
    ) {
      order.status = 'PAYMENT_FAILED';
      order.paymentStatus = 'FAILED';
      order.fulfillmentStatus = 'PENDING';
      order.supplierOrder.createStatus = 'NOT_CREATED';
      order.lastPaymentErrorCode =
        eventType.replace(/\./g, '_');
      order.lastPaymentErrorMessage = safeString(
        resource?.status_details?.reason ||
          `PayPal reported ${eventType}.`,
      );
    }

    if (eventType === 'PAYMENT.CAPTURE.REFUNDED') {
      order.status = 'REFUNDED';
      order.paymentStatus = 'REFUNDED';
      order.fulfillmentStatus = 'CANCELLED';
      order.supplierOrder.createStatus = 'NOT_CREATED';
      order.lastPaymentErrorCode =
        'PAYPAL_CAPTURE_REFUNDED';
      order.lastPaymentErrorMessage =
        'PayPal reported that the CJ payment capture was refunded.';
    }

    if (eventType === 'CHECKOUT.ORDER.CANCELLED') {
      /*
       * Only cancel unpaid CJ orders.
       * Never overwrite an already completed payment.
       */
      if (
        String(
          order.paymentStatus || '',
        ).toUpperCase() !== 'COMPLETED'
      ) {
        order.status = 'CANCELLED';
        order.paymentStatus = 'CANCELLED';
        order.fulfillmentStatus = 'PENDING';
        order.supplierOrder.createStatus = 'NOT_CREATED';
        order.cancelledAt = new Date();
        order.paypal.orderStatus = 'CANCELLED';
        order.lastPaymentErrorCode =
          'PAYPAL_ORDER_CANCELLED';
        order.lastPaymentErrorMessage =
          'PayPal reported that the checkout order was cancelled.';
      }
    }

    await order.save();

    return res.status(200).json({
      received: true,
      eventType,
      cjOrderNumber: order.cjOrderNumber,
      paymentStatus: order.paymentStatus,
      fulfillmentStatus: order.fulfillmentStatus,
    });
  } catch (error) {
    console.error(
      '[CJ PayPal webhook] Processing failed:',
      error?.stack || error,
    );

    return res.status(500).json({
      received: false,
    });
  }
});

module.exports = router;