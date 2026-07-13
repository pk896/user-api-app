// utils/cj/cjOrderEmailService.js
'use strict';

const CjOrder = require('../../models/CjOrder');
const CjOrderEmailLog = require('../../models/CjOrderEmailLog');

const { sendMail, FROM } = require('../mailer');

const { getCjOrderRecipients, buildCjOrderEmail } = require('../emails/cjOrderEmail');

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizeEventType(value) {
  return safeString(value, 100)
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_');
}

function normalizeEmail(value) {
  return safeString(value, 320).toLowerCase();
}

function publicBaseUrl() {
  return safeString(
    process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.FRONTEND_URL || '',
    2000,
  ).replace(/\/+$/, '');
}

async function claimEmail({ order, eventType, recipient, source }) {
  const normalizedRecipient = normalizeEmail(recipient);

  try {
    return await CjOrderEmailLog.create({
      department: 'CJ',
      cjOrder: order._id,
      cjOrderNumber: order.cjOrderNumber,
      eventType,
      recipient: normalizedRecipient,
      status: 'PROCESSING',
      claimedAt: new Date(),
      attemptCount: 1,
      source: safeString(source, 200),
    });
  } catch (error) {
    if (Number(error?.code) !== 11000) {
      throw error;
    }

    const retryable = await CjOrderEmailLog.findOneAndUpdate(
      {
        cjOrder: order._id,
        eventType,
        recipient: normalizedRecipient,
        status: 'FAILED',

        $or: [
          {
            retryAfter: null,
          },
          {
            retryAfter: {
              $lte: new Date(),
            },
          },
        ],
      },
      {
        $set: {
          status: 'PROCESSING',
          claimedAt: new Date(),
          failedAt: null,
          lastError: '',
          source: safeString(source, 200),
        },

        $inc: {
          attemptCount: 1,
        },
      },
      {
        new: true,
      },
    );

    return retryable;
  }
}

async function markSent(log, subject) {
  log.status = 'SENT';
  log.subject = safeString(subject, 500);
  log.provider = safeString(process.env.MAIL_PROVIDER || 'sendgrid', 100);
  log.sentAt = new Date();
  log.failedAt = null;
  log.retryAfter = null;
  log.lastError = '';

  await log.save();
}

async function markFailed(log, error) {
  const attempts = Number(log?.attemptCount || 1);

  const delayMinutes = Math.min(60, Math.max(5, attempts * 5));

  log.status = 'FAILED';
  log.failedAt = new Date();
  log.retryAfter = new Date(Date.now() + delayMinutes * 60 * 1000);
  log.lastError = safeString(error?.message || error, 2000);

  await log.save();
}

async function loadCjOrder(orderOrId) {
  if (orderOrId && typeof orderOrId === 'object' && orderOrId._id) {
    return orderOrId;
  }

  return CjOrder.findOne({
    _id: orderOrId,
    department: 'CJ',
  });
}

async function sendCjOrderEventEmails(orderOrId, eventType, { source = '' } = {}) {
  const normalizedEventType = normalizeEventType(eventType);

  if (!normalizedEventType) {
    throw new Error('sendCjOrderEventEmails: event type is required.');
  }

  const order = await loadCjOrder(orderOrId);

  if (!order) {
    return {
      ok: false,
      skipped: true,
      reason: 'CJ_ORDER_NOT_FOUND',
    };
  }

  const recipients = getCjOrderRecipients(order);

  if (!recipients.length) {
    console.warn('[CJ email] No customer recipient:', {
      cjOrderNumber: order.cjOrderNumber,
      eventType: normalizedEventType,
    });

    return {
      ok: false,
      skipped: true,
      reason: 'CJ_EMAIL_RECIPIENT_MISSING',
    };
  }

  const result = {
    ok: true,
    eventType: normalizedEventType,
    cjOrderNumber: order.cjOrderNumber,
    recipients: [],
  };

  for (const recipient of recipients) {
    const log = await claimEmail({
      order,
      eventType: normalizedEventType,
      recipient,
      source,
    });

    if (!log) {
      result.recipients.push({
        recipient,
        sent: false,
        skipped: true,
        reason: 'ALREADY_SENT_OR_CURRENTLY_PROCESSING',
      });

      continue;
    }

    const built = buildCjOrderEmail({
      order,
      eventType: normalizedEventType,
      recipient,
      baseUrl: publicBaseUrl(),
    });

    try {
      await sendMail({
        to: recipient,
        subject: built.subject,
        text: built.text,
        html: built.html,
        replyTo: process.env.SUPPORT_INBOX || undefined,
      });

      await markSent(log, built.subject);

      result.recipients.push({
        recipient,
        sent: true,
      });

      console.log('[CJ email] Sent:', {
        cjOrderNumber: order.cjOrderNumber,
        eventType: normalizedEventType,
        recipient,
        from: FROM,
      });
    } catch (error) {
      await markFailed(log, error);

      result.ok = false;

      result.recipients.push({
        recipient,
        sent: false,
        error: safeString(error?.message || error, 1000),
      });

      /*
       * Email delivery must never reverse a paid order,
       * supplier order or tracking status.
       */
      console.error('[CJ email] Failed:', {
        cjOrderNumber: order.cjOrderNumber,
        eventType: normalizedEventType,
        recipient,
        message: safeString(error?.message || error, 1000),
      });
    }
  }

  return result;
}

async function sendCjOrderEventEmailsSafely(orderOrId, eventType, options = {}) {
  try {
    return await sendCjOrderEventEmails(orderOrId, eventType, options);
  } catch (error) {
    console.error('[CJ email] Unexpected dispatcher failure:', {
      eventType: normalizeEventType(eventType),
      message: safeString(error?.message || error, 1000),
    });

    return {
      ok: false,
      error: safeString(error?.message || error, 1000),
    };
  }
}

module.exports = {
  sendCjOrderEventEmails,
  sendCjOrderEventEmailsSafely,
};
