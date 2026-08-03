// routes/cjCheckout.js
'use strict';

const express = require('express');

const CjProduct = require('../models/CjProduct');

const COUNTRIES = require('../utils/countries');

const { ensureCjCart, publicCjCart } = require('../utils/cj/cjCart');

const {
  calculateCjFreight,
  DEFAULT_ORIGIN_COUNTRY_CODE,
} = require('../utils/cj/cjLogisticsService');

const {
  requiresCjIossNumber,
  normalizeCjIossNumber,
  getConfiguredCjIossNumber,
} = require('../utils/cj/iossCountries');

const {
  CJ_BUYER_TAX_ID_RULES,
  normalizeBuyerTaxId,
  validateCjBuyerTaxId,
} = require('../utils/cj/taxIdCountries');

const router = express.Router();

const BASE_CURRENCY =
  String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase() || 'USD';

function safeString(value, maxLength = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizeQuantity(value) {
  const parsed = Number.parseInt(String(value ?? '').trim(), 10);

  if (!Number.isFinite(parsed)) {
    return 1;
  }

  return Math.max(1, Math.min(100, parsed));
}

function normalizeCountryCode(value) {
  const code = safeString(value, 2).toUpperCase();

  return /^[A-Z]{2}$/.test(code) ? code : '';
}

function normalizeEmail(value) {
  return safeString(value, 320).toLowerCase();
}

function digitsOnly(value, maxLength = 100) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, maxLength);
}

function normalizePhone(value) {
  return safeString(value, 50).replace(/[^\d+()\-\s]/g, '');
}

