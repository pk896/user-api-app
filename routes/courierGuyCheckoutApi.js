// routes/courierGuyCheckoutApi.js
'use strict';

const express = require('express');

const Product = require('../models/Product');
const Warehouse = require('../models/Warehouse');

const { getCourierGuyConfig } = require('../utils/courierGuy/courierGuyConfig');

const { getCourierGuyRates } = require('../utils/courierGuy/getCourierGuyRates');

const { convertMoneyAmount } = require('../utils/fx/getFxRate');

const {
  resolveWarehouseForCart,
  publicWarehouseMeta,
} = require('../utils/payment/resolveWarehouseForCart');

const router = express.Router();

function normalizeText(value, max = 300) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function normalizeCountry(value) {
  const country = normalizeText(value, 2).toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : '';
}

function toQty(value, fallback = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;

  const quantity = Math.floor(number);
  return quantity >= 1 ? quantity : fallback;
}

function cartSignature(cart) {
  const items = Array.isArray(cart?.items) ? cart.items : [];

  return items
    .map((item) => {
      const id = normalizeText(
        item?.customId || item?.productId || item?.pid || item?.sku || '',
        150,
      );

      return `${id}:${toQty(item?.qty ?? item?.quantity, 1)}`;
    })
    .sort()
    .join('|');
}

function shippingInputFromRequest(req) {
  const body = req.body || {};

  const source =
    body.shipTo && typeof body.shipTo === 'object'
      ? body.shipTo
      : body.shipping && typeof body.shipping === 'object'
        ? body.shipping
        : body;

  const fullName = normalizeText(source.fullName || source.name || source.full_name, 120);

  const phone = normalizeText(source.phone, 50);
  const email = normalizeText(source.email, 160);

  const line1 = normalizeText(
    source.address_line_1 || source.line1 || source.street1 || source.address1,
    300,
  );

  const line2 = normalizeText(
    source.suburb ||
      source.local_area ||
      source.localArea ||
      source.address_line_2 ||
      source.line2 ||
      source.street2 ||
      source.address2,
    300,
  );

  const city = normalizeText(source.admin_area_2 || source.city, 120);

  const state = normalizeText(source.admin_area_1 || source.state || source.province, 120);

  const postalCode = normalizeText(source.postal_code || source.postalCode || source.zip, 60);

  const countryCode = normalizeCountry(source.country_code || source.countryCode || source.country);

  const missing = [];

  if (!fullName) missing.push('full name');
  if (!phone) missing.push('phone');
  if (!line1) missing.push('street address');
  if (!line2) missing.push('suburb / local area');
  if (!city) missing.push('city');
  if (!state) missing.push('province/state');
  if (!postalCode) missing.push('postal code');
  if (!countryCode) missing.push('country');

  if (missing.length) {
    const error = new Error(`Missing shipping fields: ${missing.join(', ')}`);

    error.code = 'SHIPPING_ADDRESS_INVALID';
    throw error;
  }

  return {
    fullName,
    phone,
    email: email || null,

    address: {
      address_line_1: line1,
      address_line_2: line2,
      admin_area_2: city,
      admin_area_1: state,
      postal_code: postalCode,
      country_code: countryCode,
    },
  };
}

function destinationFromShippingInput(shippingInput) {
  return {
    country: shippingInput.address.country_code,
    state: shippingInput.address.admin_area_1,
  };
}

function sameAddress(a, b) {
  if (!a || !b) return false;

  const normalize = (value) =>
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');

  return (
    normalize(a.fullName) === normalize(b.fullName) &&
    normalize(a.phone) === normalize(b.phone) &&
    normalize(a.address?.address_line_1) === normalize(b.address?.address_line_1) &&
    normalize(a.address?.address_line_2) === normalize(b.address?.address_line_2) &&
    normalize(a.address?.admin_area_2) === normalize(b.address?.admin_area_2) &&
    normalize(a.address?.admin_area_1) === normalize(b.address?.admin_area_1) &&
    normalize(a.address?.postal_code) === normalize(b.address?.postal_code) &&
    normalize(a.address?.country_code) === normalize(b.address?.country_code)
  );
}

