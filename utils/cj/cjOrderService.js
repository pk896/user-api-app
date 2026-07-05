// utils/cj/cjOrderService.js
'use strict';

const mongoose = require('mongoose');

const CjOrder = require('../../models/CjOrder');
const { cjRequest } = require('./cjClient');

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeInteger(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(100, parsed));
}

function booleanFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();

  if (['true', '1', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['false', '0', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallback;
}

function digitsOnly(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, maxLength);
}

function normalizeCjSouthAfricaPhone(value) {
  let digits = digitsOnly(value, 20);

  if (digits.startsWith('0027')) {
    digits = digits.slice(2);
  }

  /*
   * CJ South Africa accepts either:
   * - 9 digits without the leading zero, example: 632207320
   * - 11 digits beginning with 27, example: 27632207320
   */
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

function normalizeCjSouthAfricaConsigneeId(value) {
  const digits = digitsOnly(value, 20);

  return /^\d{13}$/.test(digits) ? digits : '';
}

function normalizeCjPhoneForOrder(address) {
  const countryCode = safeString(address?.countryCode, 2).toUpperCase();

  if (countryCode === 'ZA') {
    return normalizeCjSouthAfricaPhone(address?.phone);
  }

  return safeString(address?.phone, 20);
}

function normalizeCjTaxIdForOrder(address) {
  const countryCode = safeString(address?.countryCode, 2).toUpperCase();

  if (countryCode === 'ZA') {
    return normalizeCjSouthAfricaConsigneeId(address?.taxId);
  }

  return safeString(address?.taxId, 20);
}

function createCjOrderError(code, message, status = 400) {
  const error = new Error(message);

  error.code = code;
  error.status = status;

  return error;
}

function countryNameFromCode(countryCode) {
  const code = safeString(countryCode, 2).toUpperCase();

  if (!/^[A-Z]{2}$/.test(code)) {
    return '';
  }

  try {
    if (typeof Intl.DisplayNames === 'function') {
      const displayNames = new Intl.DisplayNames(['en'], {
        type: 'region',
      });

      return safeString(displayNames.of(code), 50) || code;
    }
  } catch {
    // Ignore and return the country code below.
  }

  return code;
}

function moneyValue(money) {
  if (money && typeof money === 'object') {
    return safeNumber(money.value, 0);
  }

  return safeNumber(money, 0);
}

function assertOrderCanBeSentToCj(order) {
  if (!order) {
    throw createCjOrderError('CJ_ORDER_NOT_FOUND', 'The CJ order could not be found.', 404);
  }

  if (String(order.department || '').toUpperCase() !== 'CJ') {
    throw createCjOrderError(
      'CJ_ORDER_DEPARTMENT_INVALID',
      'This is not a CJ department order.',
      409,
    );
  }

  if (String(order.status || '').toUpperCase() !== 'PAID') {
    throw createCjOrderError(
      'CJ_ORDER_NOT_PAID',
      'The CJ supplier order can only be created after the local CJ order is paid.',
      409,
    );
  }

  if (String(order.paymentStatus || '').toUpperCase() !== 'COMPLETED') {
    throw createCjOrderError(
      'CJ_PAYMENT_NOT_COMPLETED',
      'The CJ supplier order can only be created after PayPal payment is completed.',
      409,
    );
  }

  if (String(order.fulfillmentStatus || '').toUpperCase() !== 'CJ_ORDER_PENDING') {
    throw createCjOrderError(
      'CJ_FULFILLMENT_NOT_READY',
      'The CJ supplier order is not ready for CJ fulfilment.',
      409,
    );
  }

  const supplierCreateStatus = String(order.supplierOrder?.createStatus || '').toUpperCase();

  if (!['PENDING', 'PROCESSING'].includes(supplierCreateStatus)) {
    throw createCjOrderError(
      'CJ_SUPPLIER_ORDER_NOT_READY',
      'The CJ supplier order is not ready for creation.',
      409,
    );
  }

  if (!Array.isArray(order.items) || !order.items.length) {
    throw createCjOrderError(
      'CJ_ORDER_ITEMS_MISSING',
      'The CJ order does not contain any products.',
      409,
    );
  }

  if (!order.deliveryAddress || typeof order.deliveryAddress !== 'object') {
    throw createCjOrderError(
      'CJ_ORDER_ADDRESS_MISSING',
      'The CJ order delivery address is missing.',
      409,
    );
  }

  if (!order.selectedShipping || typeof order.selectedShipping !== 'object') {
    throw createCjOrderError(
      'CJ_ORDER_SHIPPING_MISSING',
      'The selected CJ shipping method is missing.',
      409,
    );
  }

  return true;
}

function buildCjProducts(order) {
  return order.items.map((item, index) => {
    const vid = safeString(item?.cjVariantId, 50);
    const sku = safeString(item?.variantSku, 50);

    if (!vid && !sku) {
      throw createCjOrderError(
        'CJ_ORDER_VARIANT_REFERENCE_MISSING',
        `CJ variant reference is missing on item ${index + 1}.`,
        409,
      );
    }

    return {
      vid: vid || undefined,

      sku: sku || undefined,

      quantity: safeInteger(item?.quantity, 1),

      unitPrice: moneyValue(item?.unitPriceIncVat) || undefined,

      storeProductId: safeString(item?.cjProductId, 64) || undefined,

      storeProductImg: safeString(item?.imageUrl, 500) || undefined,

      storeLineItemId: `${safeString(order.cjOrderNumber, 50)}-${index + 1}`.slice(0, 125),
    };
  });
}

function buildCjCreateOrderPayload(order) {
  const address = order.deliveryAddress || {};
  const shipping = order.selectedShipping || {};

  const countryCode = safeString(address.countryCode, 2).toUpperCase();
  const originCountryCode = safeString(shipping.originCountryCode, 2).toUpperCase();

  if (!/^[A-Z]{2}$/.test(countryCode)) {
    throw createCjOrderError(
      'CJ_ORDER_DESTINATION_COUNTRY_INVALID',
      'The CJ order destination country code is invalid.',
      409,
    );
  }

  if (!/^[A-Z]{2}$/.test(originCountryCode)) {
    throw createCjOrderError(
      'CJ_ORDER_ORIGIN_COUNTRY_INVALID',
      'The CJ order origin country code is invalid.',
      409,
    );
  }

  const recipientName = [safeString(address.firstName, 25), safeString(address.lastName, 25)]
    .filter(Boolean)
    .join(' ')
    .slice(0, 50);

  const logisticName = safeString(shipping.logisticsName, 50);

  if (!logisticName) {
    throw createCjOrderError(
      'CJ_ORDER_LOGISTICS_NAME_MISSING',
      'The selected CJ logistics name is missing.',
      409,
    );
  }

  const shippingPhone = normalizeCjPhoneForOrder(address);
  const taxId = normalizeCjTaxIdForOrder(address);

  if (countryCode === 'ZA' && !shippingPhone) {
    throw createCjOrderError(
      'CJ_ORDER_PHONE_INVALID',
      'CJ requires a South African phone number as 9 digits without the leading zero or 11 digits beginning with 27.',
      409,
    );
  }

  if (countryCode === 'ZA' && !taxId) {
    throw createCjOrderError(
      'CJ_ORDER_CONSIGNEE_ID_INVALID',
      'CJ requires a 13 digit South African Consignee ID / Tax ID before this supplier order can be created.',
      409,
    );
  }

  const payload = {
    orderNumber: safeString(order.cjOrderNumber, 50),

    shippingZip: safeString(address.postalCode, 20),

    shippingCountry: countryNameFromCode(countryCode),

    shippingCountryCode: countryCode,

    shippingProvince: safeString(address.province, 50),

    shippingCity: safeString(address.city, 50),

    shippingCounty: safeString(address.suburb, 50),

    shippingPhone,

    shippingCustomerName: recipientName,

    shippingAddress: safeString(address.addressLine1, 200),

    shippingAddress2: safeString(
      [address.addressLine2, address.suburb].filter(Boolean).join(', '),
      200,
    ),

    houseNumber: safeString(address.houseNumber, 20),

    email: safeString(address.email, 50),

    taxId,

    remark: `Kasyora CJ order ${safeString(order.cjOrderNumber, 50)}`.slice(0, 500),

    /*
     * payType=3 creates the CJ supplier order only.
     * The buyer has already paid Kasyora through PayPal.
     */
    payType: 3,

    shopAmount: safeNumber(moneyValue(order.payableTotal), 0).toFixed(2),

    logisticName,

    fromCountryCode: originCountryCode,

    platform: 'api',

    orderFlow: 1,

    products: buildCjProducts(order),
  };

  if (safeString(address.iossNumber, 10)) {
    payload.iossType = 2;
    payload.iossNumber = safeString(address.iossNumber, 10);
  } else {
    payload.iossType = 1;
  }

  if (booleanFromEnv(process.env.CJ_ORDER_SANDBOX, false)) {
    payload.isSandbox = 1;
  }

  return payload;
}

function getCjResponseData(response) {
  return response && typeof response === 'object' ? response.data || {} : {};
}

function getCreatedCjOrderId(data) {
  return safeString(data?.orderId || data?.shipmentOrderId || data?.id, 200);
}

function getCreatedCjOrderNumber(data, fallback) {
  return safeString(data?.orderNumber || data?.orderNo || data?.orderCode || fallback, 200);
}

function getTrackingNumber(data) {
  return safeString(data?.trackingNumber || data?.trackingNo || data?.logisticTrackingNumber, 200);
}

function getTrackingUrl(data) {
  return safeString(data?.trackingUrl || data?.trackUrl || data?.logisticTrackingUrl, 2000);
}

async function claimOrderForCjCreation(orderId) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw createCjOrderError('CJ_ORDER_ID_INVALID', 'The CJ order ID is invalid.', 400);
  }

  const claimedOrder = await CjOrder.findOneAndUpdate(
    {
      _id: orderId,

      department: 'CJ',

      status: 'PAID',

      paymentStatus: 'COMPLETED',

      fulfillmentStatus: 'CJ_ORDER_PENDING',

      'supplierOrder.createStatus': 'PENDING',
    },
    {
      $set: {
        'supplierOrder.createStatus': 'PROCESSING',
        'supplierOrder.createAttemptedAt': new Date(),
        'supplierOrder.lastErrorCode': '',
        'supplierOrder.lastErrorMessage': '',
        'supplierOrder.lastRequestId': '',
      },
    },
    {
      new: true,
    },
  ).select(
    '+deliveryAddress.taxId +deliveryAddress.iossNumber +supplierOrder.createRequestSnapshot +supplierOrder.createResponseSnapshot',
  );

  if (!claimedOrder) {
    throw createCjOrderError(
      'CJ_ORDER_NOT_ELIGIBLE',
      'No eligible paid CJ order was found for supplier order creation.',
      409,
    );
  }

  return claimedOrder;
}

