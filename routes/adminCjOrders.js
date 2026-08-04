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

const { runAutoCreateCjOrders } = require('../utils/cj/autoCreateCjOrders');

const { calculateCjFreight } = require('../utils/cj/cjLogisticsService');

const { normalizeBuyerTaxId, validateCjBuyerTaxId } = require('../utils/cj/taxIdCountries');

const { normalizeCjIossNumber } = require('../utils/cj/iossCountries');

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

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, parsed));
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function moneyValue(money) {
  if (money && typeof money === 'object') {
    return safeNumber(money.value, 0);
  }

  return safeNumber(money, 0);
}

function money(value, currency) {
  return {
    value: round2(value),

    currency: safeString(currency || process.env.BASE_CURRENCY || 'USD', 3).toUpperCase(),
  };
}

function moneyCurrency(moneyObject, fallback = '') {
  if (moneyObject && typeof moneyObject === 'object') {
    const currency = safeString(moneyObject.currency, 3).toUpperCase();

    if (currency) {
      return currency;
    }
  }

  return safeString(fallback || process.env.BASE_CURRENCY || 'USD', 3).toUpperCase();
}

function plainClone(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function buildAdminShippingAdjustment({
  order,
  originalSelectedShipping,
  selectedShipping,
  adminId,
  quoteRequestId,
}) {
  const originalPaidShippingCurrency = moneyCurrency(
    order?.shippingTotal,
    order?.currency || selectedShipping?.currency,
  );

  const adminShippingCurrency = moneyCurrency(
    selectedShipping?.shippingAmount,
    selectedShipping?.currency || originalPaidShippingCurrency,
  );

  const originalPaidShippingValue = round2(moneyValue(order?.shippingTotal));

  const adminFulfillmentShippingValue = round2(moneyValue(selectedShipping?.shippingAmount));

  const differenceValue = round2(adminFulfillmentShippingValue - originalPaidShippingValue);

  let result = 'EVEN';
  let merchantAction =
    'No shipping adjustment needed. The admin CJ fulfilment shipping matches the customer paid shipping.';

  if (differenceValue > 0) {
    result = 'LOSS';
    merchantAction =
      'Kasyora absorbs the extra CJ fulfilment shipping cost unless the customer is contacted separately.';
  }

  if (differenceValue < 0) {
    result = 'GAIN';
    merchantAction =
      'Kasyora paid less for CJ fulfilment shipping than the customer paid. Admin can keep the difference or refund manually.';
  }

  return {
    source: 'ADMIN_CJ_SHIPPING_RECALCULATION',

    result,

    originalCheckoutShipping: plainClone(originalSelectedShipping),

    adminSelectedShipping: plainClone(selectedShipping),

    originalPaidShippingTotal: money(originalPaidShippingValue, originalPaidShippingCurrency),

    adminFulfillmentShippingAmount: money(adminFulfillmentShippingValue, adminShippingCurrency),

    difference: money(differenceValue, adminShippingCurrency),

    originalPaidPayableTotal: plainClone(order?.payableTotal),

    note: 'Customer paid totals remain unchanged because PayPal was already captured. Admin fulfilment shipping is used only for CJ supplier-order creation and profit/loss tracking.',

    merchantAction,

    quoteRequestId: safeString(quoteRequestId, 200),

    recalculatedAt: new Date(),

    recalculatedBy: safeString(adminId, 100),
  };
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

  return mongoose.Types.ObjectId.isValid(value) ? value : null;
}

function isPaidCompletedCjOrder(order) {
  return (
    safeString(order?.status, 50).toUpperCase() === 'PAID' &&
    safeString(order?.paymentStatus, 50).toUpperCase() === 'COMPLETED'
  );
}

function canEditCjOrderDeliveryDetails(order) {
  const fulfillmentStatus = safeString(order?.fulfillmentStatus, 50).toUpperCase();

  const supplierStatus = safeString(order?.supplierOrder?.createStatus, 50).toUpperCase();

  return (
    isPaidCompletedCjOrder(order) &&
    ['CJ_ORDER_PENDING', 'FAILED'].includes(fulfillmentStatus) &&
    ['PENDING', 'FAILED'].includes(supplierStatus)
  );
}

function adminShippingRecalculationRequired(order) {
  return order?.metadata?.adminShippingRequired === true;
}

async function assertAdminShippingFreshBeforeSupplierAction(orderId) {
  const order = await CjOrder.findOne({
    _id: orderId,
    department: 'CJ',
  })
    .select('cjOrderNumber metadata')
    .lean();

  if (!order) {
    throw new Error('CJ order could not be found.');
  }

  if (adminShippingRecalculationRequired(order)) {
    throw new Error(
      'Recalculate CJ Shipping and save a fresh CJ shipping method before creating or retrying the CJ supplier order.',
    );
  }

  return true;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function digitsOnly(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, maxLength);
}

function normalizePhone(value) {
  return safeString(value, 50).replace(/[^\d+()\-\s]/g, '');
}

function normalizeCjSouthAfricaPhone(value) {
  let digits = digitsOnly(value, 20);

  if (digits.startsWith('0027')) {
    digits = digits.slice(2);
  }

  if (/^27\d{9}$/.test(digits)) {
    return digits;
  }

  if (/^0\d{9}$/.test(digits)) {
    return digits.slice(1);
  }

  if (/^\d{9}$/.test(digits)) {
    return digits;
  }

  return '';
}

function isGloballyUsablePhone(value) {
  const digits = digitsOnly(value, 30);

  return digits.length >= 6 && digits.length <= 20;
}

function buildEditableOrderSelectFields() {
  return [
    'cjOrderNumber',
    'customerEmail',
    'status',
    'paymentStatus',
    'fulfillmentStatus',
    'currency',
    'supplierOrder.createStatus',
    'supplierOrder.lastErrorCode',
    'supplierOrder.lastErrorMessage',
    'paypal.captureId',
    'paypal.captureStatus',
    'metadata',

    'deliveryAddress.firstName',
    'deliveryAddress.lastName',
    'deliveryAddress.email',
    'deliveryAddress.phone',
    'deliveryAddress.companyName',
    'deliveryAddress.addressLine1',
    'deliveryAddress.addressLine2',
    'deliveryAddress.houseNumber',
    'deliveryAddress.suburb',
    'deliveryAddress.city',
    'deliveryAddress.province',
    'deliveryAddress.postalCode',
    'deliveryAddress.countryCode',
    '+deliveryAddress.taxId',
    '+deliveryAddress.iossNumber',

    'createdAt',
    'updatedAt',
  ].join(' ');
}

function buildAdminShippingOrderSelectFields() {
  return [
    'cjOrderNumber',
    'customerEmail',
    'status',
    'paymentStatus',
    'fulfillmentStatus',
    'currency',
    'items',
    'itemCount',
    'productTotalIncVat',
    'shippingTotal',
    'payableTotal',
    'selectedShipping',
    'supplierOrder.createStatus',
    'supplierOrder.lastErrorCode',
    'supplierOrder.lastErrorMessage',
    'paypal.captureId',
    'paypal.captureStatus',

    'deliveryAddress.firstName',
    'deliveryAddress.lastName',
    'deliveryAddress.email',
    'deliveryAddress.phone',
    'deliveryAddress.companyName',
    'deliveryAddress.addressLine1',
    'deliveryAddress.addressLine2',
    'deliveryAddress.houseNumber',
    'deliveryAddress.suburb',
    'deliveryAddress.city',
    'deliveryAddress.province',
    'deliveryAddress.postalCode',
    'deliveryAddress.countryCode',
    '+deliveryAddress.taxId',
    '+deliveryAddress.iossNumber',

    'metadata',
    'createdAt',
    'updatedAt',
  ].join(' ');
}

function normalizeShippingMethodIdentity(value) {
  return safeString(value, 300).toLowerCase().replace(/\s+/g, ' ');
}

function shippingOptionMatchesSavedMethod(option, savedShipping) {
  if (!option || !savedShipping) {
    return false;
  }

  const optionIdentifiers = [option.id, option.optionId, option.logisticsOptionId, option.channelId]
    .map((value) => safeString(value, 300))
    .filter(Boolean);

  const savedIdentifiers = [
    savedShipping.id,
    savedShipping.optionId,
    savedShipping.logisticsOptionId,
    savedShipping.channelId,
  ]
    .map((value) => safeString(value, 300))
    .filter(Boolean);

  const hasMatchingIdentifier = optionIdentifiers.some((identifier) => {
    return savedIdentifiers.includes(identifier);
  });

  if (hasMatchingIdentifier) {
    return true;
  }

  const optionName = normalizeShippingMethodIdentity(option.logisticsName);

  const savedName = normalizeShippingMethodIdentity(savedShipping.logisticsName);

  if (!optionName || !savedName || optionName !== savedName) {
    return false;
  }

  const optionModel = normalizeShippingMethodIdentity(option.logisticsModel);

  const savedModel = normalizeShippingMethodIdentity(savedShipping.logisticsModel);

  /*
   * When both methods have a logistics model, require the models
   * to match as well. If CJ did not supply a model on either side,
   * the matching logistics name is the safest available fallback.
   */
  if (optionModel && savedModel) {
    return optionModel === savedModel;
  }

  return true;
}

function normalizeAdminQuoteOptions(
  options,
  productTotalIncVat,
  { customerPaidShippingValue = 0, customerPaidShippingCurrency = '', savedShipping = null } = {},
) {
  const paidShippingValue = round2(Math.max(0, safeNumber(customerPaidShippingValue, 0)));

  const paidShippingCurrency = moneyCurrency(
    {
      currency: customerPaidShippingCurrency,
    },
    process.env.BASE_CURRENCY || 'USD',
  );

  const normalizedOptions = (Array.isArray(options) ? options : []).map((option) => {
    const shippingAmount = round2(option?.freight?.value);

    const currency = safeString(
      option?.freight?.currency || process.env.BASE_CURRENCY || 'USD',
      3,
    ).toUpperCase();

    const sameCurrency = currency === paidShippingCurrency;

    const isWithinCustomerPaidShipping =
      sameCurrency && shippingAmount <= paidShippingValue + 0.009;

    const normalizedOption = {
      id: safeString(option?.id, 300),

      logisticsName: safeString(option?.logisticsName, 300),

      logisticsModel: safeString(option?.logisticsModel, 200),

      deliveryEstimate: safeString(option?.deliveryEstimate, 100),

      optionId: safeString(option?.optionId, 300),

      logisticsOptionId: safeString(option?.optionId || option?.id || option?.channelId, 300),

      channelId: safeString(option?.channelId, 300),

      freightUsd: round2(option?.freightUsd),

      shippingAmount,

      currency,

      taxesFeeUsd: round2(option?.taxesFeeUsd),

      clearanceOperationFeeUsd: round2(option?.clearanceOperationFeeUsd),

      tariffUsd: round2(option?.tariffUsd),

      remoteFeeUsd: round2(option?.remoteFeeUsd),

      message: safeString(option?.message, 1000),

      fxSnapshot: {
        rate: Number(option?.fxSnapshot?.rate || 0),

        from: safeString(option?.fxSnapshot?.from || 'USD', 3).toUpperCase(),

        to: safeString(
          option?.fxSnapshot?.to || process.env.BASE_CURRENCY || 'USD',
          3,
        ).toUpperCase(),

        provider: safeString(option?.fxSnapshot?.provider, 100),

        convertedAt: option?.fxSnapshot?.convertedAt || new Date().toISOString(),
      },

      productTotalIncVat: round2(productTotalIncVat),

      payableTotal: round2(productTotalIncVat + shippingAmount),

      customerPaidShippingValue: paidShippingValue,

      customerPaidShippingCurrency: paidShippingCurrency,

      isWithinCustomerPaidShipping,

      isSameAsPreviousShipping: false,

      isRecommended: false,

      recommendationReason: '',
    };

    normalizedOption.isSameAsPreviousShipping = shippingOptionMatchesSavedMethod(
      normalizedOption,
      savedShipping,
    );

    return normalizedOption;
  });

  /*
   * CJ logistics service already returns options from cheapest
   * to most expensive, but sort again here so this admin rule
   * does not depend on another service's ordering.
   */
  normalizedOptions.sort((left, right) => {
    return safeNumber(left?.shippingAmount, 0) - safeNumber(right?.shippingAmount, 0);
  });

  const eligibleOptions = normalizedOptions.filter(
    (option) => option.isWithinCustomerPaidShipping === true,
  );

  /*
   * Recommendation priority:
   *
   * 1. The exact previously selected method, when CJ still offers it
   *    and its fresh price is not above what the customer paid.
   * 2. Otherwise, the cheapest method that does not exceed the
   *    customer's paid shipping amount.
   */
  const matchingPreviousOption = eligibleOptions.find(
    (option) => option.isSameAsPreviousShipping === true,
  );

  const recommendedOption = matchingPreviousOption || eligibleOptions[0] || null;

  if (recommendedOption) {
    recommendedOption.isRecommended = true;

    recommendedOption.recommendationReason = matchingPreviousOption
      ? 'Same method previously selected by the customer'
      : 'Cheapest method within the customer-paid shipping limit';
  }

  return normalizedOptions;
}

function getAdminCjShippingQuoteStore(req) {
  if (!req.session.adminCjShippingQuotes || typeof req.session.adminCjShippingQuotes !== 'object') {
    req.session.adminCjShippingQuotes = {};
  }

  return req.session.adminCjShippingQuotes;
}

function buildSelectedShippingFromAdminQuote(quote, selectedOption) {
  const currency = safeString(
    selectedOption?.currency || quote?.currency || process.env.BASE_CURRENCY || 'USD',
    3,
  ).toUpperCase();

  const shippingAmount = round2(selectedOption?.shippingAmount);

  const productTotalIncVat = round2(quote?.productTotalIncVat);

  const payableTotal = round2(productTotalIncVat + shippingAmount);

  return {
    source: 'CJ',

    id: safeString(selectedOption?.id, 300),

    logisticsName: safeString(selectedOption?.logisticsName, 300),

    logisticsModel: safeString(selectedOption?.logisticsModel, 200),

    deliveryEstimate: safeString(selectedOption?.deliveryEstimate, 100),

    optionId: safeString(selectedOption?.optionId, 300),

    logisticsOptionId: safeString(
      selectedOption?.logisticsOptionId ||
        selectedOption?.optionId ||
        selectedOption?.id ||
        selectedOption?.channelId,
      300,
    ),

    channelId: safeString(selectedOption?.channelId, 300),

    originCountryCode: safeString(quote?.originCountryCode, 2).toUpperCase(),

    destinationCountryCode: safeString(quote?.destinationCountryCode, 2).toUpperCase(),

    shippingAmount: money(shippingAmount, currency),

    freightUsd: money(selectedOption?.freightUsd, 'USD'),

    currency,

    productTotalIncVat: money(productTotalIncVat, currency),

    payableTotal: money(payableTotal, currency),

    taxesFeeUsd: money(selectedOption?.taxesFeeUsd, 'USD'),

    clearanceOperationFeeUsd: money(selectedOption?.clearanceOperationFeeUsd, 'USD'),

    tariffUsd: money(selectedOption?.tariffUsd, 'USD'),

    remoteFeeUsd: money(selectedOption?.remoteFeeUsd, 'USD'),

    message: safeString(selectedOption?.message, 1000),

    fxSnapshot: {
      rate: Number(selectedOption?.fxSnapshot?.rate || 0),

      from: safeString(selectedOption?.fxSnapshot?.from || 'USD', 3).toUpperCase(),

      to: safeString(
        selectedOption?.fxSnapshot?.to || process.env.BASE_CURRENCY || 'USD',
        3,
      ).toUpperCase(),

      provider: safeString(selectedOption?.fxSnapshot?.provider, 100),

      convertedAt: selectedOption?.fxSnapshot?.convertedAt
        ? new Date(selectedOption.fxSnapshot.convertedAt)
        : new Date(),
    },

    quoteRequestId: safeString(quote?.requestId, 200),

    quoteExpiresAt: quote?.expiresAt ? new Date(quote.expiresAt) : null,

    selectedAt: new Date(),

    selectedByAdmin: true,
  };
}

function normalizeAdminCjDeliveryEdit(body = {}, countryCode = '') {
  const address = {
    firstName: safeString(body.firstName, 100),
    lastName: safeString(body.lastName, 100),
    email: safeString(body.email, 320).toLowerCase(),
    phone: normalizePhone(body.phone),
    companyName: safeString(body.companyName, 200),
    addressLine1: safeString(body.addressLine1, 300),
    addressLine2: safeString(body.addressLine2, 300),
    houseNumber: safeString(body.houseNumber, 100),
    suburb: safeString(body.suburb, 200),
    city: safeString(body.city, 200),
    province: safeString(body.province, 200),
    postalCode: safeString(body.postalCode, 50),
    countryCode: safeString(countryCode, 2).toUpperCase(),
    taxId: normalizeBuyerTaxId(body.taxId),
    iossNumber: normalizeCjIossNumber(body.iossNumber),
  };

  if (!address.firstName) {
    throw new Error('First name is required.');
  }

  if (!address.lastName) {
    throw new Error('Last name is required.');
  }

  if (!address.email || !validEmail(address.email)) {
    throw new Error('A valid email address is required.');
  }

  if (!address.phone) {
    throw new Error('Phone number is required.');
  }

  if (address.countryCode === 'ZA') {
    const cjPhone = normalizeCjSouthAfricaPhone(address.phone);

    if (!cjPhone) {
      throw new Error(
        'For South Africa CJ delivery, enter a valid phone number like 0632207320, 632207320, or 27632207320.',
      );
    }

    address.phone = cjPhone;
  } else if (!isGloballyUsablePhone(address.phone)) {
    throw new Error('Enter a reachable delivery phone number with 6 to 20 digits.');
  }

  if (!address.province) {
    throw new Error('Province or state is required.');
  }

  if (!address.city) {
    throw new Error('City is required.');
  }

  if (!address.addressLine1) {
    throw new Error('Street address is required.');
  }

  if (!address.postalCode) {
    throw new Error('Postal code is required.');
  }

  const taxIdValidation = validateCjBuyerTaxId(address.countryCode, address.taxId);

  if (!taxIdValidation.ok) {
    throw new Error(
      taxIdValidation.message || 'This destination requires a valid buyer Tax ID / Consignee ID.',
    );
  }

  if (taxIdValidation.required) {
    address.taxId = taxIdValidation.normalized;
  }

  return address;
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

  if (['NOT_CREATED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'].includes(supplierStatus)) {
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
            'metadata.adminShippingRequired',
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

router.get('/admin/cj/orders/:orderId/edit', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);

  try {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      req.flash('error', 'Invalid CJ order ID.');

      return res.redirect('/admin/cj/orders');
    }

    const order = await CjOrder.findOne({
      _id: orderId,
      department: 'CJ',
    })
      .select(buildEditableOrderSelectFields())
      .lean();

    if (!order) {
      req.flash('error', 'CJ order could not be found.');

      return res.redirect('/admin/cj/orders');
    }

    if (!canEditCjOrderDeliveryDetails(order)) {
      req.flash(
        'error',
        'This CJ order can no longer be edited because its supplier order is not pending or failed.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}`);
    }

    return res.render('admin/cj/order-edit', {
      layout: 'layout',
      title: `Edit CJ Order ${order.cjOrderNumber}`,
      active: 'admin-cj-orders',
      fullWidthPage: true,
      order,
    });
  } catch (error) {
    console.error('[CJ orders admin] Edit page failed:', error?.stack || error);

    req.flash('error', 'CJ order edit page could not be loaded.');

    return res.redirect('/admin/cj/orders');
  }
});

router.post('/admin/cj/orders/:orderId/edit', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);
  const redirectTo = mongoose.Types.ObjectId.isValid(orderId)
    ? `/admin/cj/orders/${encodeURIComponent(orderId)}`
    : '/admin/cj/orders';

  try {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      req.flash('error', 'Invalid CJ order ID.');

      return res.redirect('/admin/cj/orders');
    }

    const order = await CjOrder.findOne({
      _id: orderId,
      department: 'CJ',
    }).select(buildEditableOrderSelectFields());

    if (!order) {
      req.flash('error', 'CJ order could not be found.');

      return res.redirect('/admin/cj/orders');
    }

    if (!canEditCjOrderDeliveryDetails(order)) {
      req.flash(
        'error',
        'This CJ order can no longer be edited because its supplier order is not pending or failed.',
      );

      return res.redirect(redirectTo);
    }

    const countryCode = safeString(order.deliveryAddress?.countryCode, 2).toUpperCase();

    const address = normalizeAdminCjDeliveryEdit(req.body, countryCode);

    order.deliveryAddress.firstName = address.firstName;
    order.deliveryAddress.lastName = address.lastName;
    order.deliveryAddress.email = address.email;
    order.deliveryAddress.phone = address.phone;
    order.deliveryAddress.companyName = address.companyName;
    order.deliveryAddress.addressLine1 = address.addressLine1;
    order.deliveryAddress.addressLine2 = address.addressLine2;
    order.deliveryAddress.houseNumber = address.houseNumber;
    order.deliveryAddress.suburb = address.suburb;
    order.deliveryAddress.city = address.city;
    order.deliveryAddress.province = address.province;
    order.deliveryAddress.postalCode = address.postalCode;
    order.deliveryAddress.taxId = address.taxId;
    order.deliveryAddress.iossNumber = address.iossNumber;

    /*
     * Keep customerEmail aligned with the editable delivery email
     * so the admin list and detail page show the same customer email.
     */
    order.customerEmail = address.email;

    /*
     * Delivery details changed after the customer paid.
     * Force admin to recalculate CJ shipping before creating/retrying
     * the CJ supplier order.
     */
    if (!order.metadata || typeof order.metadata !== 'object') {
      order.metadata = {};
    }

    order.metadata.adminDeliveryEditedAt = new Date();
    order.metadata.adminShippingRequired = true;

    await order.save();

    await logAdminAction(req, {
      action: 'cj.order.delivery-details.edit',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'success',
      adminId: getAdminId(req),
      meta: {
        cjOrderNumber: order.cjOrderNumber,
        fulfillmentStatus: order.fulfillmentStatus,
        supplierOrderStatus: order.supplierOrder?.createStatus || '',
        countryCode,
        editedFields: ['deliveryAddress', 'taxId', 'iossNumber'],
      },
    });

    req.flash(
      'success',
      'CJ order delivery details updated. You must now save a fresh CJ shipping method before the supplier order can be created or retried.',
    );

    /*
     * Continue directly into the mandatory shipping recalculation.
     * The supplier-order service remains blocked until an eligible
     * fresh method is selected and adminShippingRequired becomes false.
     */
    return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.order.delivery-details.edit',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'failure',
      adminId: getAdminId(req),
      meta: safe,
    });

    req.flash('error', `CJ order delivery details could not be updated: ${safe.message}`);

    return res.redirect(
      mongoose.Types.ObjectId.isValid(orderId)
        ? `/admin/cj/orders/${encodeURIComponent(orderId)}/edit`
        : '/admin/cj/orders',
    );
  }
});

