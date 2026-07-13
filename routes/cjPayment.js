// routes/cjPayment.js
'use strict';

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const CjOrder = require('../models/CjOrder');

const { sendCjOrderEventEmailsSafely } = require('../utils/cj/cjOrderEmailService');

const { convertMoneyAmount, FX_PROVIDER } = require('../utils/fx/getFxRate');

const {
  createRequestId,
  createPaypalOrder,
  getPaypalOrder,
  capturePaypalOrder,
  getPaypalApprovalUrl,
  getPaypalCapture,
} = require('../utils/paypal/paypalClient');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase() || 'USD';

const PAYPAL_CURRENCY =
  String(process.env.PAYPAL_CHECKOUT_CURRENCY || 'USD')
    .trim()
    .toUpperCase() || 'USD';

const BRAND_NAME =
  String(process.env.BRAND_NAME || 'Kasyora')
    .trim()
    .slice(0, 127) || 'Kasyora';

const SUPPORTED_PAYPAL_CURRENCIES = new Set([
  'AUD',
  'BRL',
  'CAD',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'HKD',
  'HUF',
  'ILS',
  'JPY',
  'MYR',
  'MXN',
  'TWD',
  'NZD',
  'NOK',
  'PHP',
  'PLN',
  'GBP',
  'SGD',
  'SEK',
  'CHF',
  'THB',
  'USD',
]);