function isGloballyUsablePhone(value) {
  const digits = digitsOnly(value, 30);

  return digits.length >= 6 && digits.length <= 20;
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

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

function createCheckoutError(code, message, status = 400) {
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

  const code = safeString(error?.code, 100);

  if (
    [
      'CJ_CHECKOUT_CART_EMPTY',
      'CJ_CHECKOUT_ADDRESS_INVALID',
      'CJ_DESTINATION_COUNTRY_CODE_INVALID',
      'CJ_ORIGIN_COUNTRY_CODE_INVALID',
      'CJ_FREIGHT_PRODUCTS_EMPTY',
      'CJ_CHECKOUT_IOSS_REQUIRED',
      'CJ_CHECKOUT_BUYER_TAX_ID_REQUIRED',
    ].includes(code)
  ) {
    return 400;
  }

  if (['CJ_CHECKOUT_PRODUCT_NOT_ACTIVE', 'CJ_CHECKOUT_VARIANT_NOT_AVAILABLE'].includes(code)) {
    return 404;
  }

  if (['CJ_CHECKOUT_INSUFFICIENT_INVENTORY', 'CJ_CHECKOUT_PRICE_CHANGED'].includes(code)) {
    return 409;
  }

  if (code === 'CJ_NO_LOGISTICS_OPTIONS') {
    return 422;
  }

  return 500;
}

function sendCheckoutError(res, error) {
  return res.status(errorStatus(error)).json({
    success: false,

    code: safeString(error?.code || 'CJ_CHECKOUT_ERROR', 100),

    message: safeString(error?.message || 'The CJ checkout request could not be completed.', 1000),

    requestId: safeString(error?.requestId, 200),
  });
}

function buildPaymentNotice(query = {}) {
  const issue = safeString(query.paymentIssue, 80).toUpperCase();

  const paypalReference = safeString(query.paypalReference || query.cjOrderNumber, 100);

  if (!issue) {
    return null;
  }

  if (issue === 'CAPTURE_FAILED_NO_MONEY') {
    return {
      type: 'danger',

      title: 'PayPal payment was not completed',

      message:
        'PayPal did not return a completed capture ID. Kasyora did not confirm money, did not create a CJ order, and did not create a CJ supplier order. You can safely try PayPal again only if PayPal shows no charge.',

      paypalReference,
    };
  }

  if (issue === 'CAPTURE_PENDING') {
    return {
      type: 'warning',

      title: 'PayPal payment is still pending',

      message:
        'PayPal has not completed the capture yet. Kasyora has not created a CJ order or CJ supplier order. Please check PayPal before trying again.',

      paypalReference,
    };
  }

  if (issue === 'CAPTURE_STATUS_UNKNOWN') {
    return {
      type: 'warning',

      title: 'PayPal payment status could not be verified',

      message:
        'Kasyora could not verify PayPal after the capture request failed. No CJ order or CJ supplier order was created. Do not pay again if PayPal shows a charge. If PayPal shows no charge, you can try again.',

      paypalReference,
    };
  }

  if (issue === 'PAYPAL_CANCELLED') {
    return {
      type: 'info',

      title: 'PayPal checkout was cancelled',

      message: 'No CJ order was created and no CJ supplier order was created.',

      paypalReference,
    };
  }

  return {
    type: 'danger',

    title: 'CJ PayPal payment could not be completed',

    message:
      'The CJ PayPal payment could not be completed. Kasyora did not create a CJ order or CJ supplier order. Please try again only if PayPal shows no charge.',

    paypalReference,
  };
}

function normalizeDeliveryAddress(body = {}) {
  const address = {
    firstName: safeString(body.firstName, 100),

    lastName: safeString(body.lastName, 100),

    email: normalizeEmail(body.email),

    phone: normalizePhone(body.phone),

    countryCode: normalizeCountryCode(body.countryCode),

    province: safeString(body.province || body.state, 200),

    city: safeString(body.city, 200),

    suburb: safeString(body.suburb, 200),

    addressLine1: safeString(body.addressLine1, 300),

    addressLine2: safeString(body.addressLine2, 300),

    postalCode: safeString(body.postalCode || body.zip, 50),

    houseNumber: safeString(body.houseNumber, 100),

    companyName: safeString(body.companyName, 200),

    taxId: normalizeBuyerTaxId(body.taxId),

    iossNumber: normalizeCjIossNumber(body.iossNumber),
  };

  if (!address.firstName) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'First name is required.');
  }

  if (!address.lastName) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'Last name is required.');
  }

  if (!address.email || !validEmail(address.email)) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'A valid email address is required.');
  }

  if (!address.phone) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'Phone number is required.');
  }

  if (!address.countryCode) {
    throw createCheckoutError(
      'CJ_CHECKOUT_ADDRESS_INVALID',
      'Please select a valid destination country.',
    );
  }

  if (!address.province) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'Province or state is required.');
  }

  if (!address.city) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'City is required.');
  }

  if (!address.addressLine1) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'Street address is required.');
  }

  if (!address.postalCode) {
    throw createCheckoutError('CJ_CHECKOUT_ADDRESS_INVALID', 'Postal code is required.');
  }

  if (address.countryCode === 'ZA') {
    const cjPhone = normalizeCjSouthAfricaPhone(address.phone);

    if (!cjPhone) {
      throw createCheckoutError(
        'CJ_CHECKOUT_ADDRESS_INVALID',
        'For South Africa CJ delivery, enter a valid phone number like 0632207320, 632207320, or 27632207320.',
      );
    }

    /*
     * Store the CJ-safe South Africa phone value in the session before PayPal payment.
     * South Africa Tax ID / Consignee ID is now validated through CJ_BUYER_TAX_ID_RULES
     * below, the same way as all other CJ Tax ID countries.
     */
    address.phone = cjPhone;
  } else if (!isGloballyUsablePhone(address.phone)) {
    throw createCheckoutError(
      'CJ_CHECKOUT_ADDRESS_INVALID',
      'Enter a reachable delivery phone number with 6 to 20 digits.',
    );
  }

  if (requiresCjIossNumber(address.countryCode)) {
    const configuredIossNumber = getConfiguredCjIossNumber();

    if (!configuredIossNumber) {
      throw createCheckoutError(
        'CJ_CHECKOUT_IOSS_REQUIRED',
        'EU CJ delivery is temporarily unavailable because Kasyora has not configured a valid IOSS number yet. Please choose a non-EU destination or contact support.',
        400,
      );
    }

    /*
     * Use Kasyora's configured IOSS number.
     * Do not trust customer-entered IOSS for production supplier orders.
     */
    address.iossNumber = configuredIossNumber;
  }

  const buyerTaxIdValidation = validateCjBuyerTaxId(address.countryCode, address.taxId);

  if (!buyerTaxIdValidation.ok) {
    throw createCheckoutError(
      'CJ_CHECKOUT_BUYER_TAX_ID_REQUIRED',
      buyerTaxIdValidation.message ||
        'This destination requires the buyer Tax ID before CJ payment.',
      400,
    );
  }

  if (buyerTaxIdValidation.required) {
    address.taxId = buyerTaxIdValidation.normalized;
  }

  return address;
}

