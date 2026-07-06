// routes/cjPayment.js
'use strict';

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

const CjOrder = require('../models/CjOrder');

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
    filters.push({
      userId,
    });
  }

  if (businessBuyerId) {
    filters.push({
      businessBuyerId,
    });
  }

  if (guestSessionId) {
    filters.push({
      guestSessionId,
    });
  }

  const lastOrderNumber = safeString(req.session?.cjLastOrder?.cjOrderNumber, 100);

  if (lastOrderNumber && lastOrderNumber === cjOrderNumber) {
    filters.push({
      cjOrderNumber: lastOrderNumber,
    });
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

function buildPaypalDescription(order) {
  return `Kasyora CJ order ${order.cjOrderNumber}`.slice(0, 127);
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

/*
 * POST /api/cj-payment/create
 *
 * Creates the local CjOrder snapshot first, then creates
 * a PayPal order using the server-calculated amount.
 */
router.post('/api/cj-payment/create', async (req, res) => {
  let localOrder = null;

  try {
    /*
     * Do not create another PayPal order while the current
     * CJ session already has an unfinished payment.
     */
    const existingPayment =
      req.session?.cjPayment && req.session.cjPayment.source === 'CJ'
        ? req.session.cjPayment
        : null;

    const existingLocalOrderId = safeString(existingPayment?.localOrderId, 100);

    if (existingLocalOrderId && mongoose.Types.ObjectId.isValid(existingLocalOrderId)) {
      const existingOrder = await CjOrder.findById(existingLocalOrderId)
        .select(
          [
            'cjOrderNumber',
            'status',
            'paymentStatus',
            'paypal.orderId',
            'paypal.captureId',
            'paypal.captureStatus',
          ].join(' '),
        )
        .lean();

      if (existingOrder && existingOrder.paymentStatus === 'COMPLETED') {
        return res.status(409).json({
          success: false,
          code: 'CJ_PAYMENT_ALREADY_COMPLETED',
          message: 'This CJ payment has already been completed.',
          redirectTo: `/cj/order/success/${encodeURIComponent(existingOrder.cjOrderNumber)}`,
        });
      }

      if (
        existingOrder &&
        ['CREATED', 'APPROVED', 'PENDING'].includes(
          String(existingOrder.paymentStatus || '').toUpperCase(),
        ) &&
        existingOrder.paypal?.orderId
      ) {
        const isPendingCapture =
          String(existingOrder.paypal?.captureStatus || '').toUpperCase() === 'PENDING' ||
          String(existingOrder.paymentStatus || '').toUpperCase() === 'PENDING';

        return res.status(409).json({
          success: false,

          code: 'CJ_PAYMENT_ALREADY_IN_PROGRESS',

          message: isPendingCapture
            ? 'PayPal is still processing your existing payment. Do not pay again.'
            : 'A PayPal payment already exists for this CJ checkout. Do not create another payment.',

          redirectTo: isPendingCapture
            ? `/cj/order/success/${encodeURIComponent(existingOrder.cjOrderNumber)}`
            : '',
        });
      }

      /*
       * A cancelled or failed previous order should not block
       * a legitimate new payment attempt.
       */
      if (
        !existingOrder ||
        ['CANCELLED', 'DECLINED', 'FAILED'].includes(
          String(existingOrder?.paymentStatus || '').toUpperCase(),
        )
      ) {
        delete req.session.cjPayment;
      }
    }

    const checkoutData = checkoutFromSession(req);

    const paypalAmount = await convertPayableForPaypal(checkoutData.payableTotal);

    const orderNumber = generateCjOrderNumber();

    const deliveryAddress = buildDeliveryAddress(checkoutData.checkout.deliveryAddress);

    const orderItems = buildOrderItems(checkoutData.items);

    localOrder = await CjOrder.create({
      department: 'CJ',

      cjOrderNumber: orderNumber,

      userId: getUserId(req),

      businessBuyerId: getBusinessBuyerId(req),

      guestSessionId: getGuestSessionReference(req),

      customerEmail: deliveryAddress.email,

      status: 'PAYMENT_PENDING',

      paymentStatus: 'CREATED',

      fulfillmentStatus: 'PENDING',

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
        orderId: '',
        orderStatus: 'CREATING',

        captureId: '',
        captureStatus: '',

        purchaseUnitReferenceId: 'CJ_PURCHASE',

        customId: orderNumber,

        invoiceId: orderNumber,

        amount: money(paypalAmount.value, paypalAmount.currency),

        createdAt: new Date(),
      },

      supplierOrder: {
        createStatus: 'NOT_CREATED',
      },

      tracking: {
        status: 'PENDING',
      },

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

    const publicBaseUrl = publicBaseUrlFromRequest(req);

    const paypalPayload = {
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

          custom_id: localOrder.cjOrderNumber,

          invoice_id: localOrder.cjOrderNumber,

          description: buildPaypalDescription(localOrder),

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

    const requestId = createRequestId(`cj-${localOrder._id}`);

    const paypalOrder = await createPaypalOrder({
      payload: paypalPayload,

      requestId,
    });

    const approvalUrl = getPaypalApprovalUrl(paypalOrder);

    if (!paypalOrder?.id || !approvalUrl) {
      throw createPaymentError(
        'CJ_PAYPAL_APPROVAL_URL_MISSING',
        'PayPal did not return a checkout approval URL.',
        502,
      );
    }

    localOrder.paypal.orderId = safeString(paypalOrder.id, 200);

    localOrder.paypal.orderStatus = safeString(paypalOrder.status, 100).toUpperCase();

    localOrder.paypal.rawCreateResponse = paypalOrder;

    await localOrder.save();

    req.session.cjPayment = {
      source: 'CJ',

      localOrderId: String(localOrder._id),

      cjOrderNumber: localOrder.cjOrderNumber,

      paypalOrderId: localOrder.paypal.orderId,

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
            'The PayPal order was created, but the local checkout session could not be saved.',
        });
      }

      return res.json({
        success: true,

        source: 'CJ',

        cjOrderNumber: localOrder.cjOrderNumber,

        paypalOrderId: localOrder.paypal.orderId,

        approvalUrl,
      });
    });
  } catch (error) {
    console.error('[CJ payment] Create failed:', error?.stack || error);

    if (localOrder && !localOrder.paypal?.orderId) {
      try {
        localOrder.status = 'PAYMENT_FAILED';

        localOrder.paymentStatus = 'FAILED';

        localOrder.lastPaymentErrorCode = safeString(error?.code, 200);

        localOrder.lastPaymentErrorMessage = safeString(error?.message, 2000);

        await localOrder.save();
      } catch (saveError) {
        console.error('[CJ payment] Failed to record local payment error:', saveError);
      }
    }

    return sendPaymentError(res, error);
  }
});

