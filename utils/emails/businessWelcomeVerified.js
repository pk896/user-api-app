// utils/emails/businessWelcomeVerified.js
'use strict';

// ✅ IMPORTANT: correct path to your working mailer
// File structure: utils/mailer.js  +  utils/emails/businessWelcomeVerified.js
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

function normalizeStatus(s) {
  const v = String(s || 'pending').trim().toLowerCase();
  if (v === 'approved') return 'verified';
  if (['verified', 'pending', 'rejected', 'unverified'].includes(v)) return v;
  return 'pending';
}

function statusMeta(status) {
  const map = {
    verified: {
      label: 'VERIFIED',
      toneBg: 'rgba(34, 197, 94, 0.14)',
      toneBorder: 'rgba(34, 197, 94, 0.25)',
      toneText: '#15803D',
      icon: '✅',
      nextTitle: 'You’re all set',
      nextBody:
        'Your Official Number is verified. You can now access all business features from your dashboard.',
      ctaPrimary: 'Open Dashboard',
      ctaHint: 'Start selling, supplying, or buying stock today.',
    },
    pending: {
      label: 'PENDING REVIEW',
      toneBg: 'rgba(124, 58, 237, 0.10)',
      toneBorder: 'rgba(124, 58, 237, 0.22)',
      toneText: '#7C3AED',
      icon: '⏳',
      nextTitle: 'Next steps',
      nextBody:
        'Your Official Number verification is in progress. We usually review within 1–2 business days. You’ll receive an email as soon as it’s approved or rejected.',
      ctaPrimary: 'Open Dashboard',
      ctaHint: 'You can still explore your dashboard while we review.',
    },
    rejected: {
      label: 'REJECTED',
      toneBg: 'rgba(239, 68, 68, 0.12)',
      toneBorder: 'rgba(239, 68, 68, 0.22)',
      toneText: '#991B1B',
      icon: '❌',
      nextTitle: 'Action required',
      nextBody:
        'Your Official Number was rejected. Please update your details and submit again from your profile page.',
      ctaPrimary: 'Update Profile',
      ctaHint: 'Fix the details and resubmit for verification.',
    },
    unverified: {
      label: 'UNVERIFIED',
      toneBg: 'rgba(37, 99, 235, 0.10)',
      toneBorder: 'rgba(37, 99, 235, 0.22)',
      toneText: '#2563EB',
      icon: 'ℹ️',
      nextTitle: 'Complete verification',
      nextBody:
        'Your account is created, but verification is not complete yet. Please submit your official details in your profile.',
      ctaPrimary: 'Update Profile',
      ctaHint: 'Complete verification to unlock all features.',
    },
  };

  return map[status] || map.pending;
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

// ✅ Render-friendly: if you forget to pass baseUrl, we'll try PUBLIC_BASE_URL
function resolveBaseUrl(baseUrl) {
  const fromArg = sanitizeBaseUrl(baseUrl);
  if (fromArg) return fromArg;

  const env = sanitizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
  return env;
}

// ✅ Soft guard: if mail env missing, throw an explicit error (so Render logs show it)
function assertMailerEnv() {
  const provider = String(process.env.MAIL_PROVIDER || 'sendgrid').toLowerCase();
  if (provider === 'sendgrid') {
    if (!process.env.SENDGRID_API_KEY) {
      throw new Error('MAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is missing');
    }
    if (!process.env.SMTP_FROM) {
      throw new Error('SMTP_FROM is missing (used as SendGrid "from")');
    }
  }
}

function buildBusinessWelcomeVerifiedEmail(business, baseUrl) {
  const b = business || {};
  const ver = b.verification || {};
  const status = normalizeStatus(ver.status);
  const meta = statusMeta(status);
  const brand = brandTokens();

  const safeBaseUrl = resolveBaseUrl(baseUrl);

  // absolute links (buttons need absolute URLs)
  const dashboardUrl = safeBaseUrl ? `${safeBaseUrl}/business/dashboard` : '';
  const profileUrl = safeBaseUrl ? `${safeBaseUrl}/business/profile` : '';

  // pick primary CTA based on status
  const primaryUrl =
    status === 'verified' || status === 'pending' ? dashboardUrl : profileUrl;

  const secondaryUrl =
    status === 'verified' || status === 'pending' ? profileUrl : dashboardUrl;

  const subject = `🎉 Welcome to Unicoporate.com — Business Account Created`;

  const businessId = b.internalBusinessId || b._id || '—';

  const text = `
Welcome to Unicoporate.com!

Your business account has been created and your email is verified.

ACCOUNT DETAILS
- Business Name: ${b.name || '—'}
- Email: ${b.email || '—'}
- Role: ${(b.role || 'business').toUpperCase()}
- Business ID: ${businessId}
- Official Number: ${b.officialNumber || '—'}
- Official Number Type: ${b.officialNumberType || 'OTHER'}

VERIFICATION STATUS
- Email: VERIFIED
- Official Number: ${status.toUpperCase()}

NEXT
${meta.nextBody}

${dashboardUrl ? `Dashboard: ${dashboardUrl}` : 'Dashboard: (log in to your account)'}
${profileUrl ? `Profile: ${profileUrl}` : 'Profile: (log in to your account)'}

Security reminder:
If you didn’t create this account, contact support immediately.
`.trim();

  const showButtons = Boolean(primaryUrl);

  const buttonsHtml = showButtons
    ? `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:16px;">
        <tr>
          <td align="center" style="padding:6px 0 0;">
            <a href="${primaryUrl}"
               style="display:inline-block;background:${brand.purple};color:#fff;text-decoration:none;
                      padding:12px 18px;border-radius:12px;font-weight:900;font-size:13px;">
              ${esc(meta.ctaPrimary)} →
            </a>
            ${secondaryUrl ? `<span style="display:inline-block;width:10px;"></span>` : ''}
            ${
              secondaryUrl
                ? `<a href="${secondaryUrl}"
                     style="display:inline-block;background:#fff;color:${brand.black};text-decoration:none;
                            padding:12px 18px;border-radius:12px;font-weight:900;font-size:13px;border:1px solid ${brand.border};">
                    ${status === 'verified' || status === 'pending' ? 'Update Profile' : 'Open Dashboard'}
                  </a>`
                : ''
            }
          </td>
        </tr>
      </table>
    `
    : `
      <div style="margin-top:16px;color:${brand.slate};font-size:13px;line-height:1.6;">
        Log in to Unicoporate.com to open your dashboard and profile.
      </div>
    `;

  const fallbackLinksHtml =
    dashboardUrl || profileUrl
      ? `
        <div style="margin-top:14px;color:#94A3B8;font-size:11px;line-height:1.6;">
          If buttons don’t work, copy/paste:
          ${dashboardUrl ? `<br/>Dashboard: <a style="color:${brand.blue};" href="${dashboardUrl}">${dashboardUrl}</a>` : ''}
          ${profileUrl ? `<br/>Profile: <a style="color:${brand.blue};" href="${profileUrl}">${profileUrl}</a>` : ''}
        </div>
      `
      : '';

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
      .py { padding-top: 18px !important; padding-bottom: 18px !important; }
      .title { font-size: 20px !important; }
      .stack { display:block !important; width:100% !important; }
      .right { text-align:left !important; }
    }
  </style>
</head>

<body style="margin:0;padding:0;background:${brand.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${brand.black};">
  <div style="padding:18px 10px;">
    <table class="container" role="presentation" cellspacing="0" cellpadding="0" width="640"
      style="width:640px;max-width:640px;margin:0 auto;background:${brand.white};
             border:1px solid rgba(124,58,237,0.16);border-radius:18px;overflow:hidden;
             box-shadow:0 10px 30px rgba(15,23,42,0.08);">

      <!-- Header -->
      <tr>
        <td class="px py" style="padding:26px 28px;background:linear-gradient(135deg, ${brand.purple} 0%, ${brand.blue} 100%);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
            <div class="stack" style="min-width:0;">
              <div style="display:inline-block;background:rgba(255,255,255,0.16);border:1px solid rgba(255,255,255,0.22);border-radius:12px;padding:10px 14px;">
                <div style="color:#fff;font-weight:900;letter-spacing:-0.3px;font-size:16px;">
                  Unicoporate.com
                </div>
                <div style="color:rgba(255,255,255,0.92);font-size:12px;margin-top:2px;">
                  Business account created
                </div>
              </div>

              <div style="margin-top:14px;">
                <span style="display:inline-block;background:${meta.toneBg};border:1px solid ${meta.toneBorder};color:${meta.toneText};
                             padding:8px 12px;border-radius:999px;font-size:12px;font-weight:900;">
                  ${esc(meta.icon)} Official Number: ${esc(meta.label)}
                </span>
              </div>
            </div>

            <div class="stack right" style="text-align:right;">
              <div style="display:inline-block;background:rgba(34,197,94,0.18);border:1px solid rgba(34,197,94,0.28);
                          color:#15803D;border-radius:999px;padding:8px 12px;font-size:12px;font-weight:900;">
                ✅ Email Verified
              </div>
            </div>
          </div>
        </td>
      </tr>

      <!-- Body -->
      <tr>
        <td class="px" style="padding:22px 28px;">
          <h2 class="title" style="margin:0 0 8px;font-size:22px;line-height:1.25;letter-spacing:-0.2px;">
            Welcome, ${esc(b.name || 'Business')} 👋
          </h2>
          <p style="margin:0 0 16px;color:${brand.slate};font-size:14px;line-height:1.6;">
            Your business account is ready. Here are your details and current verification status.
          </p>

          <!-- Account summary card -->
          <div style="border:1px solid ${brand.border};border-radius:14px;background:#fff;padding:14px 14px;margin:12px 0 16px;">
            <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font-size:13px;">
              <tr>
                <td style="padding:10px 0;color:${brand.muted};font-weight:800;border-bottom:1px solid ${brand.border};">Business Email</td>
                <td style="padding:10px 0;color:${brand.blue};font-weight:900;text-align:right;border-bottom:1px solid ${brand.border};">${esc(b.email || '—')}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:${brand.muted};font-weight:800;border-bottom:1px solid ${brand.border};">Role</td>
                <td style="padding:10px 0;color:${brand.purple};font-weight:900;text-align:right;border-bottom:1px solid ${brand.border};">${esc((b.role || 'business').toUpperCase())}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:${brand.muted};font-weight:800;border-bottom:1px solid ${brand.border};">Business ID</td>
                <td style="padding:10px 0;color:${brand.black};font-weight:900;text-align:right;border-bottom:1px solid ${brand.border};">${esc(businessId)}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:${brand.muted};font-weight:800;border-bottom:1px solid ${brand.border};">Official Number</td>
                <td style="padding:10px 0;color:${brand.black};font-weight:900;text-align:right;border-bottom:1px solid ${brand.border};">${esc(b.officialNumber || '—')}</td>
              </tr>
              <tr>
                <td style="padding:10px 0;color:${brand.muted};font-weight:800;">Number Type</td>
                <td style="padding:10px 0;color:${brand.black};font-weight:900;text-align:right;">${esc(b.officialNumberType || 'OTHER')}</td>
              </tr>
            </table>
          </div>

          <!-- Next steps -->
          <div style="border:1px solid rgba(124,58,237,0.18);border-radius:14px;
                      background:linear-gradient(135deg, rgba(124,58,237,0.07) 0%, rgba(37,99,235,0.05) 100%);
                      padding:14px 14px;">
            <div style="font-weight:900;color:${brand.purple};font-size:14px;margin-bottom:6px;">
              ${esc(meta.nextTitle)}
            </div>
            <div style="color:${brand.slate};font-size:13px;line-height:1.6;">
              ${esc(meta.nextBody)}
            </div>
            <div style="margin-top:8px;color:${brand.slate};font-size:12px;line-height:1.6;">
              <b>Tip:</b> ${esc(meta.ctaHint)}
            </div>
          </div>

          ${buttonsHtml}

          <!-- Security -->
          <div style="margin-top:18px;border-radius:12px;background:#FFF7ED;border:1px solid #FED7AA;padding:12px 12px;">
            <div style="color:#7C2D12;font-size:12px;line-height:1.55;font-weight:800;">
              🔒 Security reminder:
              <span style="font-weight:700;">
                If you didn’t create this account, contact support immediately.
              </span>
            </div>
          </div>

          ${fallbackLinksHtml}
        </td>
      </tr>

      <!-- Footer -->
      <tr>
        <td class="px" style="padding:18px 28px;background:${brand.black};text-align:center;">
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

  return { subject, text, html, dashboardUrl, profileUrl, status };
}

