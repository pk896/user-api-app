// utils/emails/cjOrderEmail.js
'use strict';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeString(value, max = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

function normalizeEmail(value) {
  return safeString(value, 320).toLowerCase();
}

function sanitizeBaseUrl(value) {
  return safeString(
    value ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL ||
      '',
    2000,
  ).replace(/\/+$/, '');
}

function niceDate(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  try {
    return date.toLocaleString('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return date.toISOString();
  }
}

function formatMoney(value, currency) {
  const amount = Number(value || 0);

  const code =
    safeString(
      currency ||
        process.env.BASE_CURRENCY ||
        'USD',
      3,
    ).toUpperCase() || 'USD';

  try {
    const formatted = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);

    return code === 'ZAR'
      ? formatted.replace(/^ZAR\s?/, 'R')
      : formatted;
  } catch {
    return `${code} ${amount.toFixed(2)}`;
  }
}

function getCjOrderRecipients(order) {
  const payerEmail = normalizeEmail(
    order?.payer?.email,
  );

  const deliveryEmail = normalizeEmail(
    order?.deliveryAddress?.email ||
      order?.customerEmail,
  );

  return [
    ...new Set(
      [payerEmail, deliveryEmail].filter(Boolean),
    ),
  ];
}

function getTrackingNumber(order) {
  return safeString(
    order?.tracking?.trackingNumber ||
      order?.supplierOrder?.trackingNumber,
    300,
  );
}

function getTrackingUrl(order) {
  const value = safeString(
    order?.tracking?.trackingUrl ||
      order?.supplierOrder?.trackingUrl,
    2000,
  );

  return /^https:\/\//i.test(value)
    ? value
    : '';
}

function getCarrier(order) {
  return safeString(
    order?.tracking?.carrierName ||
      order?.supplierOrder?.logisticsName ||
      order?.selectedShipping?.logisticsName,
    300,
  );
}

function getDeliveryEstimate(order) {
  if (order?.tracking?.estimatedDelivery) {
    return niceDate(
      order.tracking.estimatedDelivery,
    );
  }

  return safeString(
    order?.selectedShipping?.deliveryEstimate,
    200,
  );
}

function getPublicTrackingUrl(order, baseUrl) {
  const cleanBaseUrl = sanitizeBaseUrl(baseUrl);

  const orderNumber = safeString(
    order?.cjOrderNumber,
    100,
  );

  const email = normalizeEmail(
    order?.deliveryAddress?.email ||
      order?.customerEmail ||
      order?.payer?.email,
  );

  const params = new URLSearchParams();

  if (orderNumber) {
    params.set('cjOrderNumber', orderNumber);
  }

  if (email) {
    params.set('email', email);
  }

  const query = params.toString();

  if (!cleanBaseUrl) {
    return `/store/cj-order-tracking${query ? `?${query}` : ''}`;
  }

  return `${cleanBaseUrl}/store/cj-order-tracking${query ? `?${query}` : ''}`;
}

const EVENT_CONTENT = {
  PAYMENT_COMPLETED: {
    subject: 'Your Kasyora CJ order is confirmed',
    heading: 'Thank you for your CJ order',
    statusLabel: 'Payment completed',
    intro:
      'Your payment was completed successfully and your Kasyora CJ order has been confirmed.',
  },

  CJ_ORDER_PENDING: {
    subject: 'Your Kasyora CJ order is being prepared',
    heading: 'We are preparing your supplier order',
    statusLabel: 'Supplier order pending',
    intro:
      'Your payment is complete and Kasyora is preparing your order for the CJ fulfilment network.',
  },

  CJ_ORDER_CREATED: {
    subject: 'Your CJ supplier order has been created',
    heading: 'Your order has entered fulfilment',
    statusLabel: 'Supplier order created',
    intro:
      'Your order was accepted into the CJ fulfilment process and is now being prepared for dispatch.',
  },

  PROCESSING: {
    subject: 'Your Kasyora CJ order is being processed',
    heading: 'Your parcel is being prepared',
    statusLabel: 'Processing',
    intro:
      'CJ is processing and preparing your products for shipment.',
  },

  SHIPPED: {
    subject: 'Your Kasyora CJ order has shipped',
    heading: 'Your parcel has been dispatched',
    statusLabel: 'Shipped',
    intro:
      'Your parcel has left the fulfilment facility and is now on its way.',
  },

  IN_TRANSIT: {
    subject: 'Your Kasyora CJ parcel is in transit',
    heading: 'Your parcel is moving',
    statusLabel: 'In transit',
    intro:
      'Your parcel is moving through the delivery network toward its destination.',
  },

  OUT_FOR_DELIVERY: {
    subject: 'Your Kasyora CJ parcel is out for delivery',
    heading: 'Your parcel is arriving soon',
    statusLabel: 'Out for delivery',
    intro:
      'Your parcel is with the local delivery courier and is expected to arrive soon.',
  },

  DELIVERED: {
    subject: 'Your Kasyora CJ parcel was delivered',
    heading: 'Your parcel has been delivered',
    statusLabel: 'Delivered',
    intro:
      'The carrier has marked your parcel as delivered. Thank you for shopping with Kasyora.com.',
  },

  CANCELLED: {
    subject: 'Update about your Kasyora CJ order',
    heading: 'Your CJ order was cancelled',
    statusLabel: 'Cancelled',
    intro:
      'Your CJ order has been marked as cancelled. Please contact Kasyora support if you need assistance.',
  },

  RETURNED: {
    subject: 'Your Kasyora CJ parcel is being returned',
    heading: 'Your parcel is being returned',
    statusLabel: 'Returned',
    intro:
      'The carrier has marked your parcel for return. Please contact Kasyora support for assistance.',
  },
};

function getEventContent(eventType) {
  const type = safeString(
    eventType,
    100,
  ).toUpperCase();

  return (
    EVENT_CONTENT[type] || {
      subject: 'Your Kasyora CJ order status changed',
      heading: 'CJ order status update',
      statusLabel:
        type.replace(/_/g, ' ') || 'Updated',
      intro:
        'There is a new update for your Kasyora CJ order.',
    }
  );
}

function buildCjOrderEmail({
  order,
  eventType,
  recipient,
  baseUrl,
}) {
  const content = getEventContent(eventType);

  const orderNumber = safeString(
    order?.cjOrderNumber,
    100,
  );

  const recipientEmail = normalizeEmail(recipient);

  const trackingNumber = getTrackingNumber(order);
  const trackingUrl = getTrackingUrl(order);
  const carrier = getCarrier(order);
  const deliveryEstimate =
    getDeliveryEstimate(order);

  const publicTrackingUrl =
    getPublicTrackingUrl(order, baseUrl);

  const totalText = formatMoney(
    order?.payableTotal?.value,
    order?.payableTotal?.currency ||
      order?.currency,
  );

  const items = Array.isArray(order?.items)
    ? order.items
    : [];

  const itemText = items.length
    ? items
        .map((item) => {
          const variant = safeString(
            item?.variantName,
            500,
          );

          return `- ${safeString(item?.name, 500) || 'CJ product'}${
            variant ? ` (${variant})` : ''
          } x ${Math.max(1, Number(item?.quantity || 1))}`;
        })
        .join('\n')
    : '- CJ order items confirmed';

  const subject = `${content.subject} - ${orderNumber}`;

  const text = `
${content.heading}

${content.intro}

CJ ORDER DETAILS
CJ order number: ${orderNumber}
Status: ${content.statusLabel}
Order total: ${totalText}
Order date: ${niceDate(order?.createdAt)}

ITEMS
${itemText}

${carrier ? `Carrier / logistics: ${carrier}` : ''}
${trackingNumber ? `Tracking number: ${trackingNumber}` : ''}
${deliveryEstimate ? `Delivery estimate: ${deliveryEstimate}` : ''}
${trackingUrl ? `Carrier tracking: ${trackingUrl}` : ''}

TRACK YOUR CJ ORDER
${publicTrackingUrl}

Use your CJ order number and checkout email address on the tracking page.

Thank you for shopping with Kasyora.com.
`.trim();

  const itemRows = items.length
    ? items
        .map(
          (item) => `
            <tr>
              <td style="padding:10px 0;border-bottom:1px solid #E2E8F0;">
                <div style="font-weight:800;color:#0F172A;">
                  ${esc(item?.name || 'CJ product')}
                </div>

                ${
                  item?.variantName
                    ? `
                      <div style="font-size:12px;color:#64748B;margin-top:3px;">
                        ${esc(item.variantName)}
                      </div>
                    `
                    : ''
                }
              </td>

              <td align="right" style="padding:10px 0;border-bottom:1px solid #E2E8F0;font-weight:800;color:#7C3AED;">
                ${Math.max(1, Number(item?.quantity || 1))}
              </td>
            </tr>
          `,
        )
        .join('')
    : `
        <tr>
          <td style="padding:10px 0;">
            CJ order items confirmed
          </td>
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
    <table
      role="presentation"
      width="640"
      cellspacing="0"
      cellpadding="0"
      style="width:640px;max-width:100%;margin:0 auto;background:#FFFFFF;border:1px solid rgba(124,58,237,0.18);border-radius:18px;overflow:hidden;"
    >
      <tr>
        <td style="padding:26px 28px;background:#7C3AED;color:#FFFFFF;">
          <div style="font-size:21px;font-weight:900;">
            Kasyora.com
          </div>

          <div style="font-size:13px;margin-top:5px;color:rgba(255,255,255,0.88);">
            CJ Dropshipping order update
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:24px 28px;">
          <h1 style="margin:0 0 10px;font-size:22px;color:#7C3AED;">
            ${esc(content.heading)}
          </h1>

          <p style="margin:0 0 18px;color:#475569;line-height:1.6;">
            ${esc(content.intro)}
          </p>

          <div style="border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:16px;">
            <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
              CJ order number
            </div>

            <div style="font-size:18px;font-weight:900;color:#0F172A;word-break:break-word;">
              ${esc(orderNumber)}
            </div>

            <div style="height:12px;"></div>

            <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
              Status
            </div>

            <div style="font-size:18px;font-weight:900;color:#7C3AED;">
              ${esc(content.statusLabel)}
            </div>

            <div style="height:12px;"></div>

            <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
              Total
            </div>

            <div style="font-size:18px;font-weight:900;color:#22C55E;">
              ${esc(totalText)}
            </div>

            ${
              carrier
                ? `
                  <div style="height:12px;"></div>

                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
                    Carrier / logistics
                  </div>

                  <div style="font-weight:800;">
                    ${esc(carrier)}
                  </div>
                `
                : ''
            }

            ${
              trackingNumber
                ? `
                  <div style="height:12px;"></div>

                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
                    Tracking number
                  </div>

                  <div style="font-weight:900;color:#22C55E;word-break:break-word;">
                    ${esc(trackingNumber)}
                  </div>
                `
                : ''
            }

            ${
              deliveryEstimate
                ? `
                  <div style="height:12px;"></div>

                  <div style="font-size:12px;color:#64748B;font-weight:800;text-transform:uppercase;">
                    Delivery estimate
                  </div>

                  <div style="font-weight:800;">
                    ${esc(deliveryEstimate)}
                  </div>
                `
                : ''
            }
          </div>

          <div style="border:1px solid #E2E8F0;border-radius:14px;padding:14px;margin-bottom:16px;">
            <div style="font-size:14px;color:#7C3AED;font-weight:900;margin-bottom:8px;">
              Items
            </div>

            <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
              ${itemRows}
            </table>
          </div>

          <div style="border:1px solid rgba(124,58,237,0.22);border-radius:14px;padding:14px;background:rgba(124,58,237,0.08);">
            <div style="font-size:14px;color:#7C3AED;font-weight:900;margin-bottom:6px;">
              Track your CJ order
            </div>

            <div style="font-size:13px;color:#475569;line-height:1.6;">
              Use your CJ order number and checkout email address.
            </div>

            <div style="margin-top:14px;">
              <a
                href="${esc(publicTrackingUrl)}"
                style="display:inline-block;background:#7C3AED;color:#FFFFFF;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:900;"
              >
                Track CJ Order
              </a>
            </div>

            ${
              trackingUrl
                ? `
                  <div style="margin-top:10px;">
                    <a
                      href="${esc(trackingUrl)}"
                      style="display:inline-block;background:#22C55E;color:#FFFFFF;text-decoration:none;padding:10px 16px;border-radius:999px;font-weight:900;"
                    >
                      Open Carrier Tracking
                    </a>
                  </div>
                `
                : ''
            }

            <div style="font-size:11px;color:#64748B;margin-top:12px;line-height:1.6;">
              If the button does not work, copy this link:<br>
              <a href="${esc(publicTrackingUrl)}" style="color:#7C3AED;">
                ${esc(publicTrackingUrl)}
              </a>
            </div>
          </div>
        </td>
      </tr>

      <tr>
        <td style="padding:18px 28px;background:#0F172A;text-align:center;color:#94A3B8;font-size:11px;line-height:1.6;">
          © ${new Date().getFullYear()} Kasyora.com. All rights reserved.
          <br>
          Sent to ${esc(recipientEmail || 'you')}.
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
`.trim();

  return {
    recipient: recipientEmail,
    subject,
    text,
    html,
  };
}

module.exports = {
  EVENT_CONTENT,
  getCjOrderRecipients,
  getPublicTrackingUrl,
  buildCjOrderEmail,
};
