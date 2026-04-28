// utils/emails/orderStatusEmail.js
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
  return String(
    baseUrl ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      '',
  )
    .trim()
    .replace(/\/+$/, '');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function getOrderStatusRecipients(order) {
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

function getTrackingNumber(order) {
  return String(
    order?.shippingTracking?.trackingNumber ||
      order?.shippo?.trackingNumber ||
      '',
  ).trim();
}

function getTrackingUrl(order) {
  return String(
    order?.shippingTracking?.trackingUrl ||
      '',
  ).trim();
}

function getCarrierText(order) {
  return String(
    order?.shippingTracking?.carrierLabel ||
      order?.shippo?.chosenRate?.provider ||
      order?.shippo?.carrier ||
      order?.shippingTracking?.carrierToken ||
      order?.shippingTracking?.carrier ||
      '',
  ).trim();
}

function getServiceText(order) {
  return String(
    order?.shippo?.chosenRate?.service ||
      order?.delivery?.name ||
      '',
  ).trim();
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

  return `Expected delivery is about ${cleanDays} ${dayWord}.`;
}

function getPublicTrackingUrl(order, baseUrl) {
  const safeBaseUrl = sanitizeBaseUrl(baseUrl);
  const orderId = String(order?.orderId || '').trim();
  const email = normalizeEmail(order?.payer?.email || order?.shipping?.email || '');

  if (!safeBaseUrl) return '/store/order-tracking';

  const params = new URLSearchParams();
  if (orderId) params.set('orderId', orderId);
  if (email) params.set('email', email);

  const qs = params.toString();
  return `${safeBaseUrl}/store/order-tracking${qs ? `?${qs}` : ''}`;
}

function buildStatusEmail({
  order,
  baseUrl,
  statusTitle,
  headline,
  intro,
  statusLabel,
}) {
  const o = order || {};
  const orderId = String(o.orderId || '').trim();
  const recipients = getOrderStatusRecipients(o);
  const customerEmail = recipients.join(', ');

  const trackingNumber = getTrackingNumber(o);
  const trackingUrl = getTrackingUrl(o);
  const carrierText = getCarrierText(o);
  const serviceText = getServiceText(o);
  const etaText = getDeliveryEtaText(o);
  const publicTrackingUrl = getPublicTrackingUrl(o, baseUrl);

  const subject = `${statusTitle} - ${orderId}`;

  const trackingTextLines = [
    carrierText ? `Carrier: ${carrierText}` : '',
    serviceText ? `Service: ${serviceText}` : '',
    trackingNumber ? `Tracking number: ${trackingNumber}` : '',
    trackingUrl ? `Carrier tracking link: ${trackingUrl}` : '',
    etaText ? etaText : '',
  ].filter(Boolean);

  const text = `
${headline}

${intro}

ORDER DETAILS
Order ID: ${orderId}
Status: ${statusLabel}
${trackingTextLines.length ? trackingTextLines.join('\n') : ''}

TRACK YOUR ORDER
${publicTrackingUrl}

Thank you for shopping with Unicoporate.com.
`.trim();

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
          <div style="font-size:13px;margin-top:5px;color:rgba(255,255,255,0.88);">${esc(statusLabel)}</div>
        </td>
      </tr>

      <tr>
        <td style="padding:24px 28px;">
          <h1 style="margin:0 0 10px;font-size:22px;color:#7C3AED;">${esc(headline)}</h1>
          <p style="margin:0 0 18px;color:#475569;line-height:1.6;">
            ${esc(intro)}
          </p>

          <div style="border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:16px;background:#FFFFFF;">
            <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Order ID</div>
            <div style="font-size:18px;font-weight:900;color:#0F172A;word-break:break-word;">${esc(orderId)}</div>

            <div style="height:12px;"></div>

            <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Status</div>
            <div style="font-size:18px;font-weight:900;color:#7C3AED;">${esc(statusLabel)}</div>

            ${
              carrierText
                ? `
                  <div style="height:12px;"></div>
                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Carrier</div>
                  <div style="font-weight:800;color:#0F172A;">${esc(carrierText)}</div>
                `
                : ''
            }

            ${
              serviceText
                ? `
                  <div style="height:12px;"></div>
                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Service</div>
                  <div style="font-weight:800;color:#0F172A;">${esc(serviceText)}</div>
                `
                : ''
            }

            ${
              trackingNumber
                ? `
                  <div style="height:12px;"></div>
                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Tracking number</div>
                  <div style="font-weight:900;color:#22C55E;word-break:break-word;">${esc(trackingNumber)}</div>
                `
                : ''
            }

            ${
              etaText
                ? `
                  <div style="height:12px;"></div>
                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">Delivery estimate</div>
                  <div style="font-weight:900;color:#7C3AED;">${esc(etaText)}</div>
                `
                : ''
            }
          </div>

          <div style="border:1px solid rgba(124,58,237,0.20);border-radius:14px;padding:14px;background:rgba(124,58,237,0.08);">
            <div style="font-size:14px;color:#7C3AED;font-weight:900;margin-bottom:6px;">Track your order</div>
            <div style="font-size:13px;color:#475569;line-height:1.6;">
              Use your Order ID and checkout email address on the tracking page.
            </div>

            <div style="margin-top:14px;">
              <a href="${esc(publicTrackingUrl)}" style="display:inline-block;background:#7C3AED;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:900;">
                Track Order
              </a>
            </div>

            ${
              trackingUrl
                ? `
                  <div style="margin-top:10px;">
                    <a href="${esc(trackingUrl)}" style="display:inline-block;background:#22C55E;color:#FFFFFF;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:900;">
                      Carrier Tracking
                    </a>
                  </div>
                `
                : ''
            }

            <div style="font-size:11px;color:#64748B;margin-top:12px;line-height:1.6;">
              If the button does not work, copy this link:<br>
              <a href="${esc(publicTrackingUrl)}" style="color:#7C3AED;">${esc(publicTrackingUrl)}</a>
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
    recipients,
    subject,
    text,
    html,
  };
}