function getVariantById(product, cjVariantId) {
  const wantedId = safeString(cjVariantId, 300);

  if (!wantedId || !Array.isArray(product?.variants)) {
    return null;
  }

  return (
    product.variants.find((variant) => safeString(variant?.cjVariantId, 300) === wantedId) || null
  );
}

function currentInventoryState(variant) {
  return {
    inventoryKnown: variant?.inventoryKnown === true,

    totalInventory: Math.max(0, Math.floor(Number(variant?.totalInventory || 0))),
  };
}

/*
 * Revalidate the authoritative CJ selling price.
 *
 * Kasyora adds and collects no VAT in the CJ flow.
 * Destination import VAT, customs duties and carrier charges
 * are outside this product-price calculation.
 */
function currentVariantPricing(product, variant) {
  const rawSellingPrice = Number(variant?.sellingPriceExVat?.value);

  const currency = safeString(
    variant?.sellingPriceExVat?.currency || product?.pricing?.baseCurrency || BASE_CURRENCY,
    3,
  ).toUpperCase();

  if (!Number.isFinite(rawSellingPrice) || rawSellingPrice < 0 || currency !== BASE_CURRENCY) {
    throw createCheckoutError(
      'CJ_CHECKOUT_PRICE_INVALID',
      'A CJ cart variant no longer has a valid Kasyora selling price.',
      409,
    );
  }

  const sellingPrice = round2(rawSellingPrice);

  return {
    /*
     * price is the VAT-free authoritative CJ selling price.
     *
     * priceExVat remains temporarily available for existing
     * CJ checkout, payment and order compatibility.
     */
    price: sellingPrice,

    priceExVat: sellingPrice,

    currency,

    vatRate: 0,
  };
}

function buildRefreshedCartItem({ product, variant, quantity, pricing, inventory, previousItem }) {
  return {
    source: 'CJ',

    cjProductId: safeString(product?.cjProductId, 300),

    cjVariantId: safeString(variant?.cjVariantId, 300),

    productSku: safeString(product?.productSku, 300),

    variantSku: safeString(variant?.variantSku, 300),

    name: safeString(product?.name || previousItem?.name || 'CJ Product', 500),

    variantName: safeString(
      variant?.variantName ||
        variant?.variantKey ||
        variant?.variantSku ||
        previousItem?.variantName ||
        'Variant',
      500,
    ),

    imageUrl: safeString(
      variant?.imageUrl || product?.mainImageUrl || previousItem?.imageUrl,
      2000,
    ),

    category: safeString(
      product?.category?.name ||
        product?.category?.secondName ||
        product?.category?.firstName ||
        previousItem?.category ||
        'CJ Product',
      500,
    ),

    quantity,

    /*
     * The refreshed checkout item remains VAT-free.
     *
     * Both price fields temporarily contain the same amount
     * so older CJ payment and order code remains operational
     * until those files are patched.
     */
    price: round2(pricing.price ?? pricing.priceExVat),

    priceExVat: round2(pricing.priceExVat ?? pricing.price),

    currency: pricing.currency,

    vatRate: 0,

    vatIncluded: false,

    weightGrams: Number.isFinite(Number(variant?.weightGrams)) ? Number(variant.weightGrams) : null,

    dimensionsMm: {
      length: Number.isFinite(Number(variant?.dimensionsMm?.length))
        ? Number(variant.dimensionsMm.length)
        : null,

      width: Number.isFinite(Number(variant?.dimensionsMm?.width))
        ? Number(variant.dimensionsMm.width)
        : null,

      height: Number.isFinite(Number(variant?.dimensionsMm?.height))
        ? Number(variant.dimensionsMm.height)
        : null,
    },

    inventoryKnown: inventory.inventoryKnown,

    inventorySnapshot: inventory.totalInventory,

    addedAt: previousItem?.addedAt || new Date().toISOString(),

    validatedAt: new Date().toISOString(),
  };
}