async function sendBusinessWelcomeVerified(business, baseUrl) {
  const b = business || {};
  const built = buildBusinessWelcomeVerifiedEmail(b, baseUrl);

  if (!b.email) {
    throw new Error('sendBusinessWelcomeVerified: business.email is missing');
  }

  // ✅ Fail loudly in Render logs if env is missing
  assertMailerEnv();

  try {
    const res = await sendMail({
      to: b.email,
      subject: built.subject,
      text: built.text,
      html: built.html,
      replyTo: process.env.SUPPORT_INBOX || undefined,
    });

    // ✅ Useful Render log (safe)
    console.log('📨 Welcome email sent:', {
      to: b.email,
      status: built.status,
      from: FROM,
      provider: String(process.env.MAIL_PROVIDER || 'sendgrid'),
      hasBaseUrl: !!resolveBaseUrl(baseUrl),
    });

    return { ok: true, provider: String(process.env.MAIL_PROVIDER || 'sendgrid'), res };
  } catch (err) {
    // ✅ make SendGrid errors readable in Render logs
    const details = err?.response?.body || err?.response || err?.message || err;
    console.error('❌ Welcome email failed:', details);
    throw err;
  }
}

module.exports = {
  buildBusinessWelcomeVerifiedEmail,
  sendBusinessWelcomeVerified,
};
