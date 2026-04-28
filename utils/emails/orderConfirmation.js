// utils/emails/orderConfirmation.js
'use strict';

const { sendMail, FROM } = require('../mailer');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeBaseUrl(baseUrl) {
  return String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
}

function formatMoney(value, currency) {
  const amount = Number(value || 0);
  const ccy =
    String(currency || 'USD')
      .trim()
      .toUpperCase() || 'USD';

  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: ccy,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);

    if (ccy === 'ZAR') {
      return formatted.replace(/^ZAR\s?/, 'R');
    }

    return formatted;
  } catch {
    return `${ccy} ${amount.toFixed(2)}`;
  }
}

function niceDate(value) {
  if (!value) return '';

  try {
    return new Date(value).toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value || '');
  }
}

function normalizeEmail(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function getOrderConfirmationRecipients(order) {
  const payerEmail = normalizeEmail(order?.payer?.email);
  const shippingEmail = normalizeEmail(order?.shipping?.email);

  const recipients = [];

  if (payerEmail) recipients.push(payerEmail);

  // Send to shipping email too, but do not duplicate if it is the same as payer email.
  if (shippingEmail && shippingEmail !== payerEmail) {
    recipients.push(shippingEmail);
  }

  return recipients;
}

function getDeliveryEtaText(order) {
  const rawDays =
    order?.delivery?.deliveryDays ??
    order?.shippo?.chosenRate?.estimatedDays ??
    null;

  const days = Number(rawDays);

  if (!Number.isFinite(days) || days <= 0) {
    return '';
  }

  const cleanDays = Math.floor(days);
  const dayWord = cleanDays === 1 ? 'day' : 'days';

  return `Your order is expected to be delivered in about ${cleanDays} ${dayWord}.`;
}

function buildOrderConfirmationEmail(order, baseUrl) {
  const o = order || {};
  const safeBaseUrl = sanitizeBaseUrl(
    baseUrl || process.env.PUBLIC_BASE_URL || process.env.APP_URL || process.env.FRONTEND_URL || '',
  );

  const orderId = String(o.orderId || '').trim();
  const recipients = getOrderConfirmationRecipients(o);
  const customerEmail = recipients.join(', ');

  const trackingUrl = safeBaseUrl ? `${safeBaseUrl}/store/order-tracking` : '/store/order-tracking';

  const amountText = formatMoney(
    o.amount?.value || 0,
    o.amount?.currency || process.env.BASE_CURRENCY || 'USD',
  );

  const items = Array.isArray(o.items) ? o.items : [];

  const subject = `Your Unicoporate order confirmation - ${orderId}`;

  const deliveryEtaText = getDeliveryEtaText(o);

  const itemLinesText = items.length
    ? items
        .map((item) => {
          const variants = [];
          if (item.variants?.size) variants.push(`Size: ${item.variants.size}`);
          if (item.variants?.color) variants.push(`Color: ${item.variants.color}`);

          const variantText = variants.length ? ` (${variants.join(', ')})` : '';
          return `- ${item.name || 'Product'}${variantText} x ${Number(item.quantity || 1)}`;
        })
        .join('\n')
    : '- Items confirmed';

  const text = `
Thank you for your order.

ORDER DETAILS
Order ID: ${orderId}
Order date: ${niceDate(o.createdAt || new Date())}
Total: ${amountText}
${deliveryEtaText ? `Delivery estimate: ${deliveryEtaText}` : ''}

ITEMS
${itemLinesText}

TRACK YOUR ORDER
Use your Order ID and checkout email address here:
${trackingUrl}

Important:
Please keep this Order ID. You will need it to track your order.

Thank you for shopping with Unicoporate.com.
`.trim();

  const itemRowsHtml = items.length
    ? items
        .map((item) => {
          const variants = [];
          if (item.variants?.size) variants.push(`Size: ${esc(item.variants.size)}`);
          if (item.variants?.color) variants.push(`Color: ${esc(item.variants.color)}`);

          return `
          <tr>
            <td style="padding:10px 0;border-bottom:1px solid #E2E8F0;">
              <div style="font-weight:800;color:#0F172A;">${esc(item.name || 'Product')}</div>
              ${variants.length ? `<div style="font-size:12px;color:#64748B;margin-top:3px;">${variants.join(' | ')}</div>` : ''}
            </td>
            <td align="right" style="padding:10px 0;border-bottom:1px solid #E2E8F0;font-weight:800;color:#7C3AED;">
              ${Number(item.quantity || 1)}
            </td>
          </tr>
        `;
        })
        .join('')
    : `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #E2E8F0;">Items confirmed</td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #E2E8F0;">—</td>
      </tr>
    `;

  const html = `
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
    </head>
    <body style="margin:0;padding:0;background:#F8FAFC;font-family:Arial,sans-serif;color:#0F172A;">
      <div style="padding:18px 10px;">
        <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="width:640px;max-width:100%;margin:0 auto;background:#FFFFFF;border:1px solid rgba(124,58,237,0.16);border-radius:18px;overflow:hidden;">
          <tr>
            <td style="padding:26px 28px;background:#7C3AED;color:#FFFFFF;">
              <div style="font-size:20px;font-weight:900;">Unicoporate.com</div>
              <div style="font-size:13px;margin-top:5px;color:rgba(255,255,255,0.88);">Order confirmation</div>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 28px;">
              <h1 style="margin:0 0 10px;font-size:22px;color:#7C3AED;">Thank you for your order</h1>
              <p style="margin:0 0 18px;color:#475569;line-height:1.6;">
                Your payment was received and your order has been created.
              </p>

              <div style="border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:16px;background:#FFFFFF;">
                <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Order ID</div>
                <div style="font-size:18px;font-weight:900;color:#0F172A;word-break:break-word;">${esc(orderId)}</div>

                <div style="height:12px;"></div>

                <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Order date</div>
                <div style="font-weight:800;color:#0F172A;">${esc(niceDate(o.createdAt || new Date()))}</div>

                <div style="height:12px;"></div>

                <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Total</div>
                <div style="font-size:18px;font-weight:900;color:#22C55E;">${esc(amountText)}</div>

                ${
                  deliveryEtaText
                    ? `
                      <div style="height:12px;"></div>

                      <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Delivery estimate</div>
                      <div style="font-weight:900;color:#7C3AED;line-height:1.5;">${esc(deliveryEtaText)}</div>
                    `
                    : ''
                }
              </div>

              <div style="border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:16px;background:#FFFFFF;">
                <div style="font-size:14px;color:#7C3AED;font-weight:900;margin-bottom:8px;">Items</div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  ${itemRowsHtml}
                </table>
              </div>

              <div style="border:1px solid rgba(124,58,237,0.20);border-radius:14px;padding:14px;background:rgba(124,58,237,0.08);">
                <div style="font-size:14px;color:#7C3AED;font-weight:900;margin-bottom:6px;">Track your order</div>
                <div style="font-size:13px;color:#475569;line-height:1.6;">
                  Use your Order ID and checkout email address on the tracking page.
                </div>

                <div style="margin-top:14px;">
                  <a href="${esc(trackingUrl)}" style="display:inline-block;background:#7C3AED;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:900;">
                    Track Order
                  </a>
                </div>

                <div style="font-size:11px;color:#64748B;margin-top:12px;line-height:1.6;">
                  If the button does not work, copy this link:<br>
                  <a href="${esc(trackingUrl)}" style="color:#7C3AED;">${esc(trackingUrl)}</a>
                </div>
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:18px 28px;background:#0F172A;text-align:center;color:#94A3B8;font-size:11px;line-height:1.6;">
              © ${new Date().getFullYear()} Unicoporate.com. All rights reserved.
              <br>Sent to ${esc(customerEmail || 'you')}.
            </td>
          </tr>
        </table>
      </div>
    </body>
    </html>
    `.trim();

  return {
    to: customerEmail,
    recipients,
    subject,
    text,
    html,
  };
}

async function sendOrderConfirmationEmail(order, baseUrl) {
  const built = buildOrderConfirmationEmail(order, baseUrl);
  const recipients = Array.isArray(built.recipients) ? built.recipients : [];

  if (recipients.length === 0) {
    throw new Error('sendOrderConfirmationEmail: customer email is missing');
  }

  const results = [];

  for (const recipient of recipients) {
    const res = await sendMail({
      to: recipient,
      subject: built.subject,
      text: built.text,
      html: built.html,
      replyTo: process.env.SUPPORT_INBOX || undefined,
    });

    results.push(res);

    console.log('📨 Order confirmation email sent:', {
      to: recipient,
      orderId: order?.orderId || '',
      from: FROM,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
    });
  }

  return results;
}

module.exports = {
  buildOrderConfirmationEmail,
  sendOrderConfirmationEmail,
};
