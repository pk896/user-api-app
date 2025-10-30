// routes/matches.js
const express = require("express");
const router = express.Router();

const MatchedDemand = require("../models/MatchedDemand");
const Demand = require("../models/Demand");
const Product = require("../models/Product");
const DemandedProduct = require("../models/DemandedProduct"); // ← add this



// ✅ Import concrete middleware files (they must export function declarations)
const requireBusiness = require("../middleware/requireBusiness");
const requireRole = require("../middleware/requireRole");

// -------------------------------------------------
// Request logger
// -------------------------------------------------
router.use((req, _res, next) => {
  console.log("[/matches]", req.method, req.originalUrl);
  next();
});

// Simple health
router.get("/_ping", (_req, res) => res.send("matches: ok"));

// -------------------------------------------------
// Utilities
// -------------------------------------------------
function normStr(s) { return String(s || "").trim().toLowerCase(); }
function safeNum(n, d = 0) { const x = Number(n); return Number.isFinite(x) ? x : d; }

/**
 * Optional: multi-signal scorer (not used in type-only run yet)
 */
function computeMatchScore(demand, product) {
  let score = 0;

  // Type/category exact (case-insensitive)
  if (normStr(demand.productType || demand.type) && normStr(product.type) &&
      normStr(demand.productType || demand.type) === normStr(product.type)) score += 40;

  // Quality
  if (normStr(demand.quality) && normStr(product.quality) &&
      normStr(demand.quality) === normStr(product.quality)) score += 15;

  // Location (very rough)
  const dLoc = normStr(demand.location || [demand.country, demand.province, demand.city, demand.town].filter(Boolean).join(", "));
  const pLoc = normStr(product.location || [product.country, product.province, product.city, product.town].filter(Boolean).join(", "));
  if (dLoc && pLoc) {
    if (dLoc === pLoc) score += 20;
    else if (pLoc.includes(dLoc)) score += 10;
  }

  // Quantity
  const dq = safeNum(demand.quantity);
  const pq = safeNum(product.stock || product.quantityAvailable || 0);
  if (dq > 0 && pq > 0) {
    if (pq >= dq) score += 15;
    else if (pq >= Math.ceil(dq * 0.5)) score += 8;
  }

  // Price
  const target = safeNum(demand.targetPrice, NaN);
  const price = safeNum(product.price, NaN);
  if (Number.isFinite(target) && Number.isFinite(price)) {
    if (price <= target) score += 10;
    else if (price <= target * 1.15) score += 5;
  }

  return Math.max(0, Math.min(100, score));
}

