// config/validateEnv.js
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
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_CALLBACK_URL",
  "ORDERS_ADMIN_PASS"
];

function validateEnv() {
  const missing = REQUIRED_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("❌ Missing environment variables:");
    missing.forEach((v) => console.error(" -", v));
    process.exit(1);
  }

  // 🔒 Basic validation
  const port = Number(process.env.PORT);
  if (isNaN(port) || port <= 0) {
    console.error("❌ Invalid PORT value:", process.env.PORT);
    process.exit(1);
  }

  const env = process.env.NODE_ENV;
  if (!["production", "development", "test"].includes(env)) {
    console.error("❌ NODE_ENV must be one of: production, development, test");
    process.exit(1);
  }

  console.log(`✅ Environment validated for ${env.toUpperCase()} mode.`);
}

module.exports = validateEnv;
