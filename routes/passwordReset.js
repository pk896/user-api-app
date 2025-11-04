// routes/passwordReset.js
const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const { sendMail } = require("../utils/mailer");

const router = express.Router();

// Limiters to avoid abuse
const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many reset requests, please try again later."
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
});

// --- helpers ---
function maskEmail(e) {
  try {
    const [user, domain] = String(e).split("@");
    const mu =
      user.length <= 2
        ? user[0] + "*"
        : user[0] + "*".repeat(user.length - 2) + user[user.length - 1];
    const [dName, dTld = ""] = domain.split(".");
    const md =
      (dName ? dName[0] + "*".repeat(Math.max(dName.length - 1, 1)) : "*") +
      (dTld ? "." + dTld : "");
    return `${mu}@${md}`;
  } catch {
    return "your email";
  }
}

// GET /users/password/forgot
router.get("/forgot", (req, res) => {
  res.render("users-forgot", { title: "Forgot Password" });
});

// POST /users/password/forgot
router.post("/forgot", forgotLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!email) {
      req.flash("error", "Please enter your email.");
      return res.redirect("/users/password/forgot");
    }

    const genericMsg = "If that email exists, we have sent a reset link.";
    const user = await User.findOne({ email });

    // Always generic to prevent enumeration
    if (!user) {
      req.flash("success", genericMsg);
      // still redirect to sent page for a polished UX
      req.session.lastResetEmailMasked = maskEmail(email);
      return res.redirect("/users/password/forgot/sent");
    }

    // Create token + hash
    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Update without running validators (avoids passwordHash required)
    await User.updateOne(
      { _id: user._id },
      { $set: { passwordResetTokenHash: tokenHash, passwordResetExpiresAt: expiresAt } },
      { runValidators: false }
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const resetUrl = `${baseUrl}/users/password/reset/${rawToken}`;

    // Always log the link in dev for easy testing
    if (process.env.NODE_ENV !== "production") {
      console.info(`[DEV ONLY] Password reset link: ${resetUrl}`);
    }

    // Attempt email, but do NOT block UX if it fails
    try {
      const subject = "Reset your Phakisi Global password";
      const html = `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
          <h2>Reset your password</h2>
          <p>We received a request to reset your password. Click the button below:</p>
          <p>
            <a href="${resetUrl}" style="background:#2563eb;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;display:inline-block">
              Reset Password
            </a>
          </p>
          <p>Or copy and paste this link:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p style="color:#666">This link will expire in 1 hour. If you didn’t request this, you can ignore this email.</p>
        </div>`;
      const text = `Reset your password: ${resetUrl} (expires in 1 hour)`;
      await sendMail({ to: user.email, subject, html, text });
    } catch (mailErr) {
      console.error("[password/forgot] Email send failed:", mailErr?.message || mailErr);
      if (process.env.NODE_ENV !== "production") {
        console.warn(`[DEV ONLY] Password reset link: ${resetUrl}`);
      }
    }

    // Success UX: store masked email and redirect to confirmation page
    req.flash("success", genericMsg);
    req.session.lastResetEmailMasked = maskEmail(email);
    return res.redirect("/users/password/forgot/sent");
  } catch (err) {
    console.error("Forgot error:", err);
    if (process.env.NODE_ENV !== "production") {
      req.flash("error", `Dev hint: ${err.message}`);
    } else {
      req.flash("error", "Something went wrong. Please try again.");
    }
    return res.redirect("/users/password/forgot");
  }
});

// GET /users/password/reset/:token
router.get("/reset/:token", resetLimiter, async (req, res) => {
  try {
    const rawToken = String(req.params.token || "");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() }
    });

    if (!user) {
      req.flash("error", "Reset link is invalid or expired.");
      return res.redirect("/users/password/forgot");
    }

    res.render("users-reset", { title: "Choose a new password", token: rawToken });
  } catch (err) {
    console.error("Reset GET error:", err);
    req.flash("error", "Something went wrong.");
    res.redirect("/users/password/forgot");
  }
});

// POST /users/password/reset/:token
router.post("/reset/:token", resetLimiter, async (req, res) => {
  try {
    const rawToken = String(req.params.token || "");
    const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

    const user = await User.findOne({
      passwordResetTokenHash: tokenHash,
      passwordResetExpiresAt: { $gt: new Date() }
    });

    if (!user) {
      req.flash("error", "Reset link is invalid or expired.");
      return res.redirect("/users/password/forgot");
    }

    const { password, confirm } = req.body;
    if (!password || password.length < 8) {
      req.flash("error", "Password must be at least 8 characters.");
      return res.redirect(`/users/password/reset/${rawToken}`);
    }
    if (password !== confirm) {
      req.flash("error", "Passwords do not match.");
      return res.redirect(`/users/password/reset/${rawToken}`);
    }

    // setPassword updates passwordHash + passwordChangedAt and clears reset fields
    await user.setPassword(password);
    await user.save();

    req.flash("success", "Your password has been updated. Please sign in.");
    res.redirect("/users/signin");
  } catch (err) {
    console.error("Reset POST error:", err);
    req.flash("error", "Could not reset password. Please try again.");
    res.redirect("/users/password/forgot");
  }
});

// Confirmation page
router.get("/forgot/sent", (req, res) => {
  const masked = req.session.lastResetEmailMasked || null;
  req.session.lastResetEmailMasked = null; // clear after one view
  res.render("users-forgot-sent", { title: "Check your email", maskedEmail: masked });
});

module.exports = router;
