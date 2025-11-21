// routes/contact.js
const express = require('express');
const { sendMail } = require('../utils/mailer');
const router = express.Router();

function dashboardPathFor(b) {
  if (!b) {return '';}
  if (b.role === 'seller') {return '/business/dashboards/seller-dashboard';}
  if (b.role === 'supplier') {return '/business/dashboards/supplier-dashboard';}
  if (b.role === 'buyer') {return '/business/dashboards/buyer-dashboard';}
  return '/business/login';
}

// GET /contact (form)
router.get('/', (req, res) => {
  res.render('contact', {
    title: 'Contact Phakisi Global',
    nonce: res.locals.nonce,
    themeCss: res.locals.themeCss,
    // flashes come from global locals
  });
});

// POST /contact (non-blocking mail, then PRG -> /contact/sent)
router.post('/', (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();
  const message = String(req.body.message || '').trim();
  const hp = String(req.body.hp_field || '').trim();

  if (hp) {
    // Pretend success for bots
    return res.redirect(303, '/contact/sent');
  }

  if (!name || !email || !message) {
    req.flash('error', '⚠️ Please fill in all fields.');
    return res.redirect(303, '/contact');
  }

  // Fire-and-forget emails
  const supportTo = process.env.SUPPORT_INBOX || process.env.SMTP_FROM;
  Promise.allSettled([
    sendMail({
      to: supportTo,
      subject: `Contact form: ${name}`,
      text: `${message}\n\nFrom: ${name} <${email}>`,
      html: `<p>${message.replace(/\n/g, '<br>')}</p><p>From: <strong>${name}</strong> &lt;${email}&gt;</p>`,
      replyTo: `${name} <${email}>`,
      headers: { 'List-Unsubscribe': `<mailto:${supportTo}?subject=unsubscribe>` },
    }),
    ...(process.env.MAIL_ACK === '1' && email
      ? [
          sendMail({
            to: email,
            subject: 'We received your message (Phakisi Support)',
            text: `Hi ${name},

Thanks for contacting Phakisi Support. Your message has been received.
We’ll get back to you shortly.

— Phakisi Support`,
            html:
              `<p>Hi ${name},</p>` +
              `<p>Thanks for contacting <strong>Phakisi Support</strong>. Your message has been received. We’ll get back to you shortly.</p>` +
              `<p>— Phakisi Support</p>`,
            replyTo: process.env.SUPPORT_INBOX || undefined,
          }),
        ]
      : []),
  ]).catch((err) => console.error('[contact] background mail error:', err));

  // Redirect to dedicated success page (PRG)
  const next = dashboardPathFor(req.session?.business);
  const qs = next ? `?next=${encodeURIComponent(next)}` : '';
  res.redirect(303, `/contact/sent${qs}`);
});

// GET /contact/sent (confirmation page, can auto-redirect if next=...)
router.get('/sent', (req, res) => {
  const next = String(req.query.next || '').trim();
  res.render('contact-sent', {
    title: 'Message sent',
    next, // optional dashboard URL
    autoRedirectSeconds: next ? 3 : 0, // countdown only if next is present
    nonce: res.locals.nonce,
    themeCss: res.locals.themeCss,
  });
});

module.exports = router;
