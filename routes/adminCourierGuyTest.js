// routes/adminCourierGuyTest.js
'use strict';

const express = require('express');
const { fetch } = require('undici');

const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

function getCourierGuyConfig() {
  const mode = String(process.env.COURIER_GUY_MODE || 'sandbox')
    .trim()
    .toLowerCase();

  const baseUrl = String(
    process.env.COURIER_GUY_SANDBOX_API_BASE ||
      'https://api.shiplogic.com',
  )
    .trim()
    .replace(/\/+$/, '');

  const apiKey = String(
    process.env.COURIER_GUY_SANDBOX_API_KEY || '',
  ).trim();

  return {
    mode,
    baseUrl,
    apiKey,
  };
}

function detectShipmentCount(data) {
  if (Array.isArray(data)) return data.length;
  if (Array.isArray(data?.results)) return data.results.length;
  if (Array.isArray(data?.shipments)) return data.shipments.length;
  if (Array.isArray(data?.data)) return data.data.length;

  if (Number.isFinite(Number(data?.count))) {
    return Number(data.count);
  }

  return null;
}

function tomorrowDateOnly() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toISOString().slice(0, 10);
}

async function shiplogicRequest(
  path,
  {
    method = 'GET',
    body,
    timeoutMs = 20000,
  } = {},
) {
  const { mode, baseUrl, apiKey } = getCourierGuyConfig();

  if (!apiKey) {
    const error = new Error(
      'COURIER_GUY_SANDBOX_API_KEY is missing from the .env file.',
    );

    error.code = 'COURIER_GUY_API_KEY_MISSING';
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const responseText = await response.text().catch(() => '');

    let data = {};

    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      data = {
        raw: responseText.slice(0, 1000),
      };
    }

    if (!response.ok) {
      const error = new Error(
        data?.message ||
          data?.detail ||
          data?.error ||
          `Shiplogic returned HTTP ${response.status}.`,
      );

      error.status = response.status;
      error.shiplogic = data;
      throw error;
    }

    return {
      mode,
      baseUrl,
      status: response.status,
      data,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ======================================================
// Courier Guy / Shiplogic sandbox connection test
// GET /admin/courier-guy/_health
// ======================================================
router.get(
  '/admin/courier-guy/_health',
  requireAdmin,
  async (req, res) => {
    const { mode, baseUrl } = getCourierGuyConfig();

    try {
      const result = await shiplogicRequest('/shipments');

      return res.json({
        ok: true,
        authenticated: true,
        mode: result.mode,
        baseUrl: result.baseUrl,
        responseStatus: result.status,
        shipmentCount: detectShipmentCount(result.data),
        message:
          'Courier Guy / Shiplogic sandbox connection is working.',
      });
    } catch (error) {
      const timedOut =
        error?.name === 'AbortError' ||
        String(error?.message || '')
          .toLowerCase()
          .includes('aborted');

      return res.status(error?.status || 500).json({
        ok: false,
        authenticated: error?.status !== 401,
        mode,
        baseUrl,
        responseStatus: error?.status || 500,
        message: timedOut
          ? 'Shiplogic connection timed out.'
          : error?.message || 'Could not connect to Shiplogic.',
        details: error?.shiplogic || null,
      });
    }
  },
);

// ======================================================
// Courier Guy / Shiplogic sandbox rates test
// POST /admin/courier-guy/_rates-test
//
// Safe:
// - Does not create a shipment
// - Does not arrange collection
// - Does not buy a label
// - Does not deduct money
// ======================================================
router.post(
  '/admin/courier-guy/_rates-test',
  requireAdmin,
  async (req, res) => {
    const { mode, baseUrl } = getCourierGuyConfig();

    const testDate = tomorrowDateOnly();

    const payload = {
      collection_address: {
        type: 'business',
        company: 'Kasyora Sandbox Test',
        street_address: '377 Fairy Glen St',
        local_area: 'Lynnwood Park',
        city: 'Pretoria',
        zone: 'Gauteng',
        country: 'ZA',
        code: '0081',
      },

      delivery_address: {
        type: 'residential',
        company: '',
        street_address: '10 Midas Avenue',
        local_area: 'Olympus AH',
        city: 'Pretoria',
        zone: 'Gauteng',
        country: 'ZA',
        code: '0081',
      },

      parcels: [
        {
          submitted_length_cm: 42.5,
          submitted_width_cm: 38.5,
          submitted_height_cm: 5.5,
          submitted_weight_kg: 3,
        },
      ],

      declared_value: 1500,
      collection_min_date: testDate,
      delivery_min_date: testDate,
    };

    try {
      const result = await shiplogicRequest('/rates', {
        method: 'POST',
        body: payload,
        timeoutMs: 30000,
      });

      const rateData = result.data;

      const rates = Array.isArray(rateData)
        ? rateData
        : Array.isArray(rateData?.rates)
          ? rateData.rates
          : Array.isArray(rateData?.results)
            ? rateData.results
            : Array.isArray(rateData?.data)
              ? rateData.data
              : [];

      return res.json({
        ok: true,
        authenticated: true,
        mode: result.mode,
        baseUrl: result.baseUrl,
        responseStatus: result.status,
        rateCount: rates.length,
        rates,
        rawResponse: rateData,
        message:
          'Courier Guy / Shiplogic sandbox rates were requested successfully.',
      });
    } catch (error) {
      const timedOut =
        error?.name === 'AbortError' ||
        String(error?.message || '')
          .toLowerCase()
          .includes('aborted');

      return res.status(error?.status || 500).json({
        ok: false,
        authenticated: error?.status !== 401,
        mode,
        baseUrl,
        responseStatus: error?.status || 500,
        message: timedOut
          ? 'Shiplogic rate request timed out.'
          : error?.message || 'Could not retrieve Shiplogic rates.',
        details: error?.shiplogic || null,
      });
    }
  },
);

module.exports = router;