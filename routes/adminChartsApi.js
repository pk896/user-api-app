// user-api-app/routes/adminChartsApi.js
"use strict";

const express = require("express");
const router = express.Router();

const Business = require("../models/Business");

// ✅ Non-business users live in User model (this must exist in your app)
const User = require("../models/User");

/**
 * Build an array of day objects for the last N days (inclusive).
 * Each entry includes start/end of day (local server time).
 */
function buildLastNDays(n = 7) {
  const days = [];
  const now = new Date();

  for (let i = n - 1; i >= 0; i--) {
    const start = new Date(now);
    start.setDate(now.getDate() - i);
    start.setHours(0, 0, 0, 0);

    const end = new Date(start);
    end.setHours(23, 59, 59, 999);

    const label = start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });

    days.push({ label, start, end });
  }

  return days;
}

/**
 * Cumulative totals "as of end of day" for a model with createdAt timestamps.
 * Example: totals for last 7 days => [total up to day1, total up to day2, ...]
 */
async function cumulativeCounts(Model, baseMatch, days) {
  const counts = await Promise.all(
    days.map((d) =>
      Model.countDocuments({
        ...baseMatch,
        createdAt: { $lte: d.end },
      })
    )
  );
  return counts.map((v) => Number(v || 0));
}

/**
 * GET /api/admin/charts/cards
 * Returns: labels + 4 arrays for the 4 mini charts in public/admin-ui/js/main.js
 *
 * card1 = Total App Users (cumulative) = (Total Businesses + Non-business Users)
 * card2 = Sellers (cumulative)   = Businesses where role="seller"
 * card3 = Suppliers (cumulative) = Businesses where role="supplier"
 * card4 = Buyers (cumulative)    = Businesses where role="buyer"
 */
router.get("/cards", async (req, res) => {
  try {
    const days = buildLastNDays(7);
    const labels = days.map((d) => d.label);

    // Businesses (all roles)
    const businessesCumulative = await cumulativeCounts(Business, {}, days);

    // Non-business users (User model)
    const usersCumulative = await cumulativeCounts(User, {}, days);

    // ✅ Total App Users = Businesses + Non-business Users
    const card1 = businessesCumulative.map(
      (b, idx) => Number(b || 0) + Number(usersCumulative[idx] || 0)
    );

    // Business role breakdowns
    const card2 = await cumulativeCounts(Business, { role: "seller" }, days);
    const card3 = await cumulativeCounts(Business, { role: "supplier" }, days);
    const card4 = await cumulativeCounts(Business, { role: "buyer" }, days);

    return res.json({ labels, card1, card2, card3, card4 });
  } catch (err) {
    console.error("❌ GET /api/admin/charts/cards error:", err);
    return res.status(500).json({ error: "Failed to build card charts" });
  }
});

module.exports = router;