// utils/emails/officialNumberVerifiedEmail.js
'use strict';

// ✅ correct relative path: utils/emails/* -> utils/mailer.js
const { sendMail, FROM } = require('../mailer');

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeBaseUrl(baseUrl) {
  const u = String(baseUrl || '').trim();
  if (!u) return '';
  return u.replace(/\/+$/, '');
}

// ✅ Render-safe: if caller forgets baseUrl, fall back to env PUBLIC_BASE_URL
function resolveBaseUrl(baseUrl) {
  const fromArg = sanitizeBaseUrl(baseUrl);
  if (fromArg) return fromArg;
  return sanitizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
}

/**
 * ✅ Match mailer.js rules exactly:
 * - sendgrid requires: SENDGRID_API_KEY + SMTP_FROM (used as "from")
 * - smtp requires: SMTP_HOST + SMTP_USER + SMTP_PASS + SMTP_FROM
 */
function assertMailerEnv() {
  const provider = String(process.env.MAIL_PROVIDER || 'sendgrid')
    .trim()
    .toLowerCase();

  if (provider === 'sendgrid') {
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error('MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing');
    }
    if (!process.env.SMTP_FROM) {
      throw new Error('SMTP_FROM is missing (used as SendGrid "from")');
    }
    return;
  }

  if (provider === 'smtp') {
    const host = (process.env.SMTP_HOST || '').trim();
    const user = (process.env.SMTP_USER || '').trim();
    const pass = (process.env.SMTP_PASS || '').trim();
    const from = (process.env.SMTP_FROM || '').trim();

    if (!host || !user || !pass || !from) {
      throw new Error(
        'MAIL_PROVIDER=smtp but SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM is missing',
      );
    }
    return;
  }

  throw new Error(`Unknown MAIL_PROVIDER "${provider}" (use "sendgrid" or "smtp")`);
}

function brandTokens() {
  return {
    purple: '#7C3AED',
    blue: '#2563EB',
    green: '#22C55E',
    black: '#0F172A',
    slate: '#475569',
    muted: '#64748B',
    bg: '#F8FAFC',
    border: '#E2E8F0',
    white: '#FFFFFF',
  };
}