// -------------------------------------------------
// Core: Type-only matching (single handler)
// -------------------------------------------------
async function runMatchingTypeOnly(req, res) {
  try {
    const buyer = req.session.business;
    if (!buyer) {
      req.flash("error", "Please log in as a buyer.");
      return res.redirect("/business/login");
    }

    const demandId = req.params.demandId;
    if (!demandId) {
      req.flash("error", "Missing demand id.");
      return res.redirect("/demands/my-demands");
    }

    // --- Load demand from any of the models we’ve used historically
    let demand = await Demand.findById(demandId).lean();
    if (!demand) {
      demand = await DemandedProduct.findById(demandId).lean(); // fallback
    }
    if (!demand) {
      console.warn("[/matches/run] demand not found by id", demandId);
      req.flash("error", "Demand not found.");
      return res.redirect("/demands/my-demands");
    }

    // --- Robust owner check (support historical fields)
    const bizId = String(buyer._id);
    const candidateOwnerIds = [
      demand.buyerId,
      demand.buyer,
      demand.business,
      demand.owner,
      demand.requesterBusinessId,
      demand.requester && demand.requester.businessId,
      demand.requester && demand.requester.business && demand.requester.business._id
    ].filter(Boolean).map(String);

    const isOwner = candidateOwnerIds.some(id => id === bizId);
    if (!isOwner) {
      console.warn("[/matches/run] owner check failed", {
        demandId: String(demand._id), bizId, candidateOwnerIds
      });
      req.flash("error", "Demand not found (owner check failed).");
      return res.redirect("/demands/my-demands");
    }

    // --- Type-only matching
    const dTypeRaw = String(demand.productType || demand.type || "").trim();
    if (!dTypeRaw) {
      req.flash("error", "This demand has no 'type'. Set a type first to find matches.");
      return res.redirect("/demands/my-demands");
    }

    // Case-insensitive EXACT match on Product.type
    const esc = dTypeRaw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const products = await Product.find({
      type: { $regex: new RegExp("^" + esc + "$", "i") },
    }).limit(1000).lean();

    let created = 0, updated = 0;

    for (const p of products) {
      const supplierId = p.business || p.businessId; // tolerate both
      if (!supplierId) continue;

      const snapshot = {
        demandTitle: demand.title || demand.productName || demand.type || dTypeRaw,
        demandQuantity: demand.quantity,
        demandLocation:
          demand.location ||
          [demand.country, demand.province, demand.city, demand.town].filter(Boolean).join(", "),
        productName: p.name,
        productType: p.type,
        productPrice: p.price,
        productLocation:
          p.location ||
          [p.country, p.province, p.city, p.town].filter(Boolean).join(", "),
      };

      const updateDoc = {
        demandId: demand._id,
        buyerId: buyer._id,
        supplierId,
        productId: p._id,
        score: 100, // strict type-only
        snapshot,
      };

      const resUpsert = await MatchedDemand.updateOne(
        { demandId: demand._id, productId: p._id },
        { $set: updateDoc, $setOnInsert: { status: "pending" } },
        { upsert: true }
      );

      if (resUpsert.upsertedId || resUpsert.upsertedCount > 0) created++;
      else updated++;
    }

    req.flash("success", `Matched by type "${dTypeRaw}" — ${created} new, ${updated} updated.`);
    return res.redirect(`/matches/buyer?demand=${demand._id}`);
  } catch (err) {
    console.error("[matches.run type-only] error:", err);
    req.flash("error", "Failed to run matching.");
    return res.redirect("/demands/my-demands");
  }
}

router.get("/run/:demandId",
  requireBusiness,
  requireRole("buyer"),
  (req, res, next) => {
    console.log("role=", req.session?.business?.role || req.session?.business?.type);
    console.log("session id=", req.session.id);
    return runMatchingTypeOnly(req, res, next);
  }
);

// Mount GET+POST once (no duplicates)
//router.get("/run/:demandId",  requireBusiness, requireRole("buyer"), runMatchingTypeOnly);
router.post("/run/:demandId", requireBusiness, requireRole("buyer"), runMatchingTypeOnly);

// -------------------------------------------------
// Buyer view: see matched products
// -------------------------------------------------
router.get("/buyer", requireBusiness, requireRole("buyer"), async (req, res) => {
  try {
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
    const nonce = res.locals.nonce || "";
    const buyer = req.session.business;

    const demandFilter = req.query.demand ? { demandId: req.query.demand } : {};
    const matches = await MatchedDemand.find({ buyerId: buyer._id, ...demandFilter })
      .sort({ score: -1, createdAt: -1 })
      .populate("demandId")
      .populate("productId")
      .populate("supplierId")
      .lean();

    res.render("matches/matched-products", {
      title: "Matched Products",
      active: "matches-buyer",
      themeCss,
      nonce,
      matches,
      success: req.flash("success"),
      error: req.flash("error"),
      business: buyer,
    });
  } catch (err) {
    console.error("[matches.buyer]", err);
    req.flash("error", "Could not load matched products.");
    return res.redirect("/demands/my-demands");
  }
});

