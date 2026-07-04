// routes/adminCjOrders.js
'use strict';

const express = require('express');
const mongoose = require('mongoose');

const CjOrder = require('../models/CjOrder');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const { logAdminAction } = require('../utils/logAdminAction');

const {
  createCjSupplierOrderForOrderId,
  retryFailedCjSupplierOrder,
} = require('../utils/cj/cjOrderService');

const {
  runAutoCreateCjOrders,
} = require('../utils/cj/autoCreateCjOrders');

const router = express.Router();

/*
 * CJ order creation and supplier-order retries belong to the
 * CJ fulfilment/shipping department.
 *
 * Allowed:
 * - super_admin
 * - shipping_admin with cj.orders.manage
 */
router.use(
  '/admin/cj/orders',
  requireAdmin,
  requireAdminRole(['super_admin', 'shipping_admin']),
  requireAdminPermission('cj.orders.manage'),
);

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function safeError(error) {
  return {
    code: safeString(error?.code || 'CJ_ORDER_ERROR', 100),
    message: safeString(error?.message || 'CJ order action failed.', 1000),
    requestId: safeString(error?.requestId, 200),
  };
}

function getAdminId(req) {
  const value = req.admin?._id || req.session?.admin?._id || null;

  return mongoose.Types.ObjectId.isValid(value)
    ? value
    : null;
}

function buildOrderQuery(req) {
  const query = {
    department: 'CJ',
  };

  const paymentStatus = safeString(req.query.paymentStatus, 30).toUpperCase();
  const fulfillmentStatus = safeString(req.query.fulfillmentStatus, 50).toUpperCase();
  const supplierStatus = safeString(req.query.supplierStatus, 50).toUpperCase();
  const keyword = safeString(req.query.keyword, 100);

  if (
    [
      'CREATED',
      'APPROVED',
      'PENDING',
      'COMPLETED',
      'DECLINED',
      'CANCELLED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'FAILED',
    ].includes(paymentStatus)
  ) {
    query.paymentStatus = paymentStatus;
  }

  if (
    [
      'PENDING',
      'CJ_ORDER_PENDING',
      'CJ_ORDER_CREATED',
      'PROCESSING',
      'SHIPPED',
      'IN_TRANSIT',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
      'CANCELLED',
      'RETURNED',
      'FAILED',
    ].includes(fulfillmentStatus)
  ) {
    query.fulfillmentStatus = fulfillmentStatus;
  }

  if (
    [
      'NOT_CREATED',
      'PENDING',
      'PROCESSING',
      'SUCCESS',
      'FAILED',
    ].includes(supplierStatus)
  ) {
    query['supplierOrder.createStatus'] = supplierStatus;
  }

  if (keyword) {
    query.$or = [
      {
        cjOrderNumber: {
          $regex: keyword,
          $options: 'i',
        },
      },
      {
        customerEmail: {
          $regex: keyword,
          $options: 'i',
        },
      },
      {
        'paypal.orderId': {
          $regex: keyword,
          $options: 'i',
        },
      },
      {
        'paypal.captureId': {
          $regex: keyword,
          $options: 'i',
        },
      },
      {
        'supplierOrder.cjOrderId': {
          $regex: keyword,
          $options: 'i',
        },
      },
      {
        'supplierOrder.cjOrderNumber': {
          $regex: keyword,
          $options: 'i',
        },
      },
    ];
  }

  return query;
}

