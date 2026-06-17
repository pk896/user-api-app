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

function isCourierGuyShippedLike(order) {
  const values = [
    order?.courierGuy?.shipmentStatus,
    order?.courierGuy?.trackingStatus,
    order?.shippingTracking?.liveStatus,
    order?.shippingTracking?.status,
  ]
    .map((value) =>
      String(value || '')
        .trim()
        .toUpperCase(),
    )
    .filter(Boolean);

  return values.some((status) =>
    ['COLLECTED', 'SHIPPED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(status),
  );
}

async function pushPaypalTracking(order) {
  const captureId = getLatestCaptureId(order);

  const trackingNumber = String(order?.shippingTracking?.trackingNumber || '').trim();

  if (
    !captureId ||
    !trackingNumber ||
    order?.courierGuy?.paypalTrackingPushedAt ||
    !isCourierGuyShippedLike(order)
  ) {
    return false;
  }

  try {
    const response = await addTrackingToPaypalOrder({
      transactionId: captureId,
      trackingNumber,
      carrier: 'The Courier Guy',
      status:
        String(order?.courierGuy?.shipmentStatus || '').toUpperCase() === 'DELIVERED'
          ? 'DELIVERED'
          : 'SHIPPED',
    });

    order.courierGuy.paypalTrackingPushedAt = new Date();
    order.courierGuy.paypalTrackingLastError = '';
    order.courierGuy.paypalTrackingLastResponse = response;

    await order.save();

    return true;
  } catch (error) {
    order.courierGuy.paypalTrackingLastError = String(error?.message || error).slice(0, 500);

    await order.save().catch(() => {});

    console.warn('[admin-courier-guy] PayPal tracking push failed:', {
      orderId: order.orderId,
      message: error?.message || String(error),
    });

    return false;
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
    const existingOrder = await findOrder(req.params.id);

    if (!existingOrder) {
      req.flash('error', 'Order not found.');

      return res.redirect('/admin/courier-guy');
    }

    if (String(existingOrder.shippingProvider || '').toUpperCase() !== 'COURIER_GUY') {
      req.flash('error', 'This order did not select The Courier Guy.');

      return res.redirect('/admin/courier-guy');
    }

    if (!existingOrder.isPaidLike()) {
      req.flash('error', 'A Courier Guy shipment cannot be created before the order is paid.');

      return res.redirect('/admin/courier-guy');
    }

    if (String(existingOrder?.courierGuy?.shipmentId || '').trim()) {
      req.flash('warning', 'This order already has a Courier Guy shipment.');

      return res.redirect('/admin/courier-guy');
    }

    const before = existingOrder.toObject();

    const order = await Order.findOneAndUpdate(
      {
        _id: existingOrder._id,
        shippingProvider: 'COURIER_GUY',

        $and: [
          {
            $or: [
              {
                status: {
                  $in: [
                    'COMPLETED',
                    'PAID',
                    'SHIPPED',
                    'DELIVERED',
                    'CAPTURED',
                    'completed',
                    'paid',
                    'shipped',
                    'delivered',
                    'captured',
                  ],
                },
              },
              {
                paymentStatus: {
                  $in: ['COMPLETED', 'PAID', 'CAPTURED', 'completed', 'paid', 'captured'],
                },
              },
            ],
          },

          {
            $or: [
              {
                'courierGuy.shipmentId': {
                  $exists: false,
                },
              },
              {
                'courierGuy.shipmentId': '',
              },
              {
                'courierGuy.shipmentId': null,
              },
            ],
          },

          {
            $or: [
              {
                'courierGuy.autoCreateStatus': {
                  $exists: false,
                },
              },
              {
                'courierGuy.autoCreateStatus': {
                  $in: ['PENDING', 'FAILED', null],
                },
              },
            ],
          },
        ],
      },
      {
        $set: {
          'courierGuy.autoCreateStatus': 'PROCESSING',

          'courierGuy.autoCreateAttemptedAt': new Date(),

          'courierGuy.autoCreateLastError': '',
        },

        $inc: {
          'courierGuy.autoCreateAttempts': 1,
        },
      },
      {
        new: true,
      },
    );

    if (!order) {
      req.flash(
        'warning',
        'This shipment is already being created, has already been created, or the order is not eligible.',
      );

      return res.redirect('/admin/courier-guy');
    }

    try {
      const result = await createCourierGuyShipment(order);

      await saveCourierGuyShipmentToOrder(order, result);

      order.courierGuy.autoCreateNextAttemptAt = null;

      await order.save();

      try {
        await sendOrderProcessingEmail(order);
      } catch (emailError) {
        console.warn(
          '[admin-courier-guy] processing email failed:',
          emailError?.message || String(emailError),
        );
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

          serviceCode: order.courierGuy?.serviceCode,
        },
      });

      req.flash('success', `Courier Guy shipment created for order ${order.orderId}.`);
    } catch (error) {
      order.courierGuy = order.courierGuy || {};

      order.courierGuy.autoCreateStatus = 'FAILED';

      order.courierGuy.autoCreateNextAttemptAt = null;

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

      await pushPaypalTracking(order);

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

      const documentErrors = Array.isArray(documents?.errors) ? documents.errors : [];

      if (documentErrors.length) {
        const documentMessage = documentErrors
          .map((item) => {
            return `${item.type}: ${item.message}`;
          })
          .join(' | ')
          .slice(0, 700);

        req.flash(
          'warning',
          `Tracking refreshed, but Courier Guy documents are not available: ${documentMessage}`,
        );
      } else {
        req.flash(
          'success',
          `Tracking and Courier Guy documents refreshed for order ${order.orderId}.`,
        );
      }
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

router.get(
  '/admin/courier-guy/:id/sticker.zpl',
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

    const shipmentId = String(order?.courierGuy?.shipmentId || '').trim();

    if (!shipmentId) {
      req.flash('error', 'This order does not have a Courier Guy shipment yet.');

      return res.redirect('/admin/courier-guy');
    }

    try {
      let stickerZpl = String(order?.courierGuy?.stickerZpl || '');

      if (!stickerZpl.trim()) {
        const documents = await getCourierGuyDocuments(shipmentId);

        stickerZpl = String(documents?.stickerZpl || '');

        if (!stickerZpl.trim()) {
          const errors = Array.isArray(documents?.errors) ? documents.errors : [];

          const message = errors
            .map((item) => {
              return String(item?.message || '').trim();
            })
            .filter(Boolean)
            .join(' | ');

          throw new Error(message || 'Courier Guy did not return printable sticker ZPL.');
        }

        order.courierGuy = order.courierGuy || {};

        order.courierGuy.stickerFormat = 'zpl';

        order.courierGuy.stickerParcels = Array.isArray(documents.stickerParcels)
          ? documents.stickerParcels
          : [];

        order.courierGuy.stickerZpl = stickerZpl;

        order.courierGuy.stickerGeneratedAt = new Date();

        order.courierGuy.documentLastError = '';

        await order.save();
      }

      const safeOrderId = String(order.orderId || order._id || 'courier-guy')
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 100);

      await logAdminAction(req, {
        action: 'shipping.courier_guy.download_sticker',
        entityType: 'order',
        entityId: String(order._id),
        status: 'success',

        meta: {
          orderId: order.orderId,
          shipmentId,
          format: 'zpl',
        },
      });

      res.setHeader('Content-Type', 'application/zpl; charset=utf-8');

      res.setHeader('Content-Disposition', `attachment; filename="courier-guy-${safeOrderId}.zpl"`);

      res.setHeader('Cache-Control', 'private, no-store, max-age=0');

      return res.status(200).send(stickerZpl);
    } catch (error) {
      order.courierGuy = order.courierGuy || {};

      order.courierGuy.documentLastError = String(error?.message || error).slice(0, 1000);

      await order.save().catch(() => {});

      await logAdminAction(req, {
        action: 'shipping.courier_guy.download_sticker',
        entityType: 'order',
        entityId: String(order._id),
        status: 'failure',

        meta: {
          orderId: order.orderId,
          shipmentId,
          code: error?.code || '',
          error: String(error?.message || error).slice(0, 500),
        },
      });

      req.flash('error', error?.message || 'Could not download the Courier Guy sticker.');

      return res.redirect('/admin/courier-guy');
    }
  },
);

module.exports = router;