function publicRate(rate) {
  return {
    providerKey: 'courier_guy',
    providerLabel: 'The Courier Guy',

    rateId: String(rate.rateId || ''),
    serviceLevelId: String(rate.serviceLevelId || ''),
    serviceCode: String(rate.serviceCode || ''),
    service: String(rate.service || ''),
    description: String(rate.description || ''),

    amount: Number(rate.amount || 0),
    amountExcludingVat: rate.amountExcludingVat == null ? null : Number(rate.amountExcludingVat),
    currency: String(rate.currency || process.env.BASE_CURRENCY || 'USD')
      .trim()
      .toUpperCase(),

    vat: rate.vat == null ? null : Number(rate.vat),

    vatPercentage: rate.vatPercentage == null ? null : Number(rate.vatPercentage),

    collectionDate: rate.collectionDate || null,
    collectionCutOffTime: rate.collectionCutOffTime || null,

    deliveryDateFrom: rate.deliveryDateFrom || null,

    deliveryDateTo: rate.deliveryDateTo || null,

    actualWeight: rate.actualWeight ?? null,
    chargedWeight: rate.chargedWeight ?? null,
    volumetricWeight: rate.volumetricWeight ?? null,

    extras: Array.isArray(rate.extras) ? rate.extras : [],

    surcharges: Array.isArray(rate.surcharges) ? rate.surcharges : [],
  };
}

async function convertCourierGuyRatesToBaseCurrency(rates) {
  const targetCurrency = String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase();

  const sourceRates = Array.isArray(rates) ? rates : [];

  const convertedRates = [];

  for (const rate of sourceRates) {
    const originalAmount = Number(rate?.amount);

    const originalCurrency = String(rate?.currency || 'ZAR')
      .trim()
      .toUpperCase();

    if (!Number.isFinite(originalAmount) || originalAmount < 0) {
      console.warn('[Courier Guy rate skipped: invalid amount]', {
        rateId: rate?.rateId || '',
        amount: rate?.amount,
      });

      continue;
    }

    if (originalCurrency === targetCurrency) {
      convertedRates.push({
        ...rate,
        amount: Number(originalAmount.toFixed(2)),
        currency: targetCurrency,

        originalAmount: Number(originalAmount.toFixed(2)),

        originalCurrency,
      });

      continue;
    }

    try {
      const conversion = await convertMoneyAmount(originalAmount, originalCurrency, targetCurrency);

      let convertedAmountExcludingVat = null;
      let convertedVat = null;

      if (
        rate?.amountExcludingVat !== null &&
        rate?.amountExcludingVat !== undefined &&
        Number.isFinite(Number(rate.amountExcludingVat))
      ) {
        const excludingVatConversion = await convertMoneyAmount(
          Number(rate.amountExcludingVat),
          originalCurrency,
          targetCurrency,
        );

        convertedAmountExcludingVat = Number(Number(excludingVatConversion.value).toFixed(2));
      }

      if (rate?.vat !== null && rate?.vat !== undefined && Number.isFinite(Number(rate.vat))) {
        const vatConversion = await convertMoneyAmount(
          Number(rate.vat),
          originalCurrency,
          targetCurrency,
        );

        convertedVat = Number(Number(vatConversion.value).toFixed(2));
      }

      convertedRates.push({
        ...rate,

        amount: Number(Number(conversion.value).toFixed(2)),

        amountExcludingVat: convertedAmountExcludingVat,

        vat: convertedVat,

        currency: String(conversion.currency || targetCurrency)
          .trim()
          .toUpperCase(),

        originalAmount: Number(originalAmount.toFixed(2)),

        originalAmountExcludingVat:
          rate?.amountExcludingVat == null ? null : Number(rate.amountExcludingVat),

        originalVat: rate?.vat == null ? null : Number(rate.vat),

        originalCurrency,

        fx: conversion.fx || null,
      });

      console.log('[Courier Guy FX converted]', {
        rateId: rate?.rateId || '',
        from: originalCurrency,
        to: targetCurrency,
        originalAmount,
        convertedAmount: conversion.value,
        provider: conversion?.fx?.provider || '',
      });
    } catch (error) {
      console.warn('[Courier Guy rate skipped: FX conversion failed]', {
        rateId: rate?.rateId || '',
        from: originalCurrency,
        to: targetCurrency,
        amount: originalAmount,
        error: error?.message || String(error),
      });
    }
  }

  return convertedRates;
}

