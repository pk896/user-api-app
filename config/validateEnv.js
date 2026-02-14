// config/validateEnv.js
'use strict';
require("dotenv").config();

const REQUIRED_VARS = [
  "NODE_ENV",
  "PORT",
  "MONGO_URI",
  "SESSION_SECRET",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
  "AWS_BUCKET_NAME",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "PAYOUTS_CRON_SECRET",
  "ADMIN_PASS",
  "ADMIN_USER",
  "MAIL_PROVIDER",
  "SENDGRID_API_KEY",
  "SMTP_FROM",
  "PUBLIC_BASE_URL",
  "SHIPPING_PREF",
  "SUPPORT_INBOX",
  "BRAND_NAME",
  "VAT_RATE",
  "BASE_CURRENCY",
  "PLATFORM_FEE_BPS"
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    const list = missing.map((v) => ` - ${v}`).join("\n");
    throw new Error(`Missing environment variables:\n${list}`);
  }

  const port = Number(process.env.PORT);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
  }

  const env = process.env.NODE_ENV;
  if (!["production", "development", "test"].includes(env)) {
    throw new Error("NODE_ENV must be one of: production, development, test");
  }

  console.log(`✅ Environment validated for ${env.toUpperCase()} mode.`);
  return true;
}

module.exports = validateEnv;
