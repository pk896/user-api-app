// routes/wishlist.js
const express = require("express");
const router = express.Router();

const Wishlist = require("../models/Wishlist");
const Product  = require("../models/Product");

// ---------- helpers ----------
function themeCssFrom(req){
  return (req.session?.theme === "dark") ? "/css/dark.css" : "/css/light.css";
}
function resNonce(req){ return (req?.res?.locals?.nonce) || ""; }

// Accept either req.session.user or req.session.business
function getPrincipal(req){
  if (req.session?.user?._id)     return { type: "user",     id: req.session.user._id };
  if (req.session?.business?._id) return { type: "business", id: req.session.business._id };
  return null;
}

// Gate: require any principal (user or business)
function requireAnyAccount(req, res, next){
  const p = getPrincipal(req);
  if (!p) {
    req.flash?.("error", "Please sign in to use your wishlist.");
    // Prefer user login page; adjust if you want a combined gate
    return res.redirect("/users/login");
  }
  req.principal = p;
  next();
}

// Fetch all wishlist items for current owner
async function fetchWishlistWithProducts(owner){
  const rows = await Wishlist.find({ ownerType: owner.type, ownerId: owner.id }).lean();
  const ids  = rows.map(r => r.productId).filter(Boolean);
  const products = ids.length
    ? await Product.find({ _id: { $in: ids } }).lean()
    : [];
  // map by id
  const pMap = new Map(products.map(p => [String(p._id), p]));
  // hydrate items
  return rows.map(r => ({
    _id: r._id,
    productId: r.productId,
    addedAt: r.createdAt,
    product: pMap.get(String(r.productId)) || null
  }));
}

// ---------- Page: /users/wishlist ----------
router.get("/wishlist", requireAnyAccount, async (req, res) => {
  try {
    const items = await fetchWishlistWithProducts(req.principal);
    return res.render("users-wishlist", {
      title: "My Wishlist",
      themeCss: themeCssFrom(req),
      nonce: resNonce(req),
      items,
      success: req.flash?.("success") || [],
      error:   req.flash?.("error")   || []
    });
  } catch (err) {
    console.error("wishlist page error:", err);
    req.flash?.("error", "Could not load wishlist.");
    return res.redirect("/sales");
  }
});

// ---------- JSON: list ----------
router.get("/wishlist/api", requireAnyAccount, async (req, res) => {
  try {
    const items = await fetchWishlistWithProducts(req.principal);
    res.json({ ok: true, items });
  } catch (err) {
    console.error("wishlist api error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ---------- JSON: count (for navbar badge if you need it) ----------
router.get("/wishlist/api/count", requireAnyAccount, async (req, res) => {
  try {
    const count = await Wishlist.countDocuments({ ownerType: req.principal.type, ownerId: req.principal.id });
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ---------- Add (idempotent) ----------
router.post("/wishlist/add/:productId", requireAnyAccount, async (req, res) => {
  try {
    const productId = String(req.params.productId || "").trim();
    if (!productId) {
      req.flash?.("error", "Missing product id.");
      return res.redirect("/users/wishlist");
    }

    await Wishlist.updateOne(
      { ownerType: req.principal.type, ownerId: req.principal.id, productId },
      { $setOnInsert: { ownerType: req.principal.type, ownerId: req.principal.id, productId } },
      { upsert: true }
    );

    req.flash?.("success", "Added to wishlist.");
    res.redirect("/users/wishlist");
  } catch (err) {
    console.error("wishlist add error:", err);
    req.flash?.("error", "Could not add to wishlist.");
    res.redirect("/users/wishlist");
  }
});

// ---------- Remove ----------
router.post("/wishlist/remove/:productId", requireAnyAccount, async (req, res) => {
  try {
    const productId = String(req.params.productId || "").trim();
    if (!productId) {
      req.flash?.("error", "Missing product id.");
      return res.redirect("/users/wishlist");
    }

    await Wishlist.deleteOne({ ownerType: req.principal.type, ownerId: req.principal.id, productId });
    req.flash?.("success", "Removed from wishlist.");
    res.redirect("/users/wishlist");
  } catch (err) {
    console.error("wishlist remove error:", err);
    req.flash?.("error", "Could not remove from wishlist.");
    res.redirect("/users/wishlist");
  }
});

// ---------- JSON: toggle ----------
router.post("/wishlist/api/toggle", requireAnyAccount, express.json(), async (req, res) => {
  try {
    const productId = String(req.body?.productId || "").trim();
    if (!productId) return res.status(400).json({ ok: false, message: "Missing productId" });

    const query = { ownerType: req.principal.type, ownerId: req.principal.id, productId };
    const found = await Wishlist.findOne(query).lean();

    let wished;
    if (found) {
      await Wishlist.deleteOne(query);
      wished = false;
    } else {
      await Wishlist.create(query);
      wished = true;
    }

    const count = await Wishlist.countDocuments({ ownerType: req.principal.type, ownerId: req.principal.id });
    res.json({ ok: true, wished, count });
  } catch (err) {
    console.error("wishlist toggle error:", err);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
