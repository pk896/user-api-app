// utils/cj/verifyCjPaypalWebhook.js
'use strict';

const { fetch } = require('undici');

const {
  getPaypalAccessToken,
  getPaypalBaseUrl,
} = require('../paypal/paypalClient');

function safeString(value, max = 1000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function getHeader(req, name) {
  const headerName = String(name || '')
    .trim()
    .toLowerCase();

  const value = req?.headers?.[headerName];

  return Array.isArray(value)
    ? value[0]
    : value;
}

async function parsePaypalResponse(response) {
  const rawText = await response
    .text()
    .catch(() => '');

  let body = {};

  try {
    body = rawText
      ? JSON.parse(rawText)
      : {};
  } catch {
    body = {
      raw: safeString(rawText, 2000),
    };
  }

  return body;
}

async function verifyCjPaypalWebhook(
  req,
  eventBody,
) {
  const webhookId = safeString(
    process.env.CJ_PAYPAL_WEBHOOK_ID,
    500,
  );

  if (!webhookId) {
    return {
      ok: false,
      reason: 'CJ_PAYPAL_WEBHOOK_ID_MISSING',
    };
  }

  const payload = {
    auth_algo: getHeader(
      req,
      'paypal-auth-algo',
    ),

    cert_url: getHeader(
      req,
      'paypal-cert-url',
    ),

    transmission_id: getHeader(
      req,
      'paypal-transmission-id',
    ),

    transmission_sig: getHeader(
      req,
      'paypal-transmission-sig',
    ),

    transmission_time: getHeader(
      req,
      'paypal-transmission-time',
    ),

    webhook_id: webhookId,

    webhook_event: eventBody,
  };

  if (
    !payload.auth_algo ||
    !payload.cert_url ||
    !payload.transmission_id ||
    !payload.transmission_sig ||
    !payload.transmission_time
  ) {
    return {
      ok: false,
      reason: 'PAYPAL_WEBHOOK_HEADERS_MISSING',
    };
  }

  try {
    const token =
      await getPaypalAccessToken();

    const response = await fetch(
      `${getPaypalBaseUrl()}/v1/notifications/verify-webhook-signature`,
      {
        method: 'POST',

        headers: {
          Authorization:
            `Bearer ${token}`,

          Accept:
            'application/json',

          'Content-Type':
            'application/json',
        },

        body: JSON.stringify(payload),
      },
    );

    const body =
      await parsePaypalResponse(
        response,
      );

    const verificationStatus =
      safeString(
        body?.verification_status,
        100,
      ).toUpperCase();

    if (!response.ok) {
      return {
        ok: false,

        reason:
          'PAYPAL_WEBHOOK_VERIFICATION_REQUEST_FAILED',

        httpStatus:
          response.status,

        verificationStatus,

        message: safeString(
          body?.message ||
            body?.details?.[0]?.description ||
            body?.details?.[0]?.issue ||
            body?.raw ||
            'PayPal webhook verification failed.',
          1000,
        ),
      };
    }

    return {
      ok:
        verificationStatus ===
        'SUCCESS',

      reason:
        verificationStatus ===
        'SUCCESS'
          ? ''
          : 'PAYPAL_WEBHOOK_SIGNATURE_INVALID',

      verificationStatus,
    };
  } catch (error) {
    return {
      ok: false,

      reason:
        safeString(
          error?.code,
          200,
        ) ||
        'PAYPAL_WEBHOOK_VERIFICATION_EXCEPTION',

      message: safeString(
        error?.message ||
          error,
        1000,
      ),
    };
  }
}

module.exports = {
  verifyCjPaypalWebhook,
};