router.get('/admin/cj/orders/:orderId/shipping', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);

  try {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      req.flash('error', 'Invalid CJ order ID.');

      return res.redirect('/admin/cj/orders');
    }

    const order = await CjOrder.findOne({
      _id: orderId,
      department: 'CJ',
    })
      .select(buildAdminShippingOrderSelectFields())
      .lean();

    if (!order) {
      req.flash('error', 'CJ order could not be found.');

      return res.redirect('/admin/cj/orders');
    }

    if (!canEditCjOrderDeliveryDetails(order)) {
      req.flash(
        'error',
        'CJ shipping can only be recalculated while the supplier order is pending or failed.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}`);
    }

    const address = order.deliveryAddress || {};

    const freight = await calculateCjFreight({
      cartItems: order.items,

      destinationCountryCode: address.countryCode,

      postalCode: address.postalCode,

      houseNumber: address.houseNumber,

      taxId: address.taxId,

      iossNumber: address.iossNumber,

      originCountryCode: order.selectedShipping?.originCountryCode,
    });

    const productTotalIncVat = round2(moneyValue(order.productTotalIncVat));

    /*
     * The limit comes from shippingTotal because that is the
     * shipping amount included in the already captured customer order.
     *
     * Do not use selectedShipping.shippingAmount as the limit because
     * selectedShipping can later be replaced by an admin fulfilment
     * method while shippingTotal must remain the original paid amount.
     */
    const customerPaidShippingValue = round2(moneyValue(order.shippingTotal));

    const customerPaidShippingCurrency = moneyCurrency(
      order.shippingTotal,
      order.currency || process.env.BASE_CURRENCY || 'USD',
    );

    const options = normalizeAdminQuoteOptions(freight.options, productTotalIncVat, {
      customerPaidShippingValue,
      customerPaidShippingCurrency,
      savedShipping: order.selectedShipping,
    });

    if (!options.length) {
      req.flash(
        'error',
        'CJ did not return any available shipping methods for the edited delivery details.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}`);
    }

    const eligibleOptions = options.filter(
      (option) => option.isWithinCustomerPaidShipping === true,
    );

    const recommendedOption =
      eligibleOptions.find((option) => option.isRecommended === true) || null;

    const quote = {
      source: 'CJ',

      requestId: safeString(freight.requestId, 200),

      originCountryCode: safeString(freight.originCountryCode, 2),

      destinationCountryCode: safeString(freight.destinationCountryCode, 2),

      currency: safeString(process.env.BASE_CURRENCY || order.currency || 'USD', 3).toUpperCase(),

      productTotalIncVat,

      customerPaidShippingValue,

      customerPaidShippingCurrency,

      eligibleOptionIds: eligibleOptions
        .map((option) => safeString(option.id, 300))
        .filter(Boolean),

      recommendedOptionId: safeString(recommendedOption?.id, 300),

      options,

      quotedAt: new Date().toISOString(),

      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    const quoteStore = getAdminCjShippingQuoteStore(req);

    quoteStore[orderId] = quote;

    return req.session.save((saveError) => {
      if (saveError) {
        console.error('[CJ orders admin] Shipping quote session save failed:', saveError);

        req.flash(
          'error',
          'CJ shipping was calculated but could not be saved for admin selection. Please try again.',
        );

        return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}`);
      }

      return res.render('admin/cj/order-shipping', {
        layout: 'layout',
        title: `Recalculate CJ Shipping ${order.cjOrderNumber}`,
        active: 'admin-cj-orders',
        fullWidthPage: true,
        order,
        quote,
      });
    });
  } catch (error) {
    console.error('[CJ orders admin] Shipping recalculation failed:', error?.stack || error);

    req.flash(
      'error',
      `CJ shipping could not be recalculated: ${safeString(error?.message || error, 1000)}`,
    );

    return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}`);
  }
});

router.post('/admin/cj/orders/:orderId/shipping/select', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);
  const optionId = safeString(req.body?.optionId, 300);

  const redirectTo = mongoose.Types.ObjectId.isValid(orderId)
    ? `/admin/cj/orders/${encodeURIComponent(orderId)}`
    : '/admin/cj/orders';

  try {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      req.flash('error', 'Invalid CJ order ID.');

      return res.redirect('/admin/cj/orders');
    }

    if (!optionId) {
      req.flash('error', 'Please select a CJ shipping method.');

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    const quoteStore = getAdminCjShippingQuoteStore(req);

    const quote = quoteStore[orderId];

    const quoteExpiresAt = quote?.expiresAt ? new Date(quote.expiresAt) : null;

    if (
      !quote ||
      !Array.isArray(quote.options) ||
      !quote.options.length ||
      !quoteExpiresAt ||
      Number.isNaN(quoteExpiresAt.getTime()) ||
      quoteExpiresAt.getTime() <= Date.now()
    ) {
      req.flash(
        'error',
        'The admin CJ shipping quote expired. Please recalculate CJ shipping again.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    const selectedOption = quote.options.find((option) => {
      return safeString(option?.id, 300) === optionId;
    });

    if (!selectedOption) {
      req.flash('error', 'The selected CJ shipping method is no longer available.');

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    const order = await CjOrder.findOne({
      _id: orderId,
      department: 'CJ',
    }).select(buildAdminShippingOrderSelectFields());

    if (!order) {
      req.flash('error', 'CJ order could not be found.');

      return res.redirect('/admin/cj/orders');
    }

    if (!canEditCjOrderDeliveryDetails(order)) {
      req.flash(
        'error',
        'CJ shipping can no longer be changed because the supplier order is not pending or failed.',
      );

      return res.redirect(redirectTo);
    }

    const customerPaidShippingValue = round2(moneyValue(order.shippingTotal));

    const customerPaidShippingCurrency = moneyCurrency(
      order.shippingTotal,
      order.currency || process.env.BASE_CURRENCY || 'USD',
    );

    const selectedShippingValue = round2(safeNumber(selectedOption.shippingAmount, 0));

    const selectedShippingCurrency = moneyCurrency(
      {
        currency: selectedOption.currency || quote.currency,
      },
      process.env.BASE_CURRENCY || 'USD',
    );

    if (selectedShippingCurrency !== customerPaidShippingCurrency) {
      req.flash(
        'error',
        'The selected CJ shipping currency does not match the currency used for the customer-paid shipping amount. Please recalculate shipping.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    if (
      selectedOption.isWithinCustomerPaidShipping !== true ||
      selectedShippingValue > customerPaidShippingValue + 0.009
    ) {
      req.flash(
        'error',
        `You cannot select this CJ shipping method because it costs more than the shipping amount paid by the customer. Select a method costing no more than ${customerPaidShippingCurrency} ${customerPaidShippingValue.toFixed(2)}.`,
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    const eligibleOptionIds = Array.isArray(quote.eligibleOptionIds)
      ? quote.eligibleOptionIds.map((value) => safeString(value, 300)).filter(Boolean)
      : [];

    if (!eligibleOptionIds.includes(safeString(selectedOption.id, 300))) {
      req.flash(
        'error',
        'The selected CJ shipping method is not an approved option from the fresh admin shipping quote.',
      );

      return res.redirect(`/admin/cj/orders/${encodeURIComponent(orderId)}/shipping`);
    }

    const selectedShipping = buildSelectedShippingFromAdminQuote(quote, selectedOption);

    const originalSelectedShipping = plainClone(order.selectedShipping);

    /*
     * Important:
     * We update only the selected CJ logistics method used for supplier-order creation.
     * We do not change paid totals, PayPal amount, products, VAT, or the customer's paid order total.
     */
    order.selectedShipping = selectedShipping;

    if (!order.metadata || typeof order.metadata !== 'object') {
      order.metadata = {};
    }

    const adminId = getAdminId(req);

    order.metadata.adminShippingRecalculatedAt = new Date();
    order.metadata.adminShippingQuoteRequestId = safeString(quote.requestId, 200);
    order.metadata.adminShippingRecalculatedBy = safeString(adminId, 100);
    order.metadata.adminShippingRequired = false;

    order.metadata.adminShippingAdjustment = buildAdminShippingAdjustment({
      order,
      originalSelectedShipping,
      selectedShipping,
      adminId,
      quoteRequestId: quote.requestId,
    });

    await order.save();

    delete quoteStore[orderId];

    await new Promise((resolve, reject) => {
      req.session.save((saveError) => {
        if (saveError) return reject(saveError);

        return resolve();
      });
    });

    await logAdminAction(req, {
      action: 'cj.order.shipping.recalculate-select',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'success',
      adminId: getAdminId(req),
      meta: {
        cjOrderNumber: order.cjOrderNumber,
        quoteRequestId: quote.requestId,
        logisticsName: selectedShipping.logisticsName,
        shippingAmount: selectedShipping.shippingAmount?.value || 0,
        currency: selectedShipping.shippingAmount?.currency || selectedShipping.currency,
        shippingAdjustment: order.metadata?.adminShippingAdjustment || null,
      },
    });

    req.flash(
      'success',
      'Fresh CJ shipping method saved. You can now create or retry the CJ supplier order.',
    );

    return res.redirect(redirectTo);
  } catch (error) {
    const safe = safeError(error);

    await logAdminAction(req, {
      action: 'cj.order.shipping.recalculate-select',
      entityType: 'CjOrder',
      entityId: orderId,
      status: 'failure',
      adminId: getAdminId(req),
      meta: safe,
    });

    req.flash('error', `CJ shipping method could not be saved: ${safe.message}`);

    return res.redirect(redirectTo);
  }
});

router.get('/admin/cj/orders/:orderId', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);

  try {
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      req.flash('error', 'Invalid CJ order ID.');

      return res.redirect('/admin/cj/orders');
    }

    const order = await CjOrder.findOne({
      _id: orderId,
      department: 'CJ',
    })
      .select(
        [
          'cjOrderNumber',
          'customerEmail',
          'status',
          'paymentStatus',
          'fulfillmentStatus',
          'currency',

          /*
           * CJ always has zero Kasyora-added VAT.
           * Retained for compatibility with historical orders.
           */
          'vatRate',

          'items',
          'itemCount',

          /*
           * New authoritative VAT-free CJ product total.
           */
          'productTotal',

          /*
           * Historical zero-VAT compatibility fields.
           */
          'productSubtotalExVat',
          'productVatAmount',
          'productTotalIncVat',

          'shippingTotal',
          'payableTotal',

          /*
           * Do not select the complete deliveryAddress parent together
           * with its child fields because MongoDB treats that as a path
           * collision. Select each address field explicitly.
           *
           * taxId and iossNumber are select:false in models/CjOrder.js,
           * so they must use the leading "+".
           */
          'deliveryAddress.firstName',
          'deliveryAddress.lastName',
          'deliveryAddress.email',
          'deliveryAddress.phone',
          'deliveryAddress.companyName',
          'deliveryAddress.addressLine1',
          'deliveryAddress.addressLine2',
          'deliveryAddress.houseNumber',
          'deliveryAddress.suburb',
          'deliveryAddress.city',
          'deliveryAddress.province',
          'deliveryAddress.postalCode',
          'deliveryAddress.countryCode',
          '+deliveryAddress.taxId',
          '+deliveryAddress.iossNumber',

          'selectedShipping',
          'payer',
          'paypal.orderId',
          'paypal.orderStatus',
          'paypal.captureId',
          'paypal.captureStatus',
          'paypal.amount',
          'paypal.capturedAt',
          'paypal.purchaseUnitReferenceId',
          'paypal.customId',
          'paypal.invoiceId',
          'supplierOrder',
          'tracking',
          'metadata',
          'paidAt',
          'cancelledAt',
          'lastPaymentErrorCode',
          'lastPaymentErrorMessage',
          'createdAt',
          'updatedAt',
        ].join(' '),
      )
      .lean();

    if (!order) {
      req.flash('error', 'CJ order could not be found.');

      return res.redirect('/admin/cj/orders');
    }

    return res.render('admin/cj/order-details', {
      layout: 'layout',
      title: `CJ Order ${order.cjOrderNumber}`,
      active: 'admin-cj-orders',
      fullWidthPage: true,
      order,
    });
  } catch (error) {
    console.error('[CJ orders admin] Detail failed:', error?.stack || error);

    req.flash('error', 'CJ order details could not be loaded.');

    return res.redirect('/admin/cj/orders');
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
  const redirectTo = mongoose.Types.ObjectId.isValid(orderId)
    ? `/admin/cj/orders/${encodeURIComponent(orderId)}`
    : '/admin/cj/orders';

  try {
    await assertAdminShippingFreshBeforeSupplierAction(orderId);

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

    return res.redirect(redirectTo);
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

    return res.redirect(redirectTo);
  }
});

router.post('/admin/cj/orders/:orderId/retry-supplier-order', async (req, res) => {
  const orderId = safeString(req.params.orderId, 100);
  const redirectTo = mongoose.Types.ObjectId.isValid(orderId)
    ? `/admin/cj/orders/${encodeURIComponent(orderId)}`
    : '/admin/cj/orders';

  try {
    await assertAdminShippingFreshBeforeSupplierAction(orderId);

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

    return res.redirect(redirectTo);
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

    return res.redirect(redirectTo);
  }
});

module.exports = router;
