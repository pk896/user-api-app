// utils/emails/officialNumberRejectedEmail.js
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

// ✅ Render-safe: if baseUrl not passed, fall back to env PUBLIC_BASE_URL
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

function buildOfficialNumberRejectedEmail(business, baseUrl, reason) {
  const b = business || {};
  const safeBase = resolveBaseUrl(baseUrl);

  const profileUrlAbs = safeBase ? `${safeBase}/business/profile` : '';
  const profileUrlText = profileUrlAbs || '/business/profile';

  const officialNumber = b.officialNumber || '—';
  const officialNumberType = b.officialNumberType || 'OTHER';
  const safeReason = String(reason || '').trim() || 'No reason provided';

  const subject = '❌ Official Number Rejected - Unicoporate.com';

  // ✅ TEXT = no HTML tags
  const text = `
Hi ${b.name || 'there'},

Unfortunately, your Official Number was rejected by our admin team.
Please log in, update your business details, and submit again.

Official Number: ${officialNumber}
Type: ${officialNumberType}

Reason:
${safeReason}

Update your profile:
${profileUrlText}

Security reminder:
If you didn’t request this, contact support immediately.

Unicoporate.com
`.trim();

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
      .btn { display:block !important; width:100% !important; box-sizing:border-box !important; text-align:center !important; }
      .title { font-size: 20px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#0F172A;">
  <div style="padding:18px 10px;">
    <table class="container" role="presentation" cellspacing="0" cellpadding="0" width="640"
      style="width:640px;max-width:640px;margin:0 auto;background:#FFFFFF;border:1px solid rgba(220,38,38,0.18);
             border-radius:18px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,0.08);">

      <tr>
        <td class="px" style="padding:22px 26px;background:linear-gradient(135deg, #DC2626 0%, #0F172A 100%);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div style="min-width:0;">
              <div style="color:#fff;font-weight:900;font-size:16px;letter-spacing:-0.2px;">Unicoporate.com</div>
              <div style="color:rgba(255,255,255,0.92);font-size:12px;margin-top:4px;">Official Number verification update</div>
            </div>
            <div style="background:rgba(255,255,255,0.14);border:1px solid rgba(255,255,255,0.20);
                        color:#fff;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:900;">
              ❌ REJECTED
            </div>
          </div>
        </td>
      </tr>

      <tr>
        <td class="px" style="padding:20px 26px;">
          <h2 class="title" style="margin:0 0 10px;color:#DC2626;font-size:22px;letter-spacing:-0.2px;line-height:1.25;">
            Official Number Rejected
          </h2>

          <p style="margin:0 0 12px;line-height:1.6;color:#0F172A;font-size:14px;">
            Hi <b>${esc(b.name || 'there')}</b>,
          </p>

          <p style="margin:0 0 14px;line-height:1.6;color:#475569;font-size:14px;">
            Unfortunately, your Official Number was rejected by our admin team.
            Please update your business details and submit again.
          </p>

          <div style="background:#FEF2F2;border:1px solid #FECACA;border-radius:14px;padding:12px 14px;margin:14px 0;">
            <div style="margin:0 0 6px;"><b>Official Number:</b> ${esc(officialNumber)}</div>
            <div style="margin:0 0 10px;"><b>Type:</b> ${esc(officialNumberType)}</div>
            <div><b>Reason:</b><br/>${esc(safeReason)}</div>
          </div>

          ${
            profileUrlAbs
              ? `
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:14px;">
                <tr>
                  <td align="center">
                    <a class="btn" href="${profileUrlAbs}"
                       style="display:inline-block;background:#0F172A;color:#fff;text-decoration:none;
                              padding:12px 16px;border-radius:12px;font-weight:900;font-size:13px;">
                      Update Business Details →
                    </a>
                  </td>
                </tr>
              </table>

              <p style="font-size:12px;color:#64748B;margin:14px 0 0;line-height:1.6;">
                If the button does not work, copy/paste this link:<br/>
                <a style="color:#2563EB;" href="${profileUrlAbs}">${profileUrlAbs}</a>
              </p>
              `
              : `
              <p style="font-size:12px;color:#64748B;margin:14px 0 0;line-height:1.6;">
                Log in to your account and open your profile to update details:
                <b>${esc(profileUrlText)}</b>
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

      <tr>
        <td class="px" style="padding:16px 26px;background:#0F172A;text-align:center;">
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

  return { subject, text, html, profileUrl: profileUrlAbs || profileUrlText };
}

async function sendOfficialNumberRejectedEmail(business, baseUrl, reason) {
  const b = business || {};

  if (!b.email) {
    throw new Error('sendOfficialNumberRejectedEmail: business.email is missing');
  }

  assertMailerEnv();

  const built = buildOfficialNumberRejectedEmail(b, baseUrl, reason);

  try {
    const res = await sendMail({
      to: b.email,
      subject: built.subject,
      text: built.text,
      html: built.html,
      replyTo: process.env.SUPPORT_INBOX || undefined,
    });

    console.log('📨 OfficialNumber rejected email sent:', {
      to: b.email,
      from: FROM,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
      hasBaseUrl: !!resolveBaseUrl(baseUrl),
      usingFromEnv: !!process.env.SMTP_FROM,
    });

    return { ok: true, provider: String(process.env.MAIL_PROVIDER || 'sendgrid'), res };
  } catch (err) {
    const details = err?.response?.body || err?.response || err?.message || err;
    console.error('❌ OfficialNumber rejected email failed:', details);
    throw err;
  }
}

module.exports = {
  buildOfficialNumberRejectedEmail,
  sendOfficialNumberRejectedEmail,
};
