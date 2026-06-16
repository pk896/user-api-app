// routes/adminCourierGuy.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const Order = require('../models/Order');
const { logAdminAction } = require('../utils/logAdminAction');

const { createCourierGuyShipment } = require('../utils/courierGuy/createCourierGuyShipment');

const { getCourierGuyShipment } = require('../utils/courierGuy/getCourierGuyShipment');

const { getCourierGuyDocuments } = require('../utils/courierGuy/getCourierGuyDocuments');

const {
  saveCourierGuyShipmentToOrder,
} = require('../utils/courierGuy/saveCourierGuyShipmentToOrder');

const { addTrackingToPaypalOrder } = require('../utils/paypal/addTrackingToPaypalOrder');

const { sendOrderProcessingEmail } = require('../utils/emails/orderStatusEmail');

const router = express.Router();

const guards = [requireAdmin, requireAdminRole(['super_admin', 'shipping_admin'])];

function findOrder(id) {
  const value = String(id || '').trim();

  if (mongoose.isValidObjectId(value)) {
    return Order.findById(value);
  }

  return Order.findOne({ orderId: value });
}

function getLatestCaptureId(order) {
  const directCaptureId = String(order?.paypal?.captureId || '').trim();

  if (directCaptureId) {
    return directCaptureId;
  }

  const captures = Array.isArray(order?.captures) ? order.captures : [];

  const completedCapture = [...captures].reverse().find((capture) => {
    const status = String(capture?.status || '')
      .trim()
      .toUpperCase();

    return capture?.captureId && ['COMPLETED', 'CAPTURED', 'PAID'].includes(status);
  });

  if (completedCapture?.captureId) {
    return String(completedCapture.captureId).trim();
  }

  const latestCapture = [...captures].reverse().find((capture) => capture?.captureId);

  return String(latestCapture?.captureId || '').trim();
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

router.get(
  '/admin/courier-guy',
  ...guards,
  requireAdminPermission('shipping.read'),
  async (req, res) => {
    const orders = await Order.find({
      shippingProvider: 'COURIER_GUY',
    })
      .sort({ createdAt: -1 })
      .limit(250)
      .lean();

    return res.render('admin-courier-guy', {
      title: 'Courier Guy Shipments',
      orders,
      baseCurrency: String(process.env.BASE_CURRENCY || 'USD')
        .trim()
        .toUpperCase(),
      fullWidthPage: true,
    });
  },
);

router.post(
  '/admin/courier-guy/:id/create-shipment',
  ...guards,
  requireAdminPermission('shipping.labels.manage'),
  async (req, res) => {
    const order = await findOrder(req.params.id);

    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/admin/courier-guy');
    }

    if (String(order.shippingProvider || '').toUpperCase() !== 'COURIER_GUY') {
      req.flash('error', 'This order did not select The Courier Guy.');
      return res.redirect('/admin/courier-guy');
    }

    const before = order.toObject();

    try {
      order.courierGuy = order.courierGuy || {};
      order.courierGuy.autoCreateStatus = 'PROCESSING';
      order.courierGuy.autoCreateAttemptedAt = new Date();
      order.courierGuy.autoCreateLastError = '';
      await order.save();

      const result = await createCourierGuyShipment(order);
      await saveCourierGuyShipmentToOrder(order, result);
      await pushPaypalTracking(order);

      try {
        await sendOrderProcessingEmail(order);
      } catch (emailError) {
        console.warn('[admin-courier-guy] processing email failed:', emailError.message);
      }

      await logAdminAction(req, {
        action: 'shipping.courier_guy.create_shipment',
        entityType: 'order',
        entityId: String(order._id),
        status: 'success',
        before,
        after: order.toObject(),
        meta: {
          orderId: order.orderId,
          shipmentId: order.courierGuy?.shipmentId,
          serviceLevelId: order.courierGuy?.serviceLevelId,
        },
      });

      req.flash('success', `Courier Guy shipment created for order ${order.orderId}.`);
    } catch (error) {
      order.courierGuy = order.courierGuy || {};
      order.courierGuy.autoCreateStatus = 'FAILED';
      order.courierGuy.autoCreateLastError = String(error?.message || error).slice(0, 500);
      await order.save().catch(() => {});

      await logAdminAction(req, {
        action: 'shipping.courier_guy.create_shipment',
        entityType: 'order',
        entityId: String(order._id),
        status: 'failure',
        before,
        meta: {
          orderId: order.orderId,
          code: error?.code || '',
          error: String(error?.message || error).slice(0, 500),
          shiplogic: error?.shiplogic || null,
        },
      });

      req.flash('error', error?.message || 'Courier Guy shipment creation failed.');
    }

    return res.redirect('/admin/courier-guy');
  },
);

router.post(
  '/admin/courier-guy/:id/refresh-tracking',
  ...guards,
  requireAdminPermission('shipping.update'),
  async (req, res) => {
    const order = await findOrder(req.params.id);

    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/admin/courier-guy');
    }

    const shipmentId = String(order?.courierGuy?.shipmentId || '').trim();

    if (!shipmentId) {
      req.flash('error', 'This order does not have a Courier Guy shipment yet.');
      return res.redirect('/admin/courier-guy');
    }

    try {
      const [shipment, documents] = await Promise.all([
        getCourierGuyShipment(shipmentId),

        getCourierGuyDocuments(shipmentId),
      ]);

      shipment.waybillUrl = documents.waybillUrl || order.courierGuy?.waybillUrl || '';

      shipment.stickerUrl = documents.stickerUrl || order.courierGuy?.stickerUrl || '';

      await saveCourierGuyShipmentToOrder(order, {
        shipment,
        trackingResponse: shipment.raw,
        documents,
      });

      await logAdminAction(req, {
        action: 'shipping.courier_guy.refresh_tracking',
        entityType: 'order',
        entityId: String(order._id),
        status: 'success',
        meta: {
          orderId: order.orderId,
          shipmentId,
          trackingStatus: shipment.status,
        },
      });

      req.flash('success', `Tracking refreshed for order ${order.orderId}.`);
    } catch (error) {
      await logAdminAction(req, {
        action: 'shipping.courier_guy.refresh_tracking',
        entityType: 'order',
        entityId: String(order._id),
        status: 'failure',
        meta: {
          orderId: order.orderId,
          shipmentId,
          error: String(error?.message || error).slice(0, 500),
        },
      });

      req.flash('error', error?.message || 'Could not refresh Courier Guy tracking.');
    }

    return res.redirect('/admin/courier-guy');
  },
);

module.exports = router;
