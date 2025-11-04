const nodemailer = require("nodemailer");

const {
  SMTP_HOST = "smtp.gmail.com",
  SMTP_PORT = "587",
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM = `Phakisi Global <${process.env.SMTP_USER || "no-reply@example.com"}>`
} = process.env;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT),
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// ✅ Log mail readiness once at startup
transporter.verify((err, success) => {
  if (err) {
    console.error("[mailer] SMTP verify failed:", err.message || err);
  } else {
    console.log("[mailer] SMTP ready:", success);
  }
});

async function sendMail({ to, subject, html, text }) {
  return transporter.sendMail({ from: SMTP_FROM, to, subject, text: text || "", html: html || "" });
}

module.exports = { sendMail };