async function markCjCreationFailed(order, error, requestPayload = null) {
  const safeCode = safeString(error?.code || 'CJ_ORDER_CREATE_FAILED', 100);
  const safeMessage = safeString(error?.message || 'CJ supplier order creation failed.', 2000);

  console.error('[CJ order create] Failed:', {
    cjOrderNumber: order?.cjOrderNumber,
    code: safeCode,
    message: safeMessage,
    requestId: safeString(error?.requestId, 200),
  });

  order.status = 'PAID';
  order.paymentStatus = 'COMPLETED';
  order.fulfillmentStatus = 'FAILED';

  order.supplierOrder.createStatus = 'FAILED';
  order.supplierOrder.lastErrorCode = safeCode;
  order.supplierOrder.lastErrorMessage = safeMessage;
  order.supplierOrder.lastRequestId = safeString(error?.requestId, 200);

  if (requestPayload) {
    order.supplierOrder.createRequestSnapshot = requestPayload;
  }

  await order.save();

  return {
    ok: false,
    code: safeCode,
    message: safeMessage,
    requestId: safeString(error?.requestId, 200),
  };
}

async function createCjSupplierOrderForOrderId(orderId) {
  const order = await claimOrderForCjCreation(orderId);

  let payload = null;

  try {
    assertOrderCanBeSentToCj(order);

    payload = buildCjCreateOrderPayload(order);

    const headers = {};
    const platformToken = safeString(process.env.CJ_PLATFORM_TOKEN, 1000);

    if (platformToken) {
      headers.platformToken = platformToken;
    }

    const response = await cjRequest('/shopping/order/createOrderV2', {
      method: 'POST',
      headers,
      body: payload,
    });

    const data = getCjResponseData(response);

    const cjOrderId = getCreatedCjOrderId(data);
    const cjOrderNumber = getCreatedCjOrderNumber(data, order.cjOrderNumber);

    order.status = 'CJ_ORDER_CREATED';
    order.fulfillmentStatus = 'CJ_ORDER_CREATED';

    order.supplierOrder.createStatus = 'SUCCESS';
    order.supplierOrder.cjOrderId = cjOrderId;
    order.supplierOrder.cjOrderNumber = cjOrderNumber;
    order.supplierOrder.logisticsName = safeString(order.selectedShipping?.logisticsName, 300);
    order.supplierOrder.createdAt = new Date();
    order.supplierOrder.lastSyncedAt = new Date();
    order.supplierOrder.lastErrorCode = '';
    order.supplierOrder.lastErrorMessage = '';
    order.supplierOrder.lastRequestId = safeString(response?.requestId, 200);
    order.supplierOrder.createRequestSnapshot = payload;
    order.supplierOrder.createResponseSnapshot = response;

    const trackingNumber = getTrackingNumber(data);
    const trackingUrl = getTrackingUrl(data);

    if (trackingNumber) {
      order.supplierOrder.trackingNumber = trackingNumber;
      order.tracking.trackingNumber = trackingNumber;
      order.tracking.status = 'PROCESSING';
    }

    if (trackingUrl) {
      order.supplierOrder.trackingUrl = trackingUrl;
      order.tracking.trackingUrl = trackingUrl;
    }

    if (order.tracking.status === 'PENDING') {
      order.tracking.status = 'PROCESSING';
    }

    if (safeString(order.selectedShipping?.logisticsName, 300)) {
      order.tracking.carrierName = safeString(order.selectedShipping.logisticsName, 300);
    }

    await order.save();

    return {
      ok: true,

      order,

      cj: {
        orderId: cjOrderId,
        orderNumber: cjOrderNumber,
        trackingNumber,
        trackingUrl,
        requestId: safeString(response?.requestId, 200),
      },
    };
  } catch (error) {
    return markCjCreationFailed(order, error, payload);
  }
}

async function retryFailedCjSupplierOrder(orderId) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    throw createCjOrderError('CJ_ORDER_ID_INVALID', 'The CJ order ID is invalid.', 400);
  }

  const order = await CjOrder.findOneAndUpdate(
    {
      _id: orderId,

      department: 'CJ',

      status: 'PAID',

      paymentStatus: 'COMPLETED',

      'supplierOrder.createStatus': 'FAILED',
    },
    {
      $set: {
        fulfillmentStatus: 'CJ_ORDER_PENDING',
        'supplierOrder.createStatus': 'PENDING',
        'supplierOrder.lastErrorCode': '',
        'supplierOrder.lastErrorMessage': '',
        'supplierOrder.lastRequestId': '',
      },
    },
    {
      new: true,
    },
  );

  if (!order) {
    throw createCjOrderError(
      'CJ_ORDER_RETRY_NOT_ALLOWED',
      'Only a paid CJ order with failed supplier creation can be retried.',
      409,
    );
  }

  return createCjSupplierOrderForOrderId(order._id);
}

module.exports = {
  buildCjCreateOrderPayload,
  createCjSupplierOrderForOrderId,
  retryFailedCjSupplierOrder,
};
