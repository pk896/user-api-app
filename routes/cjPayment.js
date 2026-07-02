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

/*
 * GET /cj/payment/return
 *
 * PayPal redirects the payer here after approval.
 * The server captures the order and verifies the captured
 * currency and amount against CjOrder.paypal.amount.
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

    const captureResponse = await capturePaypalOrder({
      paypalOrderId,

      requestId: createRequestId(`cj-capture-${order._id}`),
    });

    const capture = getPaypalCapture(captureResponse);

    if (!capture) {
      throw createPaymentError(
        'CJ_PAYPAL_CAPTURE_MISSING',
        'PayPal did not return a completed payment capture.',
        502,
      );
    }

    const captureStatus = safeString(capture.status, 100).toUpperCase();

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

    const payer = captureResponse?.payer || {};

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

    order.paypal.orderStatus = safeString(captureResponse?.status, 100).toUpperCase();

    order.paypal.captureId = safeString(capture.id, 200);

    order.paypal.captureStatus = captureStatus;

    order.paypal.capturedAt = capture?.create_time ? new Date(capture.create_time) : new Date();

    order.paypal.rawCaptureResponse = captureResponse;

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

    return req.session.save(() =>
      res.redirect(`/cj/order/success/${encodeURIComponent(order.cjOrderNumber)}`),
    );
  } catch (error) {
    console.error('[CJ payment] Capture failed:', error?.stack || error);

    req.flash(
      'error',
      safeString(error?.message || 'The CJ PayPal payment could not be completed.', 1000),
    );

    return res.redirect('/cj/checkout');
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

    if (order.paymentStatus !== 'COMPLETED') {
      req.flash('warning', 'This CJ order has not yet been confirmed as paid.');

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

module.exports = router;
