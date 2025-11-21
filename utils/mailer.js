// utils/mailer.js
const provider = String(process.env.MAIL_PROVIDER || 'sendgrid').toLowerCase();
const FROM = process.env.SMTP_FROM || 'Phakisi Global <no-reply@localhost>';

async function sendWithSendgrid({ to, subject, text, html, replyTo }) {
  const sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  const msg = {
    to,
    from: FROM,
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  };
  const [res] = await sgMail.send(msg);
  return res;
}

// (Optional) SMTP fallback if you keep one:
async function sendWithSmtp({ to, subject, text, html, replyTo }) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  const info = await transporter.sendMail({
    to,
    from: FROM,
    subject,
    text: text || '',
    html: html || '',
    ...(replyTo ? { replyTo } : {}),
  });
  return info;
}

async function sendMail(args) {
  if (provider === 'sendgrid') {return sendWithSendgrid(args);}
  return sendWithSmtp(args);
}

let _mailerStatus = { ok: false, checkedAt: 0, reason: '' };

function _basicEnvOk() {
  if (String(process.env.MAIL_PROVIDER || '').toLowerCase() === 'sendgrid') {
    return !!process.env.SENDGRID_API_KEY && !!process.env.SMTP_FROM;
  }
  // add SMTP branch if you ever switch providers
  return false;
}

async function initMailerHealthOnce() {
  try {
    if (!_basicEnvOk()) {
      _mailerStatus = { ok: false, checkedAt: Date.now(), reason: 'Missing env' };
      return _mailerStatus;
    }

    // Optional: ultra-light runtime probe (SendGrid doesn’t have a cheap “ping”).
    // We’ll just mark ok if env is sane. If you use SMTP, you can do transporter.verify() once.

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
  // Return a simple boolean for templates
  return !!_mailerStatus.ok;
}

// Call this once at startup (e.g., in server.js after env is loaded)
initMailerHealthOnce().catch(() => {});
module.exports = { sendMail, mailerReady /*, ... */ };

module.exports = { sendMail, FROM };