async function revalidateCjCart(req) {
  const sessionCart = ensureCjCart(req);

  const currentItems = Array.isArray(sessionCart.items) ? sessionCart.items : [];

  if (!currentItems.length) {
    throw createCheckoutError('CJ_CHECKOUT_CART_EMPTY', 'Your CJ cart is empty.');
  }

  const refreshedItems = [];

  for (const currentItem of currentItems) {
    const cjProductId = safeString(currentItem?.cjProductId, 300);

    const cjVariantId = safeString(currentItem?.cjVariantId, 300);

    const quantity = normalizeQuantity(currentItem?.quantity);

    const product = await CjProduct.findOne({
      cjProductId,
      status: 'active',
    });

    if (!product) {
      throw createCheckoutError(
        'CJ_CHECKOUT_PRODUCT_NOT_ACTIVE',
        `The CJ product "${safeString(
          currentItem?.name || cjProductId,
          300,
        )}" is no longer available.`,
        404,
      );
    }

    const variant = getVariantById(product, cjVariantId);

    if (!variant || variant.isEnabled !== true) {
      throw createCheckoutError(
        'CJ_CHECKOUT_VARIANT_NOT_AVAILABLE',
        `The selected variant for "${safeString(
          product?.name || currentItem?.name,
          300,
        )}" is no longer available.`,
        404,
      );
    }

    const inventory = currentInventoryState(variant);

    if (inventory.inventoryKnown && inventory.totalInventory < quantity) {
      throw createCheckoutError(
        'CJ_CHECKOUT_INSUFFICIENT_INVENTORY',
        `Only ${inventory.totalInventory} unit(s) of "${safeString(
          product?.name,
          300,
        )}" are currently available.`,
        409,
      );
    }

    const pricing = currentVariantPricing(product, variant);

    refreshedItems.push(
      buildRefreshedCartItem({
        product,
        variant,
        quantity,
        pricing,
        inventory,
        previousItem: currentItem,
      }),
    );
  }

  sessionCart.items = refreshedItems;

  sessionCart.updatedAt = new Date().toISOString();

  req.session.storeDepartment = 'cj';

  return publicCjCart(sessionCart);
}

/*
 * Attach the VAT-free product total to every real CJ
 * logistics option.
 *
 * taxesFeeUsd, tariffUsd and other logistics fields below
 * are values returned by CJ's logistics quotation.
 * They are not Kasyora-added VAT and must remain available
 * for supplier-order and logistics auditing.
 */