// ======================================================
// POST /payment/courier-guy/quote
// ======================================================
router.post('/courier-guy/quote', express.json(), async (req, res) => {
  try {
    const config = getCourierGuyConfig();

    if (!config.enabled) {
      return res.status(503).json({
        ok: false,
        code: 'COURIER_GUY_DISABLED',
        message: 'The Courier Guy rates are currently disabled.',
      });
    }

    const cart = req.session?.cart || {
      items: [],
    };

    if (!Array.isArray(cart.items) || cart.items.length === 0) {
      return res.status(422).json({
        ok: false,
        code: 'CART_EMPTY',
        message: 'Cart is empty.',
      });
    }

    const shippingInput = shippingInputFromRequest(req);

    // Courier Guy sandbox integration is currently
    // configured for South African domestic shipments.
    if (shippingInput.address.country_code !== 'ZA') {
      return res.status(422).json({
        ok: false,
        code: 'COURIER_GUY_COUNTRY_UNSUPPORTED',
        message:
          'The Courier Guy rates are currently available only for South African delivery addresses.',
      });
    }

    const signature = cartSignature(cart);
    const currentQuote = req.session?.courierGuyQuote || null;

    const fresh = currentQuote?.createdAt && Date.now() - currentQuote.createdAt < 5 * 60 * 1000;

    if (
      currentQuote &&
      fresh &&
      currentQuote.cartSig === signature &&
      sameAddress(currentQuote.shippingInput, shippingInput) &&
      Array.isArray(currentQuote.rates) &&
      currentQuote.rates.length
    ) {
      return res.json({
        ok: true,
        cached: true,
        quoteId: currentQuote.quoteId,
        rates: currentQuote.rates,
        warehouse: currentQuote.warehouse || null,
      });
    }

    const warehouse = await resolveWarehouseForCart(cart, {
      to: destinationFromShippingInput(shippingInput),
      Warehouse,
    });

    if (!warehouse) {
      return res.status(422).json({
        ok: false,
        code: 'COURIER_GUY_WAREHOUSE_NOT_FOUND',
        message: 'No active warehouse is available for this delivery address.',
      });
    }

    const result = await getCourierGuyRates({
      cart,
      shippingInput,
      warehouse,
      Product,
    });

    // Shiplogic normally returns South African Courier Guy
    // prices in ZAR. Convert them into the application
    // BASE_CURRENCY before checkout and PayPal use them.
    const convertedRates = await convertCourierGuyRatesToBaseCurrency(result.rates);

    const rates = convertedRates.map(publicRate);

    if (!rates.length) {
      return res.status(502).json({
        ok: false,
        code: 'COURIER_GUY_NO_RATES',
        message: 'The Courier Guy returned no usable rates in the checkout currency.',
      });
    }

    const quoteId = ['CG', Date.now(), Math.random().toString(36).slice(2, 10)].join('-');

    req.session.courierGuyQuote = {
      quoteId,
      cartSig: signature,
      shippingInput,

      warehouseId: String(warehouse._id || ''),

      warehouseCode: warehouse.code || '',

      warehouse: publicWarehouseMeta(warehouse),

      rates,
      createdAt: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000,

      requestPayload: result.payload,
    };

    req.session.courierGuySelectedRate = null;

    await new Promise((resolve) => {
      if (req.session && typeof req.session.save === 'function') {
        req.session.save(() => resolve());
      } else {
        resolve();
      }
    });

    return res.json({
      ok: true,
      cached: false,
      quoteId,
      rates,
      warehouse: publicWarehouseMeta(warehouse),
    });
  } catch (error) {
    console.error('POST /payment/courier-guy/quote error:', error?.stack || error);

    const status =
      Number(error?.status) ||
      (error?.code === 'SHIPPING_ADDRESS_INVALID'
        ? 422
        : error?.code === 'PRODUCT_SHIPPING_MISSING'
          ? 422
          : 500);

    return res.status(status).json({
      ok: false,
      code: error?.code || 'COURIER_GUY_QUOTE_FAILED',
      message: error?.message || 'The Courier Guy rates could not be loaded.',
    });
  }
});