function buildOfficialNumberVerifiedEmail(business, baseUrl) {
  const b = business || {};
  const brand = brandTokens();

  const safeBase = resolveBaseUrl(baseUrl);

  // ✅ buttons need absolute URLs; if we can't, keep a safe fallback text path
  const dashboardUrlAbs = safeBase ? `${safeBase}/business/dashboard` : '';
  const dashboardUrlText = dashboardUrlAbs || '/business/dashboard';

  const subject = '✅ Official Number Verified - Unicoporate.com';

  const officialNumber = b.officialNumber || '—';
  const officialNumberType = b.officialNumberType || 'OTHER';

  // ✅ TEXT = no HTML tags
  const text = `
Hi ${b.name || 'there'},

Good news! Your Official Number has been verified by our admin team.
You can now use all business features (add products, sell, supply, and buy stock from verified suppliers).

Official Number: ${officialNumber}
Type: ${officialNumberType}

Continue in your dashboard:
${dashboardUrlText}

Security reminder:
If you didn’t request this, contact support immediately.

Unicoporate.com
`.trim();

  // ✅ Keep HTML email “client-friendly” (tables, inline styles)
  const html = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    @media (max-width: 620px) {
      .container { width: 100% !important; }
      .px { padding-left: 16px !important; padding-right: 16px !important; }
      .title { font-size: 20px !important; }
      .btn { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${brand.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${brand.black};">
  <div style="padding:18px 10px;">
    <table class="container" role="presentation" cellspacing="0" cellpadding="0" width="640"
      style="width:640px;max-width:640px;margin:0 auto;background:${brand.white};
             border:1px solid rgba(34,197,94,0.22);border-radius:18px;overflow:hidden;
             box-shadow:0 10px 30px rgba(15,23,42,0.08);">

      <!-- Header -->
      <tr>
        <td class="px" style="padding:22px 26px;background:linear-gradient(135deg, ${brand.green} 0%, ${brand.blue} 100%);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="min-width:0;">
              <div style="color:#fff;font-weight:900;font-size:16px;letter-spacing:-0.2px;">Unicoporate.com</div>
              <div style="color:rgba(255,255,255,0.92);font-size:12px;margin-top:4px;">Official Number verified</div>
            </div>
            <div style="background:rgba(255,255,255,0.16);border:1px solid rgba(255,255,255,0.22);
                        color:#fff;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:900;">
              ✅ VERIFIED
            </div>
          </div>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td class="px" style="padding:20px 26px;">
          <h2 class="title" style="margin:0 0 10px;font-size:22px;line-height:1.25;letter-spacing:-0.2px;">
            Congrats, ${esc(b.name || 'there')} 🎉
          </h2>

          <p style="margin:0 0 14px;line-height:1.6;color:${brand.slate};font-size:14px;">
            Good news! Your Official Number has been verified by our admin team.
            You can now use all business features (add products, sell, supply, and buy stock from verified suppliers).
          </p>

          <div style="background:#ECFDF5;border:1px solid #86EFAC;border-radius:14px;padding:12px 14px;margin:14px 0;">
            <div style="margin:0 0 6px;"><b>Official Number:</b> ${esc(officialNumber)}</div>
            <div><b>Type:</b> ${esc(officialNumberType)}</div>
          </div>

          ${
            dashboardUrlAbs
              ? `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;">
                <tr>
                  <td align="center">
                    <a class="btn" href="${dashboardUrlAbs}"
                       style="display:inline-block;background:${brand.black};color:#fff;text-decoration:none;
                              padding:12px 16px;border-radius:12px;font-weight:900;font-size:13px;">
                      Open Dashboard →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:12px;color:${brand.muted};margin:14px 0 0;line-height:1.6;">
                If the button does not work, copy/paste this link:<br/>
                <a style="color:${brand.blue};" href="${dashboardUrlAbs}">${dashboardUrlAbs}</a>
              </p>
              `
              : `
              <p style="font-size:12px;color:${brand.muted};margin:14px 0 0;line-height:1.6;">
                Log in to your account and open your dashboard:
                <b>${esc(dashboardUrlText)}</b>
              </p>
              `
          }

          <div style="margin-top:16px;border-radius:12px;background:#FFF7ED;border:1px solid #FED7AA;padding:12px 12px;">
            <div style="color:#7C2D12;font-size:12px;line-height:1.55;font-weight:800;">
              🔒 Security reminder:
              <span style="font-weight:700;">If you didn’t request this, contact support immediately.</span>
            </div>
          </div>
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td class="px" style="padding:16px 26px;background:${brand.black};text-align:center;">
          <div style="color:#94A3B8;font-size:11px;line-height:1.6;">
            © ${new Date().getFullYear()} Unicoporate.com. All rights reserved.
            <br/>Sent to ${esc(b.email || 'you')}.
          </div>
        </td>
      </tr>

    </table>
  </div>
</body>
</html>
`.trim();

  return {
    subject,
    text,
    html,
    dashboardUrl: dashboardUrlAbs || dashboardUrlText,
  };
}

async function sendOfficialNumberVerifiedEmail(business, baseUrl) {
  const b = business || {};

  if (!b.email) {
    throw new Error('sendOfficialNumberVerifiedEmail: business.email is missing');
  }

  assertMailerEnv();

  const built = buildOfficialNumberVerifiedEmail(b, baseUrl);

  try {
    const res = await sendMail({
      to: b.email,
      subject: built.subject,
      text: built.text,
      html: built.html,
      replyTo: process.env.SUPPORT_INBOX || undefined,
    });

    console.log('📨 OfficialNumber verified email sent:', {
      to: b.email,
      from: FROM,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
      hasBaseUrl: !!resolveBaseUrl(baseUrl),
      usingFromEnv: !!process.env.SMTP_FROM,
    });

    return {
      ok: true,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
      res,
    };
  } catch (err) {
    const details = err?.response?.body || err?.response || err?.message || err;
    console.error('❌ OfficialNumber verified email failed:', details);
    throw err;
  }
}

module.exports = {
  buildOfficialNumberVerifiedEmail,
  sendOfficialNumberVerifiedEmail,
};