function normalizeQuoteOptions(options, productTotal) {
  const safeProductTotal = round2(productTotal);

  return (Array.isArray(options) ? options : []).map((option) => {
    const shippingAmount = round2(option?.freight?.value);

    return {
      id: safeString(option?.id, 300),

      logisticsName: safeString(option?.logisticsName, 300),

      logisticsModel: safeString(option?.logisticsModel, 200),

      deliveryEstimate: safeString(option?.deliveryEstimate, 100),

      optionId: safeString(option?.optionId, 300),

      channelId: safeString(option?.channelId, 300),

      freightUsd: round2(option?.freightUsd),

      shippingAmount,

      currency: safeString(option?.freight?.currency || BASE_CURRENCY, 3).toUpperCase(),

      taxesFeeUsd: round2(option?.taxesFeeUsd),

      clearanceOperationFeeUsd: round2(option?.clearanceOperationFeeUsd),

      tariffUsd: round2(option?.tariffUsd),

      remoteFeeUsd: round2(option?.remoteFeeUsd),

      message: safeString(option?.message, 1000),

      fxSnapshot: {
        rate: Number(option?.fxSnapshot?.rate || 0),

        from: safeString(option?.fxSnapshot?.from || 'USD', 3).toUpperCase(),

        to: safeString(option?.fxSnapshot?.to || BASE_CURRENCY, 3).toUpperCase(),

        provider: safeString(option?.fxSnapshot?.provider, 100),

        convertedAt: option?.fxSnapshot?.convertedAt || new Date().toISOString(),
      },

      /*
       * New authoritative VAT-free fields.
       */
      productTotal: safeProductTotal,

      payableTotal: round2(safeProductTotal + shippingAmount),

      /*
       * Temporary compatibility field.
       *
       * The value contains no VAT. It remains only until
       * routes/cjPayment.js has been patched.
       */
      productTotalIncVat: safeProductTotal,
    };
  });
}

/*
 * GET /cj/checkout
 *
 * Renders only the separate CJ checkout page.
 */
router.get('/cj/checkout', async (req, res) => {
  try {
    const cart = publicCjCart(ensureCjCart(req));

    if (!cart.items.length) {
      req.flash('warning', 'Your CJ cart is empty.');

      return res.redirect('/cj/cart');
    }

    req.session.storeDepartment = 'cj';

    const previousCheckout =
      req.session?.cjCheckout && typeof req.session.cjCheckout === 'object'
        ? req.session.cjCheckout
        : null;

    const paymentNotice = buildPaymentNotice(req.query || {});

    return res.render('cj/checkout', {
      layout: 'layouts/store',

      title: 'CJ Checkout',

      storeDepartment: 'cj',

      productSource: 'CJ',

      cart,

      cartItems: cart.items,

      itemCount: cart.itemCount,

      /*
       * New authoritative VAT-free CJ summary fields.
       */
      subtotal: cart.subtotal,

      total: cart.total,

      /*
       * Temporary compatibility fields for checkout.ejs.
       *
       * These values contain no Kasyora-added VAT.
       */
      subtotalExVat: cart.subtotal,

      vatAmount: 0,

      totalIncVat: cart.total,

      savedAddress: previousCheckout?.deliveryAddress || null,

      savedQuote: previousCheckout?.quote || null,

      savedSelectedShipping: previousCheckout?.selectedShipping || null,

      paymentNotice,

      countries: COUNTRIES,

      COUNTRIES,

      baseCurrency: BASE_CURRENCY,

      vatRate: 0,

      defaultOriginCountryCode: DEFAULT_ORIGIN_COUNTRY_CODE,

      cjBuyerTaxIdRules: CJ_BUYER_TAX_ID_RULES,
    });
  } catch (error) {
    console.error('[CJ checkout] Page load failed:', error?.stack || error);

    req.flash('error', 'The CJ checkout page could not be loaded.');

    return res.redirect('/cj/cart');
  }
});

/*
 * POST /api/cj-checkout/quote
 *
 * Validates the address and current CJ cart,
 * requests actual CJ logistics options,
 * then stores the snapshot only in
 * req.session.cjCheckout.
 */