// ======================================================
// POST /payment/courier-guy/remember-rate
// ======================================================
router.post('/courier-guy/remember-rate', express.json(), async (req, res) => {
  try {
    const quoteId = normalizeText(req.body?.quoteId, 160);

    const rateId = normalizeText(req.body?.rateId || req.body?.serviceLevelId, 160);

    if (!quoteId || !rateId) {
      return res.status(400).json({
        ok: false,
        code: 'MISSING_FIELDS',
        message: 'Courier Guy quoteId and rateId are required.',
      });
    }

    const quote = req.session?.courierGuyQuote || null;

    const fresh = quote?.createdAt && Date.now() - quote.createdAt < 5 * 60 * 1000;

    if (!quote || !fresh || quote.quoteId !== quoteId) {
      return res.status(409).json({
        ok: false,
        code: 'COURIER_GUY_QUOTE_EXPIRED',
        message: 'The Courier Guy quote expired. Reload the rates and select again.',
      });
    }

    const picked = Array.isArray(quote.rates)
      ? quote.rates.find((rate) => String(rate.rateId) === String(rateId))
      : null;

    if (!picked) {
      return res.status(409).json({
        ok: false,
        code: 'COURIER_GUY_RATE_NOT_IN_QUOTE',
        message: 'The selected Courier Guy rate is not part of the current quote.',
      });
    }

    req.session.courierGuySelectedRate = {
      quoteId,
      rateId: String(picked.rateId),
      serviceLevelId: String(picked.serviceLevelId),
      serviceCode: picked.serviceCode || '',
      service: picked.service || '',
      description: picked.description || '',
      amount: Number(picked.amount),
      amountExcludingVat: picked.amountExcludingVat,

      currency: String(picked.currency || process.env.BASE_CURRENCY || 'USD')
        .trim()
        .toUpperCase(),

      vat: picked.vat,
      vatPercentage: picked.vatPercentage,
      collectionDate: picked.collectionDate,
      collectionCutOffTime: picked.collectionCutOffTime,
      deliveryDateFrom: picked.deliveryDateFrom,
      deliveryDateTo: picked.deliveryDateTo,
      actualWeight: picked.actualWeight,
      chargedWeight: picked.chargedWeight,
      volumetricWeight: picked.volumetricWeight,
      extras: picked.extras || [],
      surcharges: picked.surcharges || [],
      selectedAt: new Date().toISOString(),
    };

    await new Promise((resolve) => {
      if (req.session && typeof req.session.save === 'function') {
        req.session.save(() => resolve());
      } else {
        resolve();
      }
    });

    return res.json({
      ok: true,
    });
  } catch (error) {
    console.error('Courier Guy remember-rate error:', error);

    return res.status(500).json({
      ok: false,
      code: 'SERVER_ERROR',
      message: 'Could not remember the selected Courier Guy rate.',
    });
  }
});

module.exports = router;