async function sendBuiltEmail(order, built, sentAtField, logLabel) {
  const recipients = Array.isArray(built.recipients) ? built.recipients : [];

  if (recipients.length === 0) {
    throw new Error(`${logLabel}: customer email is missing`);
  }

  if (order?.[sentAtField]) {
    return { skipped: true, reason: 'ALREADY_SENT' };
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

    console.log(`📨 ${logLabel} sent:`, {
      to: recipient,
      orderId: order?.orderId || '',
      from: FROM,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
    });
  }

  if (sentAtField && order && typeof order.save === 'function') {
    order[sentAtField] = new Date();
    await order.save();
  }

  return results;
}

async function sendOrderProcessingEmail(order, baseUrl) {
  const built = buildStatusEmail({
    order,
    baseUrl,
    statusTitle: 'Your Unicoporate order is being processed',
    headline: 'Your order is being processed',
    intro: 'Your shipping label has been created and your order is now being prepared for shipment.',
    statusLabel: 'Processing',
  });

  return sendBuiltEmail(order, built, 'orderProcessingEmailSentAt', 'Order processing email');
}

async function sendOrderShippedEmail(order, baseUrl) {
  const built = buildStatusEmail({
    order,
    baseUrl,
    statusTitle: 'Your Unicoporate order has shipped',
    headline: 'Your order has shipped',
    intro: 'Your order is on its way. You can use the tracking details below to follow the delivery progress.',
    statusLabel: 'Shipped',
  });

  return sendBuiltEmail(order, built, 'orderShippedEmailSentAt', 'Order shipped email');
}

async function sendOrderDeliveredEmail(order, baseUrl) {
  const built = buildStatusEmail({
    order,
    baseUrl,
    statusTitle: 'Your Unicoporate order has been delivered',
    headline: 'Your order has been delivered',
    intro: 'Your order has been marked as delivered. Thank you for shopping with Unicoporate.com.',
    statusLabel: 'Delivered',
  });

  return sendBuiltEmail(order, built, 'orderDeliveredEmailSentAt', 'Order delivered email');
}

module.exports = {
  sendOrderProcessingEmail,
  sendOrderShippedEmail,
  sendOrderDeliveredEmail,
};