function safeString(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function moneyString(value) {
  const amount = Number(value);

  if (!Number.isFinite(amount) || amount < 0) {
    return '0.00';
  }

  return amount.toFixed(2);
}

function normalizeCurrency(value) {
  const currency = safeString(value, 3).toUpperCase();

  return /^[A-Z]{3}$/.test(currency) ? currency : '';
}

function createPaymentError(code, message, status = 400) {
  const error = new Error(message);

  error.code = code;
  error.status = status;

  return error;
}

function errorStatus(error) {
  const explicitStatus = Number(error?.status);

  if (Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus <= 599) {
    return explicitStatus;
  }

  const code = safeString(error?.code, 200);

  if (
    [
      'CJ_PAYMENT_CHECKOUT_MISSING',
      'CJ_PAYMENT_QUOTE_MISSING',
      'CJ_PAYMENT_SHIPPING_MISSING',
      'CJ_PAYMENT_CART_MISSING',
      'CJ_PAYMENT_AMOUNT_INVALID',
      'CJ_PAYPAL_CURRENCY_UNSUPPORTED',
    ].includes(code)
  ) {
    return 400;
  }

  if (
    [
      'CJ_PAYMENT_QUOTE_EXPIRED',
      'CJ_PAYMENT_ORDER_ALREADY_PAID',
      'CJ_PAYMENT_SESSION_EXPIRED',
      'CJ_PAYPAL_CAPTURE_ID_MISSING',
      'CJ_PAYPAL_CAPTURE_NOT_COMPLETED',
      'CJ_PAYPAL_CAPTURE_AMOUNT_MISMATCH',
      'CJ_PAYPAL_CAPTURE_CURRENCY_MISMATCH',
    ].includes(code)
  ) {
    return 409;
  }

  if (['CJ_PAYMENT_ORDER_NOT_FOUND', 'CJ_PAYMENT_PAYPAL_ORDER_NOT_FOUND'].includes(code)) {
    return 404;
  }

  return 500;
}

function sendPaymentError(res, error) {
  return res.status(errorStatus(error)).json({
    success: false,
    code: safeString(error?.code || 'CJ_PAYMENT_ERROR', 200),
    message: safeString(error?.message || 'The CJ payment request could not be completed.', 1000),
    debugId: safeString(error?.debugId, 300),
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryablePaypalError(error) {
  const status = Number(error?.status || error?.statusCode || error?.httpStatus || 0);
  const code = safeString(error?.code || error?.name, 100).toUpperCase();
  const message = safeString(error?.message, 500).toLowerCase();

  if ([408, 425, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }

  return (
    code.includes('ABORT') ||
    code.includes('TIMEOUT') ||
    code.includes('UND_ERR') ||
    code.includes('ECONNRESET') ||
    code.includes('ECONNREFUSED') ||
    code.includes('ETIMEDOUT') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('socket')
  );
}

async function retryPaypalOperation(label, operation, { attempts = 3 } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (!isRetryablePaypalError(error) || attempt === attempts) {
        throw error;
      }

      const delayMs = 350 * attempt;

      console.warn(`[CJ payment] Retrying PayPal ${label}. Attempt ${attempt + 1}/${attempts}.`, {
        code: safeString(error?.code, 100),
        status: error?.status || error?.statusCode || error?.httpStatus || '',
        message: safeString(error?.message, 300),
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
}

async function capturePaypalOrderWithRetry({ paypalOrderId, requestId }) {
  return retryPaypalOperation(
    'capture',
    () =>
      capturePaypalOrder({
        paypalOrderId,
        requestId,
      }),
    {
      attempts: 3,
    },
  );
}

async function getPaypalOrderWithRetry(paypalOrderId) {
  return retryPaypalOperation('status lookup', () => getPaypalOrder(paypalOrderId), {
    attempts: 3,
  });
}

function publicBaseUrlFromRequest(req) {
  const configured = safeString(
    process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.FRONTEND_URL,
    2000,
  );

  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const host = safeString(req.get('host'), 500);

  if (!host) {
    throw createPaymentError(
      'CJ_PUBLIC_BASE_URL_MISSING',
      'The public application URL could not be determined.',
      500,
    );
  }

  return `${req.protocol}://${host}`.replace(/\/+$/, '');
}

function getUserId(req) {
  const value = req.user?._id || req.session?.user?._id || req.session?.userId || null;

  return mongoose.Types.ObjectId.isValid(value) ? value : null;
}

function getBusinessBuyerId(req) {
  const value = req.session?.business?._id || req.session?.businessId || null;

  return mongoose.Types.ObjectId.isValid(value) ? value : null;
}

function getGuestSessionReference(req) {
  return crypto
    .createHash('sha256')
    .update(String(req.sessionID || ''))
    .digest('hex');
}

function buildCjOrderOwnershipFilters(req, cjOrderNumber) {
  const filters = [];

  const userId = getUserId(req);
  const businessBuyerId = getBusinessBuyerId(req);
  const guestSessionId = getGuestSessionReference(req);

  if (userId) {
    filters.push({ userId });
  }

  if (businessBuyerId) {
    filters.push({ businessBuyerId });
  }

  if (guestSessionId) {
    filters.push({ guestSessionId });
  }

  const lastOrderNumber = safeString(req.session?.cjLastOrder?.cjOrderNumber, 100);

  if (lastOrderNumber && lastOrderNumber === cjOrderNumber) {
    filters.push({ cjOrderNumber: lastOrderNumber });
  }

  return filters;
}

function generateCjOrderNumber() {
  const date = new Date();

  const datePart = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('');

  const randomPart = crypto.randomBytes(5).toString('hex').toUpperCase();

  return `CJ-${datePart}-${randomPart}`;
}

function checkoutFromSession(req) {
  const checkout = req.session?.cjCheckout;

  if (!checkout || typeof checkout !== 'object' || checkout.source !== 'CJ') {
    throw createPaymentError(
      'CJ_PAYMENT_CHECKOUT_MISSING',
      'Your CJ checkout session is unavailable. Please calculate shipping again.',
      409,
    );
  }

  const quote = checkout.quote;

  if (!quote || typeof quote !== 'object') {
    throw createPaymentError(
      'CJ_PAYMENT_QUOTE_MISSING',
      'Your CJ shipping quotation is unavailable. Please calculate shipping again.',
      409,
    );
  }

  const quoteExpiresAt = quote.expiresAt ? new Date(quote.expiresAt) : null;

  if (
    !quoteExpiresAt ||
    Number.isNaN(quoteExpiresAt.getTime()) ||
    quoteExpiresAt.getTime() <= Date.now()
  ) {
    throw createPaymentError(
      'CJ_PAYMENT_QUOTE_EXPIRED',
      'Your CJ shipping quotation has expired. Please calculate shipping again.',
      409,
    );
  }

  const selectedShipping = checkout.selectedShipping;

  if (
    !selectedShipping ||
    typeof selectedShipping !== 'object' ||
    selectedShipping.source !== 'CJ'
  ) {
    throw createPaymentError(
      'CJ_PAYMENT_SHIPPING_MISSING',
      'Please select a CJ shipping method before continuing to payment.',
      409,
    );
  }

  const cartSnapshot = checkout.cartSnapshot;
  const items = Array.isArray(cartSnapshot?.items) ? cartSnapshot.items : [];

  if (!items.length) {
    throw createPaymentError(
      'CJ_PAYMENT_CART_MISSING',
      'Your CJ checkout does not contain any products.',
      409,
    );
  }

  const productTotalIncVat = round2(quote.productTotalIncVat);
  const shippingAmount = round2(selectedShipping.shippingAmount);
  const payableTotal = round2(productTotalIncVat + shippingAmount);

  if (!Number.isFinite(payableTotal) || payableTotal <= 0) {
    throw createPaymentError('CJ_PAYMENT_AMOUNT_INVALID', 'The CJ payable total is invalid.', 409);
  }

  return {
    checkout,
    quote,
    selectedShipping,
    cartSnapshot,
    items,
    productTotalIncVat,
    shippingAmount,
    payableTotal,
    quoteExpiresAt,
  };
}

function money(value, currency) {
  return {
    value: moneyString(value),
    currency: normalizeCurrency(currency) || BASE_CURRENCY,
  };
}

function buildOrderItems(items) {
  return items.map((item) => {
    const quantity = Math.max(1, Math.min(100, Math.floor(Number(item?.quantity || 1))));
    const unitPriceExVat = round2(item?.priceExVat);
    const unitPriceIncVat = round2(item?.price);
    const unitVatAmount = round2(unitPriceIncVat - unitPriceExVat);

    return {
      source: 'CJ',
      cjProductId: safeString(item?.cjProductId, 300),
      cjVariantId: safeString(item?.cjVariantId, 300),
      productSku: safeString(item?.productSku, 300),
      variantSku: safeString(item?.variantSku, 300),
      name: safeString(item?.name, 500) || 'CJ Product',
      variantName: safeString(item?.variantName, 500) || 'Variant',
      imageUrl: safeString(item?.imageUrl, 2000),
      category: safeString(item?.category, 500),
      quantity,
      unitPriceExVat: money(unitPriceExVat, BASE_CURRENCY),
      unitVatAmount: money(unitVatAmount, BASE_CURRENCY),
      unitPriceIncVat: money(unitPriceIncVat, BASE_CURRENCY),
      lineSubtotalExVat: money(unitPriceExVat * quantity, BASE_CURRENCY),
      lineVatAmount: money(unitVatAmount * quantity, BASE_CURRENCY),
      lineTotalIncVat: money(unitPriceIncVat * quantity, BASE_CURRENCY),
      vatRate: Number(item?.vatRate || 0),
      weightGrams: Number.isFinite(Number(item?.weightGrams)) ? Number(item.weightGrams) : null,
      dimensionsMm: {
        length: Number.isFinite(Number(item?.dimensionsMm?.length))
          ? Number(item.dimensionsMm.length)
          : null,
        width: Number.isFinite(Number(item?.dimensionsMm?.width))
          ? Number(item.dimensionsMm.width)
          : null,
        height: Number.isFinite(Number(item?.dimensionsMm?.height))
          ? Number(item.dimensionsMm.height)
          : null,
      },
      inventoryKnown: item?.inventoryKnown === true,
      inventorySnapshot: Math.max(0, Math.floor(Number(item?.inventorySnapshot || 0))),
      validatedAt: item?.validatedAt ? new Date(item.validatedAt) : new Date(),
    };
  });
}

function buildDeliveryAddress(address) {
  return {
    firstName: safeString(address?.firstName, 100),
    lastName: safeString(address?.lastName, 100),
    email: safeString(address?.email, 320).toLowerCase(),
    phone: safeString(address?.phone, 50),
    companyName: safeString(address?.companyName, 200),
    addressLine1: safeString(address?.addressLine1, 300),
    addressLine2: safeString(address?.addressLine2, 300),
    houseNumber: safeString(address?.houseNumber, 100),
    suburb: safeString(address?.suburb, 200),
    city: safeString(address?.city, 200),
    province: safeString(address?.province, 200),
    postalCode: safeString(address?.postalCode, 50),
    countryCode: safeString(address?.countryCode, 2).toUpperCase(),
    taxId: safeString(address?.taxId, 200),
    iossNumber: safeString(address?.iossNumber, 200),
  };
}

function buildSelectedShipping({ quote, selectedShipping }) {
  return {
    source: 'CJ',
    quoteRequestId: safeString(quote?.requestId, 200),
    quoteCreatedAt: quote?.quotedAt ? new Date(quote.quotedAt) : new Date(),
    quoteExpiresAt: quote?.expiresAt ? new Date(quote.expiresAt) : null,
    originCountryCode: safeString(quote?.originCountryCode, 2).toUpperCase(),
    destinationCountryCode: safeString(quote?.destinationCountryCode, 2).toUpperCase(),
    optionId: safeString(selectedShipping?.optionId, 300),
    channelId: safeString(selectedShipping?.channelId, 300),
    logisticsOptionId: safeString(selectedShipping?.id, 300),
    logisticsName: safeString(selectedShipping?.logisticsName, 300),
    logisticsModel: safeString(selectedShipping?.logisticsModel, 200),
    deliveryEstimate: safeString(selectedShipping?.deliveryEstimate, 100),
    shippingAmount: money(selectedShipping?.shippingAmount, BASE_CURRENCY),
    freightUsd: money(selectedShipping?.freightUsd, 'USD'),
    taxesFeeUsd: money(selectedShipping?.taxesFeeUsd, 'USD'),
    clearanceOperationFeeUsd: money(selectedShipping?.clearanceOperationFeeUsd, 'USD'),
    tariffUsd: money(selectedShipping?.tariffUsd, 'USD'),
    remoteFeeUsd: money(selectedShipping?.remoteFeeUsd, 'USD'),
    fxSnapshot: {
      rate: Number.isFinite(Number(selectedShipping?.fxSnapshot?.rate))
        ? Number(selectedShipping.fxSnapshot.rate)
        : null,
      from: safeString(selectedShipping?.fxSnapshot?.from || 'USD', 3).toUpperCase(),
      to: safeString(selectedShipping?.fxSnapshot?.to || BASE_CURRENCY, 3).toUpperCase(),
      provider: safeString(selectedShipping?.fxSnapshot?.provider, 100),
      convertedAt: selectedShipping?.fxSnapshot?.convertedAt
        ? new Date(selectedShipping.fxSnapshot.convertedAt)
        : null,
    },
    selectedAt: selectedShipping?.selectedAt ? new Date(selectedShipping.selectedAt) : new Date(),
    message: safeString(selectedShipping?.message, 2000),
  };
}

async function convertPayableForPaypal(payableTotal) {
  if (!SUPPORTED_PAYPAL_CURRENCIES.has(PAYPAL_CURRENCY)) {
    throw createPaymentError(
      'CJ_PAYPAL_CURRENCY_UNSUPPORTED',
      `${PAYPAL_CURRENCY} is not configured as a supported PayPal checkout currency.`,
      500,
    );
  }

  if (BASE_CURRENCY === PAYPAL_CURRENCY) {
    return {
      value: round2(payableTotal),
      currency: PAYPAL_CURRENCY,
      fx: {
        rate: 1,
        from: BASE_CURRENCY,
        to: PAYPAL_CURRENCY,
        provider: 'IDENTITY',
        convertedAt: new Date(),
      },
    };
  }

  const converted = await convertMoneyAmount(payableTotal, BASE_CURRENCY, PAYPAL_CURRENCY);
  const value = Number(converted?.value);

  if (!Number.isFinite(value) || value <= 0) {
    throw createPaymentError(
      'CJ_PAYPAL_CONVERSION_FAILED',
      'The CJ order total could not be converted into the PayPal checkout currency.',
      500,
    );
  }

  return {
    value: round2(value),
    currency: PAYPAL_CURRENCY,
    fx: {
      rate: Number(converted?.fx?.rate || 0),
      from: BASE_CURRENCY,
      to: PAYPAL_CURRENCY,
      provider: safeString(converted?.fx?.provider, 100) || FX_PROVIDER,
      convertedAt: converted?.fx?.convertedAt ? new Date(converted.fx.convertedAt) : new Date(),
    },
  };
}

function getCaptureAmount(capture) {
  return {
    value: round2(capture?.amount?.value),
    currency: normalizeCurrency(capture?.amount?.currency_code),
  };
}

function amountsMatch(expectedValue, actualValue) {
  return Math.abs(Number(expectedValue) - Number(actualValue)) < 0.01;
}

function buildPaypalPayloadForCjCheckout({ req, paypalAmount, orderNumber, deliveryAddress }) {
  const publicBaseUrl = publicBaseUrlFromRequest(req);

  return {
    intent: 'CAPTURE',
    application_context: {
      brand_name: BRAND_NAME,
      landing_page: 'LOGIN',
      user_action: 'PAY_NOW',
      shipping_preference: 'SET_PROVIDED_ADDRESS',
      return_url: `${publicBaseUrl}/cj/payment/return`,
      cancel_url: `${publicBaseUrl}/cj/payment/cancel`,
    },
    purchase_units: [
      {
        reference_id: 'CJ_PURCHASE',
        custom_id: orderNumber,
        invoice_id: orderNumber,
        description: `Kasyora CJ checkout ${orderNumber}`.slice(0, 127),
        amount: {
          currency_code: paypalAmount.currency,
          value: moneyString(paypalAmount.value),
        },
        shipping: {
          name: {
            full_name: `${deliveryAddress.firstName} ${deliveryAddress.lastName}`
              .trim()
              .slice(0, 300),
          },
          address: {
            address_line_1: [deliveryAddress.houseNumber, deliveryAddress.addressLine1]
              .filter(Boolean)
              .join(' ')
              .slice(0, 300),
            address_line_2:
              [deliveryAddress.addressLine2, deliveryAddress.suburb]
                .filter(Boolean)
                .join(', ')
                .slice(0, 300) || undefined,
            admin_area_2: deliveryAddress.city,
            admin_area_1: deliveryAddress.province,
            postal_code: deliveryAddress.postalCode,
            country_code: deliveryAddress.countryCode,
          },
        },
      },
    ],
  };
}

function paypalAmountFromPendingPayment(pendingPayment) {
  const pendingValue = Number(pendingPayment?.paypalAmount?.value);
  const pendingCurrency = normalizeCurrency(pendingPayment?.paypalAmount?.currency);

  if (Number.isFinite(pendingValue) && pendingValue > 0 && pendingCurrency) {
    return {
      value: round2(pendingValue),
      currency: pendingCurrency,
      fx: {
        rate: Number(pendingPayment?.paypalAmount?.fx?.rate || 0),
        from: safeString(pendingPayment?.paypalAmount?.fx?.from || BASE_CURRENCY, 3).toUpperCase(),
        to: safeString(pendingPayment?.paypalAmount?.fx?.to || pendingCurrency, 3).toUpperCase(),
        provider: safeString(pendingPayment?.paypalAmount?.fx?.provider, 100),
        convertedAt: pendingPayment?.paypalAmount?.fx?.convertedAt
          ? new Date(pendingPayment.paypalAmount.fx.convertedAt)
          : new Date(),
      },
    };
  }

  return null;
}

function captureIsCompleted(capture) {
  return (
    Boolean(safeString(capture?.id, 200)) &&
    safeString(capture?.status, 100).toUpperCase() === 'COMPLETED'
  );
}

async function createCjOrderAfterCompletedPaypalCapture({ req, paypalResponse, capture }) {
  const pendingPayment =
    req.session?.cjPayment && req.session.cjPayment.source === 'CJ' ? req.session.cjPayment : null;

  if (!pendingPayment?.paypalOrderId) {
    throw createPaymentError(
      'CJ_PAYMENT_SESSION_EXPIRED',
      'Your CJ PayPal checkout session expired before Kasyora could create the order.',
      409,
    );
  }

  const paypalOrderId = safeString(pendingPayment.paypalOrderId, 200);
  const captureId = safeString(capture?.id, 200);
  const captureStatus = safeString(capture?.status, 100).toUpperCase();

  if (!captureId || captureStatus !== 'COMPLETED') {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_ID_MISSING',
      'PayPal did not return a completed capture ID. No CJ order was created.',
      409,
    );
  }

  const checkoutData = checkoutFromSession(req);
  const fallbackPaypalAmount = await convertPayableForPaypal(checkoutData.payableTotal);
  const paypalAmount = paypalAmountFromPendingPayment(pendingPayment) || fallbackPaypalAmount;
  const captureAmount = getCaptureAmount(capture);

  if (captureAmount.currency !== paypalAmount.currency) {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_CURRENCY_MISMATCH',
      'The PayPal capture currency does not match the CJ checkout amount. No CJ order was created.',
      409,
    );
  }

  if (!amountsMatch(paypalAmount.value, captureAmount.value)) {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_AMOUNT_MISMATCH',
      'The PayPal capture amount does not match the CJ checkout total. No CJ order was created.',
      409,
    );
  }

  const existingPaidOrder = await CjOrder.findOne({
    department: 'CJ',
    paymentStatus: 'COMPLETED',
    'paypal.captureStatus': 'COMPLETED',
    $or: [{ 'paypal.orderId': paypalOrderId }, { 'paypal.captureId': captureId }],
  });

  if (existingPaidOrder) {
    return finalizeCompletedCjPayment({
      req,
      order: existingPaidOrder,
      paypalResponse,
      capture,
    });
  }

  const orderNumber = safeString(pendingPayment.cjOrderNumber, 100) || generateCjOrderNumber();
  const deliveryAddress = buildDeliveryAddress(checkoutData.checkout.deliveryAddress);
  const orderItems = buildOrderItems(checkoutData.items);

  const order = await CjOrder.create({
    department: 'CJ',
    cjOrderNumber: orderNumber,
    userId: getUserId(req),
    businessBuyerId: getBusinessBuyerId(req),
    guestSessionId: getGuestSessionReference(req),
    customerEmail: deliveryAddress.email,
    status: 'PAID',
    paymentStatus: 'COMPLETED',
    fulfillmentStatus: 'CJ_ORDER_PENDING',
    currency: BASE_CURRENCY,
    vatRate: Number(orderItems[0]?.vatRate || 0),
    items: orderItems,
    itemCount: Number(checkoutData.cartSnapshot.itemCount || 0),
    productSubtotalExVat: money(checkoutData.cartSnapshot.subtotalExVat, BASE_CURRENCY),
    productVatAmount: money(checkoutData.cartSnapshot.vatAmount, BASE_CURRENCY),
    productTotalIncVat: money(checkoutData.productTotalIncVat, BASE_CURRENCY),
    shippingTotal: money(checkoutData.shippingAmount, BASE_CURRENCY),
    payableTotal: money(checkoutData.payableTotal, BASE_CURRENCY),
    deliveryAddress,
    selectedShipping: buildSelectedShipping({
      quote: checkoutData.quote,
      selectedShipping: checkoutData.selectedShipping,
    }),
    paypal: {
      orderId: paypalOrderId,
      orderStatus: safeString(
        paypalResponse?.status || pendingPayment.paypalOrderStatus || 'COMPLETED',
        100,
      ).toUpperCase(),
      captureId,
      captureStatus: 'COMPLETED',
      capturedAt: capture?.create_time ? new Date(capture.create_time) : new Date(),
      rawCaptureResponse: paypalResponse,
      purchaseUnitReferenceId: 'CJ_PURCHASE',
      customId: orderNumber,
      invoiceId: orderNumber,
      amount: money(paypalAmount.value, paypalAmount.currency),
      createdAt: pendingPayment.createdAt ? new Date(pendingPayment.createdAt) : new Date(),
    },
    supplierOrder: {
      createStatus: 'PENDING',
    },
    tracking: {
      status: 'PENDING',
    },
    paidAt: capture?.create_time ? new Date(capture.create_time) : new Date(),
    lastPaymentErrorCode: '',
    lastPaymentErrorMessage: '',
    metadata: {
      basePayableAmount: {
        value: moneyString(checkoutData.payableTotal),
        currency: BASE_CURRENCY,
      },
      paypalConversion: {
        rate: paypalAmount.fx.rate,
        from: paypalAmount.fx.from,
        to: paypalAmount.fx.to,
        provider: paypalAmount.fx.provider,
        convertedAt: paypalAmount.fx.convertedAt,
      },
      quoteRequestId: safeString(checkoutData.quote.requestId, 200),
    },
  });

  return finalizeCompletedCjPayment({
    req,
    order,
    paypalResponse,
    capture,
  });
}

async function finalizeCompletedCjPayment({ req, order, paypalResponse, capture }) {
  const payer = paypalResponse?.payer || {};
  const captureId = safeString(capture?.id, 200);
  const captureStatus = safeString(capture?.status, 100).toUpperCase();
  const captureAmount = getCaptureAmount(capture);
  const expectedAmount = Number(order.paypal?.amount?.value);
  const expectedCurrency = normalizeCurrency(order.paypal?.amount?.currency);

  if (!captureId || captureStatus !== 'COMPLETED') {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_NOT_COMPLETED',
      'PayPal did not return a completed capture ID. No CJ order was confirmed.',
      409,
    );
  }

  if (captureAmount.currency !== expectedCurrency) {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_CURRENCY_MISMATCH',
      'The PayPal capture currency does not match the CJ order.',
      409,
    );
  }

  if (!amountsMatch(expectedAmount, captureAmount.value)) {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_AMOUNT_MISMATCH',
      'The PayPal capture amount does not match the CJ order total.',
      409,
    );
  }

  order.status = 'PAID';
  order.paymentStatus = 'COMPLETED';
  order.fulfillmentStatus = 'CJ_ORDER_PENDING';
  order.paidAt = capture?.create_time ? new Date(capture.create_time) : new Date();

  order.payer = {
    payerId: safeString(payer?.payer_id, 200),
    email: safeString(payer?.email_address, 320).toLowerCase(),
    givenName: safeString(payer?.name?.given_name, 200),
    surname: safeString(payer?.name?.surname, 200),
    countryCode: safeString(payer?.address?.country_code, 2).toUpperCase(),
  };

  order.paypal.orderStatus = safeString(paypalResponse?.status || 'COMPLETED', 100).toUpperCase();
  order.paypal.captureId = captureId;
  order.paypal.captureStatus = 'COMPLETED';
  order.paypal.capturedAt = capture?.create_time ? new Date(capture.create_time) : new Date();
  order.paypal.rawCaptureResponse = paypalResponse;
  order.supplierOrder.createStatus = 'PENDING';
  order.lastPaymentErrorCode = '';
  order.lastPaymentErrorMessage = '';

  await order.save();

  /*
   * Send the CJ order confirmation only after the completed
   * PayPal capture and paid CjOrder have been committed.
   *
   * The email service is idempotent, so the PayPal webhook
   * cannot send a duplicate confirmation.
   */
  await sendCjOrderEventEmailsSafely(order, 'PAYMENT_COMPLETED', {
    source: 'cj-payment-direct-capture',
  });

  /*
   * This is the first fulfilment status after payment.
   */
  await sendCjOrderEventEmailsSafely(order, 'CJ_ORDER_PENDING', {
    source: 'cj-payment-direct-capture',
  });

  req.session.cjCart = {
    source: 'CJ',
    items: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  delete req.session.cjCheckout;
  delete req.session.cjPayment;

  req.session.cjLastOrder = {
    source: 'CJ',
    cjOrderNumber: order.cjOrderNumber,
    localOrderId: String(order._id),
  };

  req.session.storeDepartment = 'cj';

  return order;
}

function redirectToCjCheckoutWithPaymentIssue(req, res, { issue, orderNumber = '' } = {}) {
  req.session.storeDepartment = 'cj';

  const params = new URLSearchParams();
  params.set('paymentIssue', safeString(issue || 'PAYMENT_FAILED', 80));

  if (orderNumber) {
    params.set('paypalReference', safeString(orderNumber, 100));
  }

  return req.session.save(() => {
    return res.redirect(`/cj/checkout?${params.toString()}`);
  });
}

async function recoverCompletedPaymentFromPaypal({ req, paypalOrderId }) {
  const paypalOrder = await getPaypalOrderWithRetry(paypalOrderId);
  const capture = getPaypalCapture(paypalOrder);

  if (captureIsCompleted(capture)) {
    const order = await createCjOrderAfterCompletedPaypalCapture({
      req,
      paypalResponse: paypalOrder,
      capture,
    });

    return {
      completed: true,
      order,
      paypalOrder,
      capture,
    };
  }

  return {
    completed: false,
    order: null,
    paypalOrder,
    capture,
  };
}

async function clearStalePendingPaymentBeforeNewAttempt(req) {
  const pendingPayment =
    req.session?.cjPayment && req.session.cjPayment.source === 'CJ' ? req.session.cjPayment : null;

  const paypalOrderId = safeString(pendingPayment?.paypalOrderId, 200);

  if (!paypalOrderId) {
    return null;
  }

  const existingCompletedOrder = await CjOrder.findOne({
    department: 'CJ',
    paymentStatus: 'COMPLETED',
    'paypal.captureStatus': 'COMPLETED',
    'paypal.orderId': paypalOrderId,
  }).select('cjOrderNumber');

  if (existingCompletedOrder) {
    return existingCompletedOrder;
  }

  try {
    const recovered = await recoverCompletedPaymentFromPaypal({
      req,
      paypalOrderId,
    });

    if (recovered.completed && recovered.order) {
      return recovered.order;
    }
  } catch (error) {
    console.warn(
      '[CJ payment] Could not verify stale PayPal order before new attempt:',
      error?.message || error,
    );
  }

  delete req.session.cjPayment;

  return null;
}

/*
 * POST /api/cj-payment/create
 *
 * Production rule:
 * This route must NOT create a CjOrder.
 * It only creates a PayPal checkout order and stores a temporary CJ payment
 * reference in the session. The real CjOrder is created later, only after
 * PayPal capture returns COMPLETED with a real capture ID.
 */
router.post('/api/cj-payment/create', async (req, res) => {
  try {
    const existingCompletedOrder = await clearStalePendingPaymentBeforeNewAttempt(req);

    if (existingCompletedOrder) {
      return req.session.save(() =>
        res.status(409).json({
          success: false,
          code: 'CJ_PAYMENT_ORDER_ALREADY_PAID',
          message:
            'This CJ checkout already has a completed PayPal payment. Opening the confirmed CJ order instead.',
          redirectTo: `/cj/order/success/${encodeURIComponent(existingCompletedOrder.cjOrderNumber)}`,
        }),
      );
    }

    const checkoutData = checkoutFromSession(req);
    const paypalAmount = await convertPayableForPaypal(checkoutData.payableTotal);
    const orderNumber = generateCjOrderNumber();
    const deliveryAddress = buildDeliveryAddress(checkoutData.checkout.deliveryAddress);

    const paypalPayload = buildPaypalPayloadForCjCheckout({
      req,
      paypalAmount,
      orderNumber,
      deliveryAddress,
    });

    const paypalOrder = await retryPaypalOperation(
      'checkout create',
      () =>
        createPaypalOrder({
          payload: paypalPayload,
          requestId: createRequestId(`cj-create-${orderNumber}`),
        }),
      {
        attempts: 3,
      },
    );

    const approvalUrl = getPaypalApprovalUrl(paypalOrder);

    if (!paypalOrder?.id || !approvalUrl) {
      throw createPaymentError(
        'CJ_PAYPAL_APPROVAL_URL_MISSING',
        'PayPal did not return a checkout approval URL. No CJ order was created.',
        502,
      );
    }

    req.session.cjPayment = {
      source: 'CJ',
      cjOrderNumber: orderNumber,
      paypalOrderId: safeString(paypalOrder.id, 200),
      paypalOrderStatus: safeString(paypalOrder.status, 100).toUpperCase(),
      paypalAmount: {
        value: moneyString(paypalAmount.value),
        currency: paypalAmount.currency,
        fx: {
          rate: paypalAmount.fx.rate,
          from: paypalAmount.fx.from,
          to: paypalAmount.fx.to,
          provider: paypalAmount.fx.provider,
          convertedAt: paypalAmount.fx.convertedAt,
        },
      },
      createdAt: new Date().toISOString(),
    };

    req.session.storeDepartment = 'cj';

    return req.session.save((saveError) => {
      if (saveError) {
        console.error('[CJ payment] Session save failed:', saveError);

        return res.status(500).json({
          success: false,
          code: 'CJ_PAYMENT_SESSION_SAVE_FAILED',
          message:
            'PayPal checkout was created, but Kasyora could not save the checkout session. No CJ order was created.',
        });
      }

      return res.json({
        success: true,
        source: 'CJ',
        paypalReference: orderNumber,
        paypalOrderId: safeString(paypalOrder.id, 200),
        approvalUrl,
      });
    });
  } catch (error) {
    console.error('[CJ payment] Create failed:', error?.stack || error);

    return sendPaymentError(res, error);
  }
});

/*
 * GET /cj/payment/return
 *
 * Production rule:
 * A CjOrder is created only after PayPal capture is COMPLETED and PayPal sends
 * a non-empty capture ID. If capture is missing, pending, declined, denied, or
 * cannot be verified, the checkout fails without a local CjOrder record.
 */
router.get('/cj/payment/return', async (req, res) => {
  const paypalOrderId = safeString(req.query?.token, 200);

  const pendingPayment =
    req.session?.cjPayment && req.session.cjPayment.source === 'CJ' ? req.session.cjPayment : null;

  const pendingOrderNumber = safeString(pendingPayment?.cjOrderNumber, 100);

  try {
    if (!paypalOrderId) {
      throw createPaymentError(
        'CJ_PAYMENT_PAYPAL_ORDER_NOT_FOUND',
        'PayPal did not return an order token. No CJ order was created.',
        400,
      );
    }

    if (!pendingPayment?.paypalOrderId) {
      throw createPaymentError(
        'CJ_PAYMENT_SESSION_EXPIRED',
        'Your PayPal checkout session expired before Kasyora could confirm the payment. No CJ order was created.',
        409,
      );
    }

    if (safeString(pendingPayment.paypalOrderId, 200) !== paypalOrderId) {
      throw createPaymentError(
        'CJ_PAYMENT_PAYPAL_ORDER_MISMATCH',
        'The PayPal return token does not match the current CJ checkout session. No CJ order was created.',
        409,
      );
    }

    let captureResponse = null;

    try {
      captureResponse = await capturePaypalOrderWithRetry({
        paypalOrderId,
        requestId: createRequestId(`cj-capture-${paypalOrderId}`),
      });
    } catch (captureError) {
      console.error(
        '[CJ payment] PayPal capture request failed. Checking PayPal order status before deciding:',
        captureError?.stack || captureError,
      );

      try {
        const recovered = await recoverCompletedPaymentFromPaypal({
          req,
          paypalOrderId,
        });

        if (recovered.completed && recovered.order) {
          return req.session.save(() =>
            res.redirect(`/cj/order/success/${encodeURIComponent(recovered.order.cjOrderNumber)}`),
          );
        }

        const recoveredStatus = safeString(
          recovered.capture?.status || recovered.paypalOrder?.status,
          100,
        ).toUpperCase();

        if (recoveredStatus === 'PENDING') {
          delete req.session.cjPayment;

          req.flash(
            'warning',
            'PayPal says this payment is still pending. Kasyora has not created a CJ order or CJ supplier order. Please check PayPal before trying again.',
          );

          return redirectToCjCheckoutWithPaymentIssue(req, res, {
            issue: 'CAPTURE_PENDING',
            orderNumber: pendingOrderNumber,
          });
        }

        delete req.session.cjPayment;

        req.flash(
          'error',
          'PayPal did not confirm a completed capture. No money was confirmed by Kasyora and no CJ order was created. You can safely try PayPal again if PayPal shows no charge.',
        );

        return redirectToCjCheckoutWithPaymentIssue(req, res, {
          issue: 'CAPTURE_FAILED_NO_MONEY',
          orderNumber: pendingOrderNumber,
        });
      } catch (verifyError) {
        console.error(
          '[CJ payment] PayPal status verification also failed:',
          verifyError?.stack || verifyError,
        );

        req.flash(
          'warning',
          'Kasyora could not verify PayPal after the capture request failed. No CJ order was created. Please check PayPal before trying again.',
        );

        return redirectToCjCheckoutWithPaymentIssue(req, res, {
          issue: 'CAPTURE_STATUS_UNKNOWN',
          orderNumber: pendingOrderNumber,
        });
      }
    }

    const capture = getPaypalCapture(captureResponse);
    const captureStatus = safeString(capture?.status, 100).toUpperCase();

    if (captureIsCompleted(capture)) {
      const order = await createCjOrderAfterCompletedPaypalCapture({
        req,
        paypalResponse: captureResponse,
        capture,
      });

      return req.session.save(() =>
        res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
      );
    }

    if (captureStatus === 'PENDING') {
      delete req.session.cjPayment;

      req.flash(
        'warning',
        'PayPal says this payment is pending. Kasyora has not created a CJ order or CJ supplier order. Please check PayPal before trying again.',
      );

      return redirectToCjCheckoutWithPaymentIssue(req, res, {
        issue: 'CAPTURE_PENDING',
        orderNumber: pendingOrderNumber,
      });
    }

    delete req.session.cjPayment;

    req.flash(
      'error',
      'PayPal did not return a completed capture ID. No money was confirmed by Kasyora and no CJ order was created. You can safely try PayPal again if PayPal shows no charge.',
    );

    return redirectToCjCheckoutWithPaymentIssue(req, res, {
      issue: 'CAPTURE_FAILED_NO_MONEY',
      orderNumber: pendingOrderNumber,
    });
  } catch (error) {
    console.error('[CJ payment] Capture failed:', error?.stack || error);

    req.flash(
      'error',
      safeString(
        error?.message || 'The CJ PayPal payment could not be completed. No CJ order was created.',
        1000,
      ),
    );

    return redirectToCjCheckoutWithPaymentIssue(req, res, {
      issue: 'CAPTURE_ERROR',
      orderNumber: pendingOrderNumber,
    });
  }
});

/*
 * GET /cj/payment/cancel
 */
router.get('/cj/payment/cancel', async (req, res) => {
  const paypalOrderId = safeString(req.query?.token, 200);

  const pendingPayment =
    req.session?.cjPayment && req.session.cjPayment.source === 'CJ' ? req.session.cjPayment : null;

  if (
    pendingPayment?.paypalOrderId &&
    (!paypalOrderId || safeString(pendingPayment.paypalOrderId, 200) === paypalOrderId)
  ) {
    delete req.session.cjPayment;
  }

  req.flash(
    'info',
    'PayPal checkout was cancelled. No CJ order was created and no CJ supplier order was created.',
  );

  return req.session.save(() => {
    return res.redirect('/cj/checkout?paymentIssue=PAYPAL_CANCELLED');
  });
});

/*
 * GET /cj/order/success/:cjOrderNumber
 *
 * Displays only a real paid CJ order with PayPal captureStatus COMPLETED and a
 * non-empty PayPal capture ID.
 */
router.get('/cj/order/success/:cjOrderNumber', async (req, res) => {
  try {
    const cjOrderNumber = safeString(req.params?.cjOrderNumber, 100);

    if (!cjOrderNumber) {
      req.flash('error', 'The CJ order number is missing.');

      return res.redirect('/store');
    }

    const ownershipFilters = buildCjOrderOwnershipFilters(req, cjOrderNumber);

    if (!ownershipFilters.length) {
      req.flash('error', 'This CJ order could not be accessed from the current session.');

      return res.redirect('/store');
    }

    const order = await CjOrder.findOne({
      cjOrderNumber,
      department: 'CJ',
      status: 'PAID',
      paymentStatus: 'COMPLETED',
      'paypal.captureStatus': 'COMPLETED',
      'paypal.captureId': {
        $exists: true,
        $ne: '',
      },
      $or: ownershipFilters,
    })
      .select(
        [
          'department',
          'cjOrderNumber',
          'customerEmail',
          'status',
          'paymentStatus',
          'fulfillmentStatus',
          'currency',
          'items',
          'itemCount',
          'productSubtotalExVat',
          'productVatAmount',
          'productTotalIncVat',
          'shippingTotal',
          'payableTotal',
          'deliveryAddress',
          'selectedShipping',
          'payer',
          'paypal.orderId',
          'paypal.orderStatus',
          'paypal.captureId',
          'paypal.captureStatus',
          'paypal.amount',
          'supplierOrder.createStatus',
          'supplierOrder.cjOrderId',
          'supplierOrder.cjOrderNumber',
          'tracking',
          'paidAt',
          'createdAt',
          'updatedAt',
        ].join(' '),
      )
      .lean();

    if (!order) {
      req.flash(
        'warning',
        'This CJ order is not confirmed as paid because PayPal did not provide a completed capture ID.',
      );

      return res.redirect('/cj/checkout?paymentIssue=CAPTURE_FAILED_NO_MONEY');
    }

    req.session.storeDepartment = 'cj';

    return res.render('cj/order-success', {
      layout: 'layouts/store',
      title: 'CJ Order Confirmed',
      storeDepartment: 'cj',
      productSource: 'CJ',
      order,
      baseCurrency: order.currency || BASE_CURRENCY,
    });
  } catch (error) {
    console.error('[CJ payment] Success page failed:', error?.stack || error);

    req.flash('error', 'The CJ order confirmation page could not be loaded.');

    return res.redirect('/store');
  }
});

/*
 * GET /api/cj-payment/status/:cjOrderNumber
 *
 * This endpoint now only checks real completed local CJ orders. It does not
 * create pending local orders and does not create supplier orders.
 */
router.get('/api/cj-payment/status/:cjOrderNumber', async (req, res) => {
  try {
    const cjOrderNumber = safeString(req.params?.cjOrderNumber, 100);
    const ownershipFilters = buildCjOrderOwnershipFilters(req, cjOrderNumber);

    if (!ownershipFilters.length) {
      throw createPaymentError(
        'CJ_PAYMENT_ORDER_NOT_FOUND',
        'The CJ order could not be accessed from the current session.',
        404,
      );
    }

    const order = await CjOrder.findOne({
      cjOrderNumber,
      department: 'CJ',
      paymentStatus: 'COMPLETED',
      'paypal.captureStatus': 'COMPLETED',
      'paypal.captureId': {
        $exists: true,
        $ne: '',
      },
      $or: ownershipFilters,
    });

    if (!order) {
      throw createPaymentError(
        'CJ_PAYMENT_ORDER_NOT_FOUND',
        'No completed CJ order with a PayPal capture ID was found.',
        404,
      );
    }

    return res.json({
      success: true,
      completed: true,
      pending: false,
      cjOrderNumber: order.cjOrderNumber,
      redirectTo: `/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`,
    });
  } catch (error) {
    console.error('[CJ payment] Status check failed:', error?.stack || error);

    return sendPaymentError(res, error);
  }
});

module.exports = router;
