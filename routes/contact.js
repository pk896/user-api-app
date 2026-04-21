// routes/contact.js
'use strict';

const express = require('express');
const { sendMail } = require('../utils/mailer');
const router = express.Router();

function dashboardPathFor(b) {
  if (!b) { return ''; }
  if (b.role === 'seller') { return '/business/dashboards/seller-dashboard'; }
  if (b.role === 'supplier') { return '/business/dashboards/supplier-dashboard'; }
  if (b.role === 'buyer') { return '/business/dashboards/buyer-dashboard'; }
  return '/business/login';
}

function safe(v) {
  return String(v || '').trim();
}

function escHtml(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// GET /contact -> always use store contact page
router.get('/', (req, res) => {
  const next = safe(req.query.next);
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';
  return res.redirect(302, `/store/contact${qs}`);
});

// POST /contact -> process store contact form
router.post('/', (req, res) => {
  const name = safe(req.body.name);
  const email = safe(req.body.email);
  const phone = safe(req.body.phone);
  const businessRole = safe(req.body.businessRole);
  const subject = safe(req.body.subject);
  const message = safe(req.body.message);
  const hp = safe(req.body.hp_field);

  const next = dashboardPathFor(req.session?.business);
  const nextQs = next ? `&next=${encodeURIComponent(next)}` : '';

  if (hp) {
  // Pretend success for bots
    return res.redirect(303, `/store/contact?sent=1${nextQs}#storeContactSection`);
  }

  if (!name || !email || !phone || !businessRole || !subject || !message) {
    req.flash('error', '⚠️ Please fill in all fields.');
    return res.redirect(303, `/store/contact${next ? `?next=${encodeURIComponent(next)}` : ''}#storeContactSection`);
  }

  const supportTo = process.env.SUPPORT_INBOX || process.env.SMTP_FROM;
  const mailSubject = `Store contact: ${subject}`;

  const text = [
    `Subject: ${subject}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Business Role: ${businessRole}`,
    '',
    'Message:',
    message
  ].join('\n');

  const html =
    `<p><strong>Subject:</strong> ${escHtml(subject)}</p>` +
    `<p><strong>Name:</strong> ${escHtml(name)}</p>` +
    `<p><strong>Email:</strong> ${escHtml(email)}</p>` +
    `<p><strong>Phone:</strong> ${escHtml(phone)}</p>` +
    `<p><strong>Business Role:</strong> ${escHtml(businessRole)}</p>` +
    `<p><strong>Message:</strong><br>${escHtml(message).replace(/\n/g, '<br>')}</p>`;

  Promise.allSettled([
    sendMail({
      to: supportTo,
      subject: mailSubject,
      text,
      html,
      replyTo: `${name} <${email}>`,
      headers: {
        'List-Unsubscribe': `<mailto:${supportTo}?subject=unsubscribe>`
      },
    }),
    ...(process.env.MAIL_ACK === '1' && email
      ? [
          sendMail({
            to: email,
            subject: 'We received your message (Unicoporate Support)',
            text:
              `Hi ${name},\n\n` +
              `Thanks for contacting Unicoporate Support. Your message has been received.\n` +
              `We’ll get back to you shortly.\n\n` +
              `Subject: ${subject}\n` +
              `Business Role: ${businessRole}\n\n` +
              `— Unicoporate Support`,
            html:
              `<p>Hi ${escHtml(name)},</p>` +
              `<p>Thanks for contacting <strong>Unicoporate Support</strong>. Your message has been received. We’ll get back to you shortly.</p>` +
              `<p><strong>Subject:</strong> ${escHtml(subject)}<br>` +
              `<strong>Business Role:</strong> ${escHtml(businessRole)}</p>` +
              `<p>— Unicoporate Support</p>`,
            replyTo: process.env.SUPPORT_INBOX || undefined,
          }),
        ]
      : []),
  ]).catch((err) => {
    console.error('[contact] background mail error:', err);
  });

  req.flash('success', '✅ Your message was sent successfully.');
  return res.redirect(303, `/store/contact?sent=1${nextQs}#storeContactSection`);
});

// GET /contact/sent -> also send user back to store contact page
router.get('/sent', (req, res) => {
  const next = safe(req.query.next);
  const qs = next ? `?sent=1&next=${encodeURIComponent(next)}` : '?sent=1';
  return res.redirect(303, `/store/contact${qs}#storeContactSection`);
});

module.exports = router;