async function finalizeCompletedCjPayment({ req, order, paypalResponse, capture }) {
  const payer = paypalResponse?.payer || {};

  const captureStatus = safeString(capture?.status, 100).toUpperCase();

  const captureAmount = getCaptureAmount(capture);

  const expectedAmount = Number(order.paypal?.amount?.value);

  const expectedCurrency = normalizeCurrency(order.paypal?.amount?.currency);

  if (captureStatus !== 'COMPLETED') {
    throw createPaymentError(
      'CJ_PAYPAL_CAPTURE_NOT_COMPLETED',
      `PayPal capture status is ${captureStatus || 'unknown'}.`,
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

  order.paypal.orderStatus = safeString(paypalResponse?.status, 100).toUpperCase();

  order.paypal.captureId = safeString(capture.id, 200);

  order.paypal.captureStatus = 'COMPLETED';

  order.paypal.capturedAt = capture?.create_time ? new Date(capture.create_time) : new Date();

  order.paypal.rawCaptureResponse = paypalResponse;

  order.supplierOrder.createStatus = 'PENDING';

  order.lastPaymentErrorCode = '';

  order.lastPaymentErrorMessage = '';

  await order.save();

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

async function finalizePendingCjPayment({ req, order, paypalResponse, capture }) {
  const captureStatus = safeString(capture?.status, 100).toUpperCase() || 'PENDING';

  const pendingReason = safeString(capture?.status_details?.reason, 200);

  order.status = 'PAYMENT_PENDING';

  order.paymentStatus = 'PENDING';

  order.fulfillmentStatus = 'PENDING';

  order.paypal.orderStatus = safeString(paypalResponse?.status || 'COMPLETED', 100).toUpperCase();

  order.paypal.captureId = safeString(capture?.id, 200);

  order.paypal.captureStatus = captureStatus;

  order.paypal.capturedAt = capture?.create_time ? new Date(capture.create_time) : new Date();

  order.paypal.rawCaptureResponse = paypalResponse;

  order.supplierOrder.createStatus = 'NOT_CREATED';

  order.lastPaymentErrorCode = 'PAYPAL_CAPTURE_PENDING';

  order.lastPaymentErrorMessage = pendingReason
    ? `PayPal capture is pending: ${pendingReason}`
    : 'PayPal capture is still pending.';

  await order.save();

  req.session.cjPayment = {
    source: 'CJ',

    localOrderId: String(order._id),

    cjOrderNumber: order.cjOrderNumber,

    paypalOrderId: order.paypal.orderId,

    paypalCaptureId: order.paypal.captureId,

    captureStatus,

    updatedAt: new Date().toISOString(),
  };

  req.session.cjLastOrder = {
    source: 'CJ',

    cjOrderNumber: order.cjOrderNumber,

    localOrderId: String(order._id),
  };

  req.session.storeDepartment = 'cj';

  return order;
}

async function markCjPaymentFailedWithoutCapture({
  order,
  paypalResponse = null,
  error = null,
  code = 'CJ_PAYPAL_CAPTURE_FAILED_NO_CAPTURE',
  message = 'PayPal did not confirm a payment capture for this CJ order.',
} = {}) {
  order.status = 'PAYMENT_FAILED';

  order.paymentStatus = 'FAILED';

  order.fulfillmentStatus = 'PENDING';

  order.paypal.orderStatus = safeString(paypalResponse?.status || order.paypal?.orderStatus, 100).toUpperCase();

  order.paypal.captureStatus = '';

  order.supplierOrder.createStatus = 'NOT_CREATED';

  order.lastPaymentErrorCode = safeString(error?.code || code, 200);

  order.lastPaymentErrorMessage = safeString(error?.message || message, 2000);

  await order.save();

  return order;
}

async function recordCjPaymentVerificationUnknown({ order, error }) {
  order.lastPaymentErrorCode = safeString(error?.code || 'CJ_PAYPAL_CAPTURE_VERIFY_FAILED', 200);

  order.lastPaymentErrorMessage = safeString(
    error?.message ||
      'Kasyora could not verify the PayPal payment status after the capture request failed.',
    2000,
  );

  await order.save();

  return order;
}

function redirectToCjCheckoutWithPaymentIssue(req, res, { issue, orderNumber = '' } = {}) {
  req.session.storeDepartment = 'cj';

  const params = new URLSearchParams();

  params.set('paymentIssue', safeString(issue || 'PAYMENT_FAILED', 80));

  if (orderNumber) {
    params.set('cjOrderNumber', safeString(orderNumber, 100));
  }

  return req.session.save(() => {
    return res.redirect(`/cj/checkout?${params.toString()}`);
  });
}

async function finalizePaypalCaptureResponse({ req, order, paypalResponse }) {
  const capture = getPaypalCapture(paypalResponse);

  if (!capture) {
    return {
      completed: false,
      pending: false,
      capture: null,
    };
  }

  const captureStatus = safeString(capture?.status, 100).toUpperCase();

  if (captureStatus === 'COMPLETED') {
    await finalizeCompletedCjPayment({
      req,
      order,
      paypalResponse,
      capture,
    });

    return {
      completed: true,
      pending: false,
      capture,
    };
  }

  if (captureStatus === 'PENDING') {
    await finalizePendingCjPayment({
      req,
      order,
      paypalResponse,
      capture,
    });

    return {
      completed: false,
      pending: true,
      capture,
    };
  }

  throw createPaymentError(
    'CJ_PAYPAL_CAPTURE_NOT_COMPLETED',
    `PayPal capture status is ${captureStatus || 'unknown'}.`,
    409,
  );
}

/*
 * GET /cj/payment/return
 *
 * PayPal redirects the payer here after approval.
 * The server captures the order and verifies the captured
 * currency and amount against CjOrder.paypal.amount.
 *
 * Production safety:
 * - If capture fails, Kasyora checks PayPal order status before deciding.
 * - If PayPal shows a completed capture, Kasyora recovers the order.
 * - If PayPal shows no capture, Kasyora marks the local order FAILED and does not create a CJ supplier order.
 * - If PayPal status cannot be verified, Kasyora does not silently say payment succeeded or failed.
 */
router.get('/cj/payment/return', async (req, res) => {
  const paypalOrderId = safeString(req.query?.token, 200);

  try {
    if (!paypalOrderId) {
      throw createPaymentError(
        'CJ_PAYMENT_PAYPAL_ORDER_NOT_FOUND',
        'The PayPal order ID is missing.',
        400,
      );
    }

    const order = await CjOrder.findOne({
      'paypal.orderId': paypalOrderId,
    }).select('+paypal.rawCaptureResponse +metadata');

    if (!order) {
      throw createPaymentError(
        'CJ_PAYMENT_ORDER_NOT_FOUND',
        'The corresponding CJ order could not be found.',
        404,
      );
    }

    if (order.paymentStatus === 'COMPLETED' && order.paypal.captureId) {
      req.session.cjLastOrder = {
        source: 'CJ',

        cjOrderNumber: order.cjOrderNumber,

        localOrderId: String(order._id),
      };

      return req.session.save(() =>
        res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
      );
    }

    /*
     * The PayPal order has already created a capture, but PayPal is
     * still processing it. Never call the capture endpoint again.
     */
    if (
      order.paypal?.captureId &&
      String(order.paypal?.captureStatus || '').toUpperCase() === 'PENDING'
    ) {
      req.session.cjPayment = {
        source: 'CJ',

        localOrderId: String(order._id),

        cjOrderNumber: order.cjOrderNumber,

        paypalOrderId: order.paypal.orderId,

        paypalCaptureId: order.paypal.captureId,

        captureStatus: 'PENDING',

        updatedAt: new Date().toISOString(),
      };

      req.session.cjLastOrder = {
        source: 'CJ',

        cjOrderNumber: order.cjOrderNumber,

        localOrderId: String(order._id),
      };

      req.session.storeDepartment = 'cj';

      return req.session.save(() =>
        res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
      );
    }

    let captureResponse = null;

    try {
      captureResponse = await capturePaypalOrder({
        paypalOrderId,

        requestId: createRequestId(`cj-capture-${order._id}`),
      });
    } catch (captureError) {
      console.error('[CJ payment] PayPal capture request failed. Checking PayPal order status:', captureError?.stack || captureError);

      let paypalOrder = null;

      try {
        paypalOrder = await getPaypalOrder(paypalOrderId);
      } catch (verifyError) {
        console.error('[CJ payment] PayPal status verification also failed:', verifyError?.stack || verifyError);

        await recordCjPaymentVerificationUnknown({
          order,
          error: verifyError,
        });

        req.flash(
          'warning',
          'Kasyora could not verify the PayPal payment status. Please do not pay again if PayPal shows a charge. If PayPal shows no charge, you can safely try again.',
        );

        return redirectToCjCheckoutWithPaymentIssue(req, res, {
          issue: 'CAPTURE_STATUS_UNKNOWN',

          orderNumber: order.cjOrderNumber,
        });
      }

      const recovered = await finalizePaypalCaptureResponse({
        req,
        order,
        paypalResponse: paypalOrder,
      });

      if (recovered.completed || recovered.pending) {
        return req.session.save(() =>
          res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
        );
      }

      /*
       * PayPal is reachable and shows no capture.
       * This means Kasyora did not confirm money received.
       * Keep the cart/checkout, mark this local payment attempt failed,
       * and allow the customer to try PayPal again.
       */
      await markCjPaymentFailedWithoutCapture({
        order,

        paypalResponse: paypalOrder,

        error: captureError,

        code: 'CJ_PAYPAL_CAPTURE_FAILED_NO_CAPTURE',

        message:
          'PayPal did not confirm a payment capture. No CJ supplier order was created.',
      });

      delete req.session.cjPayment;

      req.flash(
        'error',
        'PayPal did not confirm your payment. No money was confirmed by Kasyora and no CJ supplier order was created. Please try PayPal again.',
      );

      return redirectToCjCheckoutWithPaymentIssue(req, res, {
        issue: 'CAPTURE_FAILED_NO_MONEY',

        orderNumber: order.cjOrderNumber,
      });
    }

    const finalized = await finalizePaypalCaptureResponse({
      req,

      order,

      paypalResponse: captureResponse,
    });

    if (finalized.completed || finalized.pending) {
      return req.session.save(() =>
        res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
      );
    }

    await markCjPaymentFailedWithoutCapture({
      order,

      paypalResponse: captureResponse,

      code: 'CJ_PAYPAL_CAPTURE_MISSING',

      message: 'PayPal did not return a completed payment capture.',
    });

    delete req.session.cjPayment;

    req.flash(
      'error',
      'PayPal did not confirm your payment. No money was confirmed by Kasyora and no CJ supplier order was created. Please try PayPal again.',
    );

    return redirectToCjCheckoutWithPaymentIssue(req, res, {
      issue: 'CAPTURE_FAILED_NO_MONEY',

      orderNumber: order.cjOrderNumber,
    });
  } catch (error) {
    console.error('[CJ payment] Capture failed:', error?.stack || error);

    req.flash(
      'error',
      safeString(error?.message || 'The CJ PayPal payment could not be completed.', 1000),
    );

    return redirectToCjCheckoutWithPaymentIssue(req, res, {
      issue: 'CAPTURE_ERROR',

      orderNumber: '',
    });
  }
});

/*
 * GET /cj/payment/cancel
 */
router.get('/cj/payment/cancel', async (req, res) => {
  const paypalOrderId = safeString(req.query?.token, 200);

  try {
    if (paypalOrderId) {
      await CjOrder.findOneAndUpdate(
        {
          'paypal.orderId': paypalOrderId,

          paymentStatus: {
            $ne: 'COMPLETED',
          },
        },
        {
          $set: {
            status: 'CANCELLED',

            paymentStatus: 'CANCELLED',

            cancelledAt: new Date(),

            'paypal.orderStatus': 'CANCELLED',
          },
        },
      );
    }
  } catch (error) {
    console.error('[CJ payment] Cancel update failed:', error?.message || error);
  }

  delete req.session.cjPayment;

  req.flash(
    'warning',
    'The CJ PayPal payment was cancelled. Your CJ cart and selected shipping method were preserved.',
  );

  return req.session.save(() => res.redirect('/cj/checkout'));
});

/*
 * GET /cj/order/success/:cjOrderNumber
 *
 * Displays a paid CJ order only to the session/user/business
 * that owns it. This route never queries the internal Order model.
 */
router.get('/cj/order/success/:cjOrderNumber', async (req, res) => {
  try {
    const cjOrderNumber = safeString(req.params?.cjOrderNumber, 100);

    if (!cjOrderNumber) {
      req.flash('error', 'The CJ order number is missing.');

      return res.redirect('/store');
    }

    const userId = getUserId(req);

    const businessBuyerId = getBusinessBuyerId(req);

    const guestSessionId = getGuestSessionReference(req);

    const ownershipFilters = [];

    if (userId) {
      ownershipFilters.push({
        userId,
      });
    }

    if (businessBuyerId) {
      ownershipFilters.push({
        businessBuyerId,
      });
    }

    if (guestSessionId) {
      ownershipFilters.push({
        guestSessionId,
      });
    }

    const lastOrderNumber = safeString(req.session?.cjLastOrder?.cjOrderNumber, 100);

    if (lastOrderNumber && lastOrderNumber === cjOrderNumber) {
      ownershipFilters.push({
        cjOrderNumber: lastOrderNumber,
      });
    }

    if (!ownershipFilters.length) {
      req.flash('error', 'This CJ order could not be accessed from the current session.');

      return res.redirect('/store');
    }

    const order = await CjOrder.findOne({
      cjOrderNumber,

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
      req.flash('error', 'The requested CJ order could not be found for this session.');

      return res.redirect('/store');
    }

    const normalizedPaymentStatus = String(order.paymentStatus || '').toUpperCase();

    const normalizedCaptureStatus = String(order.paypal?.captureStatus || '').toUpperCase();

    /*
     * Backward compatibility for CJ orders saved by the
     * previous version as APPROVED while the PayPal capture
     * was actually PENDING.
     */
    if (normalizedPaymentStatus === 'APPROVED' && normalizedCaptureStatus === 'PENDING') {
      order.paymentStatus = 'PENDING';
      order.status = 'PAYMENT_PENDING';
      order.fulfillmentStatus = 'PENDING';
    }

    const allowedPaymentStatuses = new Set(['PENDING', 'COMPLETED']);

    if (!allowedPaymentStatuses.has(String(order.paymentStatus || '').toUpperCase())) {
      req.flash('warning', 'This CJ order is not available as an active payment.');

      return res.redirect('/cj/checkout');
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
 * Checks an existing PayPal order without creating or capturing
 * another payment. This safely handles a capture that initially
 * returned PENDING.
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

      $or: ownershipFilters,
    }).select('+paypal.rawCaptureResponse +metadata');

    if (!order) {
      throw createPaymentError(
        'CJ_PAYMENT_ORDER_NOT_FOUND',
        'The CJ order could not be found.',
        404,
      );
    }

    if (order.paymentStatus === 'COMPLETED') {
      return res.json({
        success: true,
        completed: true,
        pending: false,
        cjOrderNumber: order.cjOrderNumber,
        redirectTo: `/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`,
      });
    }

    const paypalOrderId = safeString(order.paypal?.orderId, 200);

    if (!paypalOrderId) {
      throw createPaymentError(
        'CJ_PAYMENT_PAYPAL_ORDER_NOT_FOUND',
        'The PayPal order ID is unavailable.',
        404,
      );
    }

    const paypalOrder = await getPaypalOrder(paypalOrderId);

    const capture = getPaypalCapture(paypalOrder);

    if (!capture) {
      return res.json({
        success: true,
        completed: false,
        pending: true,
        status: safeString(paypalOrder?.status || 'PENDING', 100).toUpperCase(),
        message: 'PayPal is still processing the payment.',
      });
    }

    const captureStatus = safeString(capture?.status, 100).toUpperCase();

    if (captureStatus === 'COMPLETED') {
      await finalizeCompletedCjPayment({
        req,
        order,
        paypalResponse: paypalOrder,
        capture,
      });

      return req.session.save(() =>
        res.json({
          success: true,
          completed: true,
          pending: false,
          cjOrderNumber: order.cjOrderNumber,
          redirectTo: `/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`,
        }),
      );
    }

    order.paypal.captureStatus = captureStatus || 'PENDING';

    order.lastPaymentErrorCode =
      captureStatus === 'PENDING'
        ? 'PAYPAL_CAPTURE_PENDING'
        : `PAYPAL_CAPTURE_${captureStatus || 'UNKNOWN'}`;

    order.lastPaymentErrorMessage = safeString(
      capture?.status_details?.reason || `PayPal capture status is ${captureStatus || 'unknown'}.`,
      2000,
    );

    await order.save();

    return res.json({
      success: true,
      completed: false,
      pending: captureStatus === 'PENDING',
      status: captureStatus || 'PENDING',
      reason: safeString(capture?.status_details?.reason, 200),
      message:
        captureStatus === 'PENDING'
          ? 'PayPal is still processing the payment.'
          : `PayPal payment status is ${captureStatus || 'unknown'}.`,
    });
  } catch (error) {
    console.error('[CJ payment] Status check failed:', error?.stack || error);

    return sendPaymentError(res, error);
  }
});

module.exports = router;