router.get('/admin/cj/orders', async (req, res) => {
  try {
    const page = safeInteger(req.query.page, 1, 1, 10000);
    const limit = 25;
    const skip = (page - 1) * limit;

    const query = buildOrderQuery(req);

    const [orders, total] = await Promise.all([
      CjOrder.find(query)
        .select(
          [
            'cjOrderNumber',
            'customerEmail',
            'status',
            'paymentStatus',
            'fulfillmentStatus',
            'currency',
            'itemCount',
            'payableTotal',
            'paypal.orderId',
            'paypal.captureId',
            'paypal.captureStatus',
            'supplierOrder.createStatus',
            'supplierOrder.cjOrderId',
            'supplierOrder.cjOrderNumber',
            'supplierOrder.trackingNumber',
            'supplierOrder.lastErrorCode',
            'supplierOrder.lastErrorMessage',
            'paidAt',
            'createdAt',
            'updatedAt',
          ].join(' '),
        )
        .sort({
          createdAt: -1,
        })
        .skip(skip)
        .limit(limit)
        .lean(),

      CjOrder.countDocuments(query),
    ]);

    return res.render('admin/cj/orders', {
      layout: 'layout',
      title: 'CJ Orders',
      active: 'admin-cj-orders',
      fullWidthPage: true,

      orders,

      filters: {
        paymentStatus: safeString(req.query.paymentStatus, 30).toUpperCase(),
        fulfillmentStatus: safeString(req.query.fulfillmentStatus, 50).toUpperCase(),
        supplierStatus: safeString(req.query.supplierStatus, 50).toUpperCase(),
        keyword: safeString(req.query.keyword, 100),
      },

      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    console.error('[CJ orders admin] List failed:', error?.stack || error);

    req.flash('error', 'CJ orders could not be loaded.');

    return res.redirect('/admin/cj');
  }
});

router.post('/admin/cj/orders/run-auto-create', async (req, res) => {
  try {
    const result = await runAutoCreateCjOrders({
      source: 'admin',
    });

    await logAdminAction(req, {
      action: 'cj.orders.auto-create.run',
      entityType: 'CjOrder',
      entityId: 'batch',
      status: 'success',
      adminId: getAdminId(req),
      meta: result,
    });

    req.flash(
      'success',
      `CJ auto-create finished. Success: ${result.success}. Failed: ${result.failed}.`,
    );

    return res.redirect('/admin/cj/orders');
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.orders.auto-create.run',
      entityType: 'CjOrder',
      entityId: 'batch',
      status: 'failure',
      adminId: getAdminId(req),
      meta: safe,
    });

    req.flash('error', `CJ auto-create failed: ${safe.message}`);

    return res.redirect('/admin/cj/orders');
  }
});

router.post('/admin/cj/orders/:orderId/create-supplier-order', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);

  try {
    const result = await createCjSupplierOrderForOrderId(orderId);

    await logAdminAction(req, {
      action: 'cj.order.create-supplier-order',
      entityType: 'CjOrder',
      entityId: orderId,
      status: result.ok ? 'success' : 'failure',
      adminId: getAdminId(req),
      meta: {
        ok: result.ok,
        cj: result.cj || null,
        code: result.code || '',
        message: result.message || '',
      },
    });

    if (result.ok) {
      req.flash('success', 'CJ supplier order created successfully.');
    } else {
      req.flash('error', `CJ supplier order failed: ${result.message}`);
    }

    return res.redirect('/admin/cj/orders');
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.order.create-supplier-order',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'failure',
      adminId: getAdminId(req),
      meta: safe,
    });

    req.flash('error', `CJ supplier order could not be created: ${safe.message}`);

    return res.redirect('/admin/cj/orders');
  }
});

router.post('/admin/cj/orders/:orderId/retry-supplier-order', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);

  try {
    const result = await retryFailedCjSupplierOrder(orderId);

    await logAdminAction(req, {
      action: 'cj.order.retry-supplier-order',
      entityType: 'CjOrder',
      entityId: orderId,
      status: result.ok ? 'success' : 'failure',
      adminId: getAdminId(req),
      meta: {
        ok: result.ok,
        cj: result.cj || null,
        code: result.code || '',
        message: result.message || '',
      },
    });

    if (result.ok) {
      req.flash('success', 'CJ supplier order retry succeeded.');
    } else {
      req.flash('error', `CJ supplier order retry failed: ${result.message}`);
    }

    return res.redirect('/admin/cj/orders');
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.order.retry-supplier-order',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'failure',
      adminId: getAdminId(req),
      meta: safe,
    });

    req.flash('error', `CJ supplier order retry could not run: ${safe.message}`);

    return res.redirect('/admin/cj/orders');
  }
});

module.exports = router;