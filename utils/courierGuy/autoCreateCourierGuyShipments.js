// utils/courierGuy/autoCreateCourierGuyShipments.js
'use strict';

const Order = require('../../models/Order');

const { createCourierGuyShipment } = require('./createCourierGuyShipment');

const { saveCourierGuyShipmentToOrder } = require('./saveCourierGuyShipmentToOrder');

const { addTrackingToPaypalOrder } = require('../paypal/addTrackingToPaypalOrder');

const { sendOrderProcessingEmail } = require('../emails/orderStatusEmail');

let running = false;
let timer = null;

function boolEnv(name, fallback = false) {
  const raw = String(process.env[name] ?? '')
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function numEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function paidQuery() {
  return {
    $or: [
      { status: { $in: ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED', 'CAPTURED'] } },
      {
        paymentStatus: { $in: ['PAID', 'COMPLETED', 'CAPTURED', 'paid', 'completed', 'captured'] },
      },
    ],
  };
}

function getLatestCaptureId(order) {
  const directCaptureId = String(
    order?.paypal?.captureId || ''
  ).trim();

  if (directCaptureId) {
    return directCaptureId;
  }

  const captures = Array.isArray(order?.captures)
    ? order.captures
    : [];

  const completedCapture = [...captures]
    .reverse()
    .find((capture) => {
      const status = String(capture?.status || '')
        .trim()
        .toUpperCase();

      return (
        capture?.captureId &&
        ['COMPLETED', 'CAPTURED', 'PAID'].includes(status)
      );
    });

  if (completedCapture?.captureId) {
    return String(completedCapture.captureId).trim();
  }

  const latestCapture = [...captures]
    .reverse()
    .find((capture) => capture?.captureId);

  return String(
    latestCapture?.captureId || ''
  ).trim();
}

async function pushPaypalTracking(order) {
  const captureId = getLatestCaptureId(order);

  const trackingNumber = String(order?.shippingTracking?.trackingNumber || '').trim();

  if (!captureId || !trackingNumber || order?.courierGuy?.paypalTrackingPushedAt) {
    return;
  }

  try {
    const response = await addTrackingToPaypalOrder({
      transactionId: captureId,
      trackingNumber,
      carrier: 'The Courier Guy',
      status: 'SHIPPED',
    });

    order.courierGuy.paypalTrackingPushedAt = new Date();
    order.courierGuy.paypalTrackingLastError = '';
    order.courierGuy.paypalTrackingLastResponse = response;

    await order.save();
  } catch (error) {
    order.courierGuy.paypalTrackingLastError = String(error?.message || error).slice(0, 500);

    await order.save();
  }
}

async function processOrder(order) {
  try {
    const result = await createCourierGuyShipment(order);
    await saveCourierGuyShipmentToOrder(order, result);
    await pushPaypalTracking(order);

    try {
      await sendOrderProcessingEmail(order);
    } catch (emailError) {
      console.warn('[courier-guy-auto] processing email failed:', emailError.message);
    }

    console.log('[courier-guy-auto] shipment created:', {
      orderId: order.orderId,
      shipmentId: order.courierGuy?.shipmentId,
    });
  } catch (error) {
    order.courierGuy = order.courierGuy || {};
    order.courierGuy.autoCreateStatus = 'FAILED';
    order.courierGuy.autoCreateAttemptedAt = new Date();
    order.courierGuy.autoCreateLastError = String(error?.message || error).slice(0, 500);
    await order.save().catch(() => {});

    console.error('[courier-guy-auto] shipment creation failed:', {
      orderId: order.orderId,
      code: error?.code,
      message: error?.message,
    });
  }
}

async function runCourierGuyAutoCreateOnce() {
  if (running) return;
  running = true;

  try {
    const maxPerRun = Math.max(1, Math.floor(numEnv('COURIER_GUY_AUTO_CREATE_MAX_PER_RUN', 10)));

    const candidates = await Order.find({
      shippingProvider: 'COURIER_GUY',
      'courierGuy.serviceLevelId': { $exists: true, $nin: ['', null] },
      'courierGuy.shipmentId': { $in: ['', null] },
      'courierGuy.autoCreateEnabled': { $ne: false },
      'courierGuy.autoCreateStatus': { $in: ['PENDING', 'FAILED', null] },
      ...paidQuery(),
    })
      .sort({ createdAt: 1 })
      .limit(maxPerRun);

    for (const candidate of candidates) {
      const claimed = await Order.findOneAndUpdate(
        {
          _id: candidate._id,
          shippingProvider: 'COURIER_GUY',
          'courierGuy.shipmentId': { $in: ['', null] },
          'courierGuy.autoCreateStatus': { $in: ['PENDING', 'FAILED', null] },
        },
        {
          $set: {
            'courierGuy.autoCreateStatus': 'PROCESSING',
            'courierGuy.autoCreateAttemptedAt': new Date(),
            'courierGuy.autoCreateLastError': '',
          },
        },
        { new: true },
      );

      if (claimed) await processOrder(claimed);
    }
  } finally {
    running = false;
  }
}

function startCourierGuyAutoCreateWorker() {
  const enabled = boolEnv('COURIER_GUY_AUTO_CREATE_ENABLED', false);

  if (!enabled) {
    console.log('[courier-guy-auto] disabled.');
    return;
  }

  const intervalMinutes = Math.max(1, numEnv('COURIER_GUY_AUTO_CREATE_INTERVAL_MINUTES', 5));

  console.log(`[courier-guy-auto] enabled. interval=${intervalMinutes}m`);

  setTimeout(() => {
    runCourierGuyAutoCreateOnce().catch((error) => {
      console.error('[courier-guy-auto] initial run failed:', error);
    });
  }, 15000);

  timer = setInterval(
    () => {
      runCourierGuyAutoCreateOnce().catch((error) => {
        console.error('[courier-guy-auto] scheduled run failed:', error);
      });
    },
    intervalMinutes * 60 * 1000,
  );

  timer.unref?.();
}

module.exports = {
  runCourierGuyAutoCreateOnce,
  startCourierGuyAutoCreateWorker,
};
