// utils/mailer.js
'use strict';

/**
 * PRODUCTION-READY MAILER (Render-safe)
 * - Supports: SendGrid (recommended on Render) OR SMTP
 * - Strict env validation so you don't "think it sent" when it didn't
 * - Safe debug logging (no secrets), but enough to troubleshoot delivery
 *
 * REQUIRED ENV (SendGrid):
 *   MAIL_PROVIDER=sendgrid
 *   SENDGRID_API_KEY=...
 *   SMTP_FROM="Unicoporate <verified-sender@yourdomain.com>"
 *
 * REQUIRED ENV (SMTP):
 *   MAIL_PROVIDER=smtp
 *   SMTP_HOST=...
 *   SMTP_PORT=587 (or 465)
 *   SMTP_USER=...
 *   SMTP_PASS=...
 *   SMTP_FROM="Unicoporate <your-email@yourdomain.com>"
 *
 * OPTIONAL:
 *   MAIL_LOG_LEVEL=info   (info|debug|silent)
 *   SMTP_SECURE=true/false  (forces secure; otherwise auto by port)
 */

const nodemailer = require('nodemailer');

function env(name, fallback = '') {
  return String(process.env[name] ?? fallback).trim();
}

function getProvider() {
  return env('MAIL_PROVIDER', 'sendgrid').toLowerCase();
}

function getFrom() {
  // MUST be a verified sender on SendGrid, or a real SMTP sender.
  return env('SMTP_FROM', '');
}

function getLogLevel() {
  return env('MAIL_LOG_LEVEL', process.env.NODE_ENV === 'production' ? 'info' : 'debug').toLowerCase();
}

function logInfo(...args) {
  if (getLogLevel() === 'silent') return;
  console.log(...args);
}

function logDebug(...args) {
  const lvl = getLogLevel();
  if (lvl !== 'debug') return;
  console.log(...args);
}

/**
 * Basic validation that prevents "fake success" in production.
 * In production, we want missing env to fail loudly.
 */
function assertEnvOrThrow() {
  const provider = getProvider();
  const from = getFrom();

  if (!from) {
    throw new Error('SMTP_FROM is missing. Set SMTP_FROM to a real/verified sender (e.g. "Unicoporate <noreply@yourdomain.com>").');
  }

  if (provider === 'sendgrid') {
    if (!env('SENDGRID_API_KEY')) {
      throw new Error('SENDGRID_API_KEY is missing (MAIL_PROVIDER=sendgrid).');
    }
    return;
  }

  if (provider === 'smtp') {
    const host = env('SMTP_HOST');
    const user = env('SMTP_USER');
    const pass = env('SMTP_PASS');

    if (!host || !user || !pass) {
      throw new Error('SMTP is selected but SMTP_HOST/SMTP_USER/SMTP_PASS is missing.');
    }
    return;
  }

  throw new Error(`Unknown MAIL_PROVIDER "${provider}" (use "sendgrid" or "smtp").`);
}

/* ======================================================
   SendGrid
====================================================== */

async function sendWithSendgrid({ to, subject, text, html, replyTo }) {
  assertEnvOrThrow();

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(env('SENDGRID_API_KEY'));

  const msg = {
    to,
    from: getFrom(),
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  };

  try {
    const [res] = await sgMail.send(msg);

    // ✅ Production-safe delivery logs (no API key printed)
    logInfo('[MAIL] provider=sendgrid', 'to=', to, 'status=', res?.statusCode, 'subject=', subject);
    logDebug('[MAIL] sendgrid headers:', res?.headers);

    return res;
  } catch (e) {
    // SendGrid error body is extremely useful for "from not verified", "blocked", etc.
    logInfo('[MAIL] provider=sendgrid FAILED', 'to=', to, 'subject=', subject);
    logInfo('[MAIL] error:', e?.message || e);

    if (e?.response?.body) {
      logInfo('[MAIL] sendgrid response body:', JSON.stringify(e.response.body));
    }

    throw e;
  }
}

/* ======================================================
   SMTP
====================================================== */

let _smtpTransporter = null;

function buildSmtpTransporter() {
  const host = env('SMTP_HOST');
  const user = env('SMTP_USER');
  const pass = env('SMTP_PASS');
  const port = Number(env('SMTP_PORT', '587'));

  // Optional override, otherwise infer from port
  const secureOverride = env('SMTP_SECURE', '');
  const secure =
    secureOverride === ''
      ? port === 465
      : ['1', 'true', 'yes'].includes(secureOverride.toLowerCase());

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  });
}

async function sendWithSmtp({ to, subject, text, html, replyTo }) {
  assertEnvOrThrow();

  if (!_smtpTransporter) {
    _smtpTransporter = buildSmtpTransporter();
  }

  const info = await _smtpTransporter.sendMail({
    to,
    from: getFrom(),
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  });

  // ✅ Useful logs for Render
  logInfo('[MAIL] provider=smtp', 'to=', to, 'subject=', subject, 'messageId=', info?.messageId);
  logDebug('[MAIL] smtp accepted:', info?.accepted);
  logDebug('[MAIL] smtp rejected:', info?.rejected);
  logDebug('[MAIL] smtp response:', info?.response);

  // Ethereal preview link only exists if you use Ethereal creds
  const preview = nodemailer.getTestMessageUrl?.(info);
  if (preview) logInfo('[MAIL] ethereal preview:', preview);

  return info;
}

/* ======================================================
   Unified sendMail
====================================================== */

async function sendMail(args) {
  const provider = getProvider();

  if (provider === 'sendgrid') return sendWithSendgrid(args);
  if (provider === 'smtp') return sendWithSmtp(args);

  // assertEnvOrThrow already throws for unknown provider, but keep this here too.
  throw new Error(`Unknown MAIL_PROVIDER "${provider}" (use "sendgrid" or "smtp").`);
}

/* ======================================================
   Health check
====================================================== */

let _mailerStatus = { ok: false, checkedAt: 0, reason: '' };

async function initMailerHealthOnce() {
  try {
    assertEnvOrThrow();

    // Only verify SMTP connection (SendGrid has no "verify" here)
    if (getProvider() === 'smtp') {
      const transporter = buildSmtpTransporter();
      await transporter.verify();
    }

    _mailerStatus = { ok: true, checkedAt: Date.now(), reason: '' };
    logInfo('[MAIL] ready ok=', true, 'provider=', getProvider());
    return _mailerStatus;
  } catch (err) {
    _mailerStatus = {
      ok: false,
      checkedAt: Date.now(),
      reason: String(err?.message || err),
    };
    logInfo('[MAIL] ready ok=', false, 'provider=', getProvider(), 'reason=', _mailerStatus.reason);
    return _mailerStatus;
  }
}

function mailerReady() {
  return !!_mailerStatus.ok;
}

/* ======================================================
   Exports
   ✅ Export BOTH FROM and _FROM so old code doesn't break
====================================================== */

const FROM = getFrom() || 'Unicoporate <phakisingxongxela@gmail.com>';
const _FROM = FROM;

// Auto init (safe)
initMailerHealthOnce().catch(() => {});

module.exports = {
  sendMail,
  mailerReady,
  initMailerHealthOnce,
  FROM,
  _FROM, // backward-compatible alias
};
