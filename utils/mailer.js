// utils/mailer.js
'use strict';

function getProvider() {
  return String(process.env.MAIL_PROVIDER || 'sendgrid').trim().toLowerCase();
}

function getFrom() {
  return process.env.SMTP_FROM || 'Phakisi Global <no-reply@localhost>';
}

async function sendWithSendgrid({ to, subject, text, html, replyTo }) {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error('SENDGRID_API_KEY is missing (MAIL_PROVIDER=sendgrid)');
  }

  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);

  const msg = {
    to,
    from: getFrom(),
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  };

  const [res] = await sgMail.send(msg);
  return res;
}

// (Optional) SMTP fallback
async function sendWithSmtp({ to, subject, text, html, replyTo }) {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const port = Number(process.env.SMTP_PORT || 587);

  if (!host || !user || !pass) {
    throw new Error('SMTP is selected but SMTP_HOST/SMTP_USER/SMTP_PASS is missing');
  }

  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // ✅ correct behavior for 465
    auth: { user, pass },
  });

  const info = await transporter.sendMail({
    to,
    from: getFrom(),
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  });

  return info;
}

async function sendMail(args) {
  const provider = getProvider();
  if (provider === 'sendgrid') return sendWithSendgrid(args);
  if (provider === 'smtp') return sendWithSmtp(args);
  throw new Error(`Unknown MAIL_PROVIDER "${provider}" (use "sendgrid" or "smtp")`);
}

let _mailerStatus = { ok: false, checkedAt: 0, reason: '' };

function _basicEnvOk() {
  const provider = getProvider();

  if (provider === 'sendgrid') {
    // ✅ SMTP_FROM is used as SendGrid "from"
    return !!process.env.SENDGRID_API_KEY && !!process.env.SMTP_FROM;
  }

  if (provider === 'smtp') {
    return (
      !!process.env.SMTP_HOST &&
      !!process.env.SMTP_USER &&
      !!process.env.SMTP_PASS &&
      !!process.env.SMTP_FROM
    );
  }

  return false;
}

async function initMailerHealthOnce() {
  try {
    if (!_basicEnvOk()) {
      _mailerStatus = { ok: false, checkedAt: Date.now(), reason: 'Missing env' };
      return _mailerStatus;
    }

    // For SMTP we *can* do a real verify once (optional but helpful)
    if (getProvider() === 'smtp') {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: Number(process.env.SMTP_PORT || 587) === 465,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.verify();
      } catch (e) {
        _mailerStatus = {
          ok: false,
          checkedAt: Date.now(),
          reason: `SMTP verify failed: ${String(e?.message || e)}`,
        };
        return _mailerStatus;
      }
    }

    _mailerStatus = { ok: true, checkedAt: Date.now(), reason: '' };
    return _mailerStatus;
  } catch (err) {
    _mailerStatus = {
      ok: false,
      checkedAt: Date.now(),
      reason: String((err && err.message) || err),
    };
    return _mailerStatus;
  }
}

function mailerReady() {
  return !!_mailerStatus.ok;
}

const FROM = getFrom();

// ✅ keep the same behavior (auto-init once on load)
initMailerHealthOnce().catch(() => {});

module.exports = {
  sendMail,
  mailerReady,
  initMailerHealthOnce, // ✅ extra export (doesn't break anything)
  FROM,
};
