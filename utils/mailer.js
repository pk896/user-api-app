// utils/mailer.js
const provider = (process.env.MAIL_PROVIDER || 'sendgrid').toLowerCase();
const FROM = process.env.SMTP_FROM || `Phakisi Global <no-reply@example.com>`;

// --- SendGrid (HTTP API) ---
async function sendWithSendgrid({ to, subject, html, text }) {
  const sg = require('@sendgrid/mail');
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error('Missing SENDGRID_API_KEY');
  sg.setApiKey(key);
  const msg = { to, from: FROM, subject, text: text || '', html: html || '' };
  const res = await sg.send(msg);
  return res?.[0]?.statusCode || 202;
}

// Unified facade used by the app
async function sendMail({ to, subject, html, text }) {
  if (provider === 'sendgrid') return sendWithSendgrid({ to, subject, html, text });

  // Fallback for dev if MAIL_PROVIDER not set
  console.warn('[mailer] MAIL_PROVIDER not recognized, printing email to console.');
  console.log({ to, subject, text, html });
  return 200;
}

module.exports = { sendMail };