router.post('/api/cj-checkout/quote', async (req, res) => {
  try {
    const deliveryAddress = normalizeDeliveryAddress(req.body || {});

    const cart = await revalidateCjCart(req);

    const freight = await calculateCjFreight({
      cartItems: cart.items,

      destinationCountryCode: deliveryAddress.countryCode,

      postalCode: deliveryAddress.postalCode,

      houseNumber: deliveryAddress.houseNumber,

      taxId: deliveryAddress.taxId,

      iossNumber: deliveryAddress.iossNumber,
    });

    const quoteOptions = normalizeQuoteOptions(freight.options, cart.total);

    if (!quoteOptions.length) {
      throw createCheckoutError(
        'CJ_NO_LOGISTICS_OPTIONS',
        'CJ did not return any available shipping methods for this destination.',
        422,
      );
    }

    const quote = {
      source: 'CJ',

      requestId: safeString(freight.requestId, 200),

      originCountryCode: safeString(freight.originCountryCode, 2),

      destinationCountryCode: safeString(freight.destinationCountryCode, 2),

      currency: BASE_CURRENCY,

      /*
       * New authoritative VAT-free quote amounts.
       */
      productSubtotal: round2(cart.subtotal),

      productVatAmount: 0,

      productTotal: round2(cart.total),

      /*
       * Temporary compatibility fields.
       *
       * Their names are historical only. Their values contain
       * no Kasyora-added VAT.
       */
      productSubtotalExVat: round2(cart.subtotal),

      productTotalIncVat: round2(cart.total),

      itemCount: Number(cart.itemCount || 0),

      options: quoteOptions,

      quotedAt: new Date().toISOString(),

      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    req.session.cjCheckout = {
      source: 'CJ',

      deliveryAddress,

      cartSnapshot: {
        source: 'CJ',

        items: cart.items.map((item) => ({
          ...item,
        })),

        itemCount: cart.itemCount,

        /*
         * New authoritative VAT-free cart snapshot.
         */
        subtotal: cart.subtotal,

        vatAmount: 0,

        total: cart.total,

        /*
         * Temporary compatibility fields.
         */
        subtotalExVat: cart.subtotal,

        totalIncVat: cart.total,

        capturedAt: new Date().toISOString(),
      },

      quote,

      selectedShipping: null,

      updatedAt: new Date().toISOString(),
    };

    req.session.storeDepartment = 'cj';

    return req.session.save((saveError) => {
      if (saveError) {
        console.error('[CJ checkout] Session save failed:', saveError);

        return res.status(500).json({
          success: false,

          code: 'CJ_CHECKOUT_SESSION_SAVE_FAILED',

          message:
            'The CJ shipping quotation was calculated but could not be saved. Please try again.',
        });
      }

      return res.json({
        success: true,

        message: 'CJ shipping methods calculated successfully.',

        source: 'CJ',

        deliveryAddress,

        quote,
      });
    });
  } catch (error) {
    console.error('[CJ checkout] Quote failed:', error?.stack || error);

    return sendCheckoutError(res, error);
  }
});

/*
 * POST /api/cj-checkout/select-shipping
 *
 * Saves only a shipping option that exists in the most recent
 * server-side CJ quote. The browser cannot invent its own price.
 */
router.post('/api/cj-checkout/select-shipping', (req, res) => {
  try {
    const optionId = safeString(req.body?.optionId, 300);

    if (!optionId) {
      throw createCheckoutError(
        'CJ_SHIPPING_OPTION_REQUIRED',
        'Please select a CJ shipping method.',
        400,
      );
    }

    const checkout = req.session?.cjCheckout;

    if (!checkout || checkout.source !== 'CJ') {
      throw createCheckoutError(
        'CJ_CHECKOUT_SESSION_MISSING',
        'Your CJ checkout session has expired. Please calculate shipping again.',
        409,
      );
    }

    const quote = checkout.quote;

    const options = Array.isArray(quote?.options) ? quote.options : [];

    if (!options.length) {
      throw createCheckoutError(
        'CJ_CHECKOUT_QUOTE_MISSING',
        'Your CJ shipping quotation is unavailable. Please calculate shipping again.',
        409,
      );
    }

    const expiresAt = quote?.expiresAt ? new Date(quote.expiresAt) : null;

    if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw createCheckoutError(
        'CJ_CHECKOUT_QUOTE_EXPIRED',
        'Your CJ shipping quotation has expired. Please calculate shipping again.',
        409,
      );
    }

    const selectedOption = options.find((option) => safeString(option?.id, 300) === optionId);

    if (!selectedOption) {
      throw createCheckoutError(
        'CJ_SHIPPING_OPTION_INVALID',
        'The selected CJ shipping method is no longer available.',
        409,
      );
    }

    const shippingAmount = round2(selectedOption?.shippingAmount);

    const productTotal = round2(quote?.productTotal ?? quote?.productTotalIncVat ?? 0);

    const payableTotal = round2(productTotal + shippingAmount);

    const selectedShipping = {
      source: 'CJ',

      id: safeString(selectedOption?.id, 300),

      logisticsName: safeString(selectedOption?.logisticsName, 300),

      logisticsModel: safeString(selectedOption?.logisticsModel, 200),

      deliveryEstimate: safeString(selectedOption?.deliveryEstimate, 100),

      optionId: safeString(selectedOption?.optionId, 300),

      channelId: safeString(selectedOption?.channelId, 300),

      shippingAmount,

      freightUsd: round2(selectedOption?.freightUsd),

      currency: safeString(selectedOption?.currency || BASE_CURRENCY, 3).toUpperCase(),

      /*
       * Authoritative VAT-free product and payable totals.
       */
      productTotal,

      payableTotal,

      /*
       * Temporary compatibility field for cjPayment.js.
       *
       * Its value contains no VAT.
       */
      productTotalIncVat: productTotal,

      taxesFeeUsd: round2(selectedOption?.taxesFeeUsd),

      clearanceOperationFeeUsd: round2(selectedOption?.clearanceOperationFeeUsd),

      tariffUsd: round2(selectedOption?.tariffUsd),

      remoteFeeUsd: round2(selectedOption?.remoteFeeUsd),

      message: safeString(selectedOption?.message, 1000),

      fxSnapshot: {
        rate: Number(selectedOption?.fxSnapshot?.rate || 0),

        from: safeString(selectedOption?.fxSnapshot?.from || 'USD', 3).toUpperCase(),

        to: safeString(selectedOption?.fxSnapshot?.to || BASE_CURRENCY, 3).toUpperCase(),

        provider: safeString(selectedOption?.fxSnapshot?.provider, 100),

        convertedAt: selectedOption?.fxSnapshot?.convertedAt || new Date().toISOString(),
      },

      quoteRequestId: safeString(quote?.requestId, 200),

      quoteExpiresAt: quote?.expiresAt,

      selectedAt: new Date().toISOString(),
    };

    req.session.cjCheckout.selectedShipping = selectedShipping;

    req.session.cjCheckout.updatedAt = new Date().toISOString();

    req.session.storeDepartment = 'cj';

    return req.session.save((saveError) => {
      if (saveError) {
        console.error('[CJ checkout] Selected shipping session save failed:', saveError);

        return res.status(500).json({
          success: false,

          code: 'CJ_SELECTED_SHIPPING_SAVE_FAILED',

          message: 'The selected CJ shipping method could not be saved. Please try again.',
        });
      }

      return res.json({
        success: true,

        message: 'CJ shipping method selected successfully.',

        source: 'CJ',

        selectedShipping,
      });
    });
  } catch (error) {
    console.error('[CJ checkout] Shipping selection failed:', error?.stack || error);

    return sendCheckoutError(res, error);
  }
});

module.exports = router;