// -------------------------------------------------
// Supplier view: see buyer demands that match your products
// -------------------------------------------------
router.get("/supplier", requireBusiness, requireRole("supplier"), async (req, res) => {
  try {
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
    const nonce = res.locals.nonce || "";
    const supplier = req.session.business;

    const matches = await MatchedDemand.find({ supplierId: supplier._id })
      .sort({ status: 1, score: -1, createdAt: -1 })
      .populate("demandId")
      .populate("productId")
      .populate("buyerId")
      .lean();

    res.render("matches/matched-demands", {
      title: "Matched Demands",
      active: "matches-supplier",
      themeCss,
      nonce,
      matches,
      success: req.flash("success"),
      error: req.flash("error"),
      business: supplier,
    });
  } catch (err) {
    console.error("[matches.supplier]", err);
    req.flash("error", "Could not load matched demands.");
    return res.redirect("/dashboard");
  }
});

// -------------------------------------------------
// Supplier respond (accept/reject + message)
// -------------------------------------------------
router.post("/:matchId/respond", requireBusiness, requireRole("supplier"), async (req, res) => {
  try {
    const supplier = req.session.business;
    const { action, message } = req.body;

    const match = await MatchedDemand.findOne({ _id: req.params.matchId, supplierId: supplier._id });
    if (!match) {
      req.flash("error", "Match not found.");
      return res.redirect("/matches/supplier");
    }

    if (!["accepted", "rejected", "pending"].includes(action)) {
      req.flash("error", "Invalid action.");
      return res.redirect("/matches/supplier");
    }

    match.status = action;
    match.supplierMessage = String(message || "").slice(0, 500);
    await match.save();

    req.flash("success", `Response recorded: ${action.toUpperCase()}.`);
    return res.redirect("/matches/supplier");
  } catch (err) {
    console.error("[matches.respond]", err);
    req.flash("error", "Failed to record response.");
    return res.redirect("/matches/supplier");
  }
});

// -------------------------------------------------
// Buyer summary (JSON) — totals + per-demand
// -------------------------------------------------
router.get("/buyer/summary", requireBusiness, requireRole("buyer"), async (req, res) => {
  try {
    const buyer = req.session.business;
    const since = req.session.buyerMatchesLastSeenAt ? new Date(req.session.buyerMatchesLastSeenAt) : null;

    const statusAgg = await MatchedDemand.aggregate([
      { $match: { buyerId: buyer._id } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]);

    const counters = { total: 0, pending: 0, accepted: 0, rejected: 0 };
    for (const r of statusAgg) {
      counters[r._id] = r.count;
      counters.total += r.count;
    }

    let newSince = 0;
    if (since) {
      newSince = await MatchedDemand.countDocuments({
        buyerId: buyer._id,
        updatedAt: { $gt: since }
      });
    }

    const perDemandAgg = await MatchedDemand.aggregate([
      { $match: { buyerId: buyer._id } },
      { $group: { _id: { demandId: "$demandId", status: "$status" }, count: { $sum: 1 } } }
    ]);

    const perDemandMap = new Map();
    for (const row of perDemandAgg) {
      const did = String(row._id.demandId);
      if (!perDemandMap.has(did)) perDemandMap.set(did, { demandId: did, pending: 0, accepted: 0, rejected: 0, total: 0 });
      const bucket = perDemandMap.get(did);
      bucket[row._id.status] = row.count;
      bucket.total += row.count;
    }

    const demandIds = Array.from(perDemandMap.keys());
    const demands = demandIds.length
      ? await Demand.find({ _id: { $in: demandIds } }, { title: 1, productName: 1, type: 1 }).lean()
      : [];
    const titleById = new Map(demands.map(d => [String(d._id), (d.title || d.productName || d.type || "Demand")]));
    const perDemand = Array.from(perDemandMap.values()).map(x => ({
      ...x,
      title: titleById.get(x.demandId) || "Demand"
    })).sort((a,b) => b.total - a.total);

    res.json({ ok: true, counters: { ...counters, newSince }, perDemand });
  } catch (err) {
    console.error("[matches.buyer/summary]", err);
    res.status(500).json({ ok: false, message: "Failed to load summary" });
  }
});

// -------------------------------------------------
module.exports = router;
