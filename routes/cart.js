// routes/cart.js
const express = require("express");
const Product = require("../models/Product");

const router = express.Router();

/* -----------------------------
 * Helpers
 * --------------------------- */
function ensureCart(req) {
  if (!req.session.cart) {
    req.session.cart = { items: [] };
  }
  return req.session.cart;
}

async function findProductByPid(pid) {
  if (!pid) return null;
  // Try customId first (your shop pages use customId)
  let p = await Product.findOne({ customId: pid }).lean();
  if (p) return p;
  // Fallback: treat as Mongo _id
  try {
    p = await Product.findById(pid).lean();
  } catch {
    // ignore invalid ObjectId
  }
  return p || null;
}

/* -----------------------------
 * GET /api/cart
 * -> { items: [ { productId, name, price, imageUrl, quantity } ] }
 * --------------------------- */
router.get("/", (req, res) => {
  const cart = ensureCart(req);
  return res.json({
    items: cart.items || [],
  });
});

/* -----------------------------
 * GET /api/cart/items
 * -> [ { productId, name, price, imageUrl, quantity } ]
 * --------------------------- */
router.get("/items", (req, res) => {
  const cart = ensureCart(req);
  return res.json(cart.items || []);
});

/* -----------------------------
 * GET /api/cart/count
 * -> { count: number }
 * --------------------------- */
router.get("/count", (req, res) => {
  const cart = ensureCart(req);
  const count = (cart.items || []).reduce((n, it) => n + Number(it.quantity || 1), 0);
  return res.json({ count });
});

/* -----------------------------
 * GET /api/cart/add?pid=<customId or _id>&qty=1[&json=1][&back=/sales]
 * Adds one (or qty) to the cart
 * --------------------------- */
router.get("/add", async (req, res) => {
  try {
    const pid = (req.query.pid || "").trim();
    const qty = Math.max(1, Number(req.query.qty || 1));

    const product = await findProductByPid(pid);
    if (!product) {
      // If it's an HTML nav, redirect back with a flash; else JSON error.
      const accept = (req.get("accept") || "").toLowerCase();
      const wantsJson = req.query.json === "1" || accept.includes("application/json");
      if (wantsJson) {
        return res.status(404).json({ success: false, message: "Product not found." });
      }
      if (typeof req.flash === "function") req.flash("error", "Product not found.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }

    // basic stock check (optional)
    if (typeof product.stock === "number" && product.stock <= 0) {
      const accept = (req.get("accept") || "").toLowerCase();
      const wantsJson = req.query.json === "1" || accept.includes("application/json");
      if (wantsJson) {
        return res.status(400).json({ success: false, message: "Out of stock." });
      }
      if (typeof req.flash === "function") req.flash("error", "Out of stock.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }

    const cart = ensureCart(req);
    const id = String(product._id);

    // If item exists, increase; else push new
    const existing = cart.items.find((it) => String(it.productId) === id);
    if (existing) {
      existing.quantity = Number(existing.quantity || 1) + qty;
    } else {
      cart.items.push({
        productId: id,
        customId: product.customId,
        name: product.name,
        price: Number(product.price || 0),
        imageUrl: product.imageUrl,
        quantity: qty,
      });
    }

    // Persist session
    req.session.cart = cart;

    // Decide response mode (JSON vs redirect)
    const accept = (req.get("accept") || "").toLowerCase();
    const wantsJson = req.query.json === "1" || accept.includes("application/json");

    if (wantsJson) {
      return res.json({
        success: true,
        message: "Added to cart.",
        cart: { items: cart.items },
      });
    } else {
      if (typeof req.flash === "function") req.flash("success", "Added to cart.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }
  } catch (err) {
    console.error("❌ /api/cart/add error:", err);
    const accept = (req.get("accept") || "").toLowerCase();
    const wantsJson = req.query.json === "1" || accept.includes("application/json");
    if (wantsJson) {
      return res.status(500).json({ success: false, message: "Failed to add to cart." });
    }
    if (typeof req.flash === "function") req.flash("error", "Failed to add to cart.");
    const back = req.query.back || req.get("referer") || "/sales";
    return res.redirect(back);
  }
});

/* -----------------------------
 * (Optional) quantity updates
 * --------------------------- */
router.post("/increase", express.json(), (req, res) => {
  const { productId } = req.body || {};
  const cart = ensureCart(req);
  const it = cart.items.find((i) => String(i.productId) === String(productId));
  if (!it) return res.status(404).json({ success: false, message: "Item not found" });
  it.quantity = Number(it.quantity || 1) + 1;
  req.session.cart = cart;
  res.json({ success: true, items: cart.items });
});

router.post("/decrease", express.json(), (req, res) => {
  const { productId } = req.body || {};
  const cart = ensureCart(req);
  const it = cart.items.find((i) => String(i.productId) === String(productId));
  if (!it) return res.status(404).json({ success: false, message: "Item not found" });
  it.quantity = Math.max(1, Number(it.quantity || 1) - 1);
  req.session.cart = cart;
  res.json({ success: true, items: cart.items });
});

router.post("/remove", express.json(), (req, res) => {
  const { productId } = req.body || {};
  const cart = ensureCart(req);
  cart.items = (cart.items || []).filter((i) => String(i.productId) !== String(productId));
  req.session.cart = cart;
  res.json({ success: true, items: cart.items });
});

module.exports = router;
