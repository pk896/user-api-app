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
  // Try customId first (your shop pages often use customId)
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

function normalizeCartItem(p, qty) {
  return {
    // Use productId as the canonical id for the session cart
    productId: String(p._id),
    customId: p.customId,
    name: p.name,
    price: Number(p.price || 0),
    imageUrl: p.imageUrl || p.image || "",
    quantity: Math.max(1, Number(qty || 1)),
  };
}

function findIndexById(items, id) {
  return (items || []).findIndex((it) => String(it.productId) === String(id));
}

/* -----------------------------
 * GET /api/cart
 * -> { items: [ { productId, name, price, imageUrl, quantity } ] }
 * --------------------------- */
router.get("/", (req, res) => {
  const cart = ensureCart(req);
  return res.json({ items: cart.items || [] });
});

/* -----------------------------
 * GET /api/cart/items  (legacy)
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
  const count = (cart.items || []).reduce(
    (n, it) => n + Number(it.quantity || 1),
    0
  );
  return res.json({ count });
});

/* -----------------------------
 * GET /api/cart/add?pid=<customId or _id>&qty=1[&json=1][&back=/sales]
 * Adds one (or qty) to the cart (kept for compatibility)
 * --------------------------- */
router.get("/add", async (req, res) => {
  try {
    const pid = (req.query.pid || "").trim();
    const qty = Math.max(1, Number(req.query.qty || 1));
    const product = await findProductByPid(pid);

    const accept = (req.get("accept") || "").toLowerCase();
    const wantsJson =
      req.query.json === "1" || accept.includes("application/json");

    if (!product) {
      if (wantsJson) {
        return res
          .status(404)
          .json({ success: false, message: "Product not found." });
      }
      if (typeof req.flash === "function")
        req.flash("error", "Product not found.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }

    // Optional stock check
    if (typeof product.stock === "number" && product.stock <= 0) {
      if (wantsJson) {
        return res
          .status(400)
          .json({ success: false, message: "Out of stock." });
      }
      if (typeof req.flash === "function") req.flash("error", "Out of stock.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }

    const cart = ensureCart(req);
    const id = String(product._id);
    const idx = findIndexById(cart.items, id);

    if (idx >= 0) {
      cart.items[idx].quantity = Number(cart.items[idx].quantity || 1) + qty;
    } else {
      cart.items.push(normalizeCartItem(product, qty));
    }

    req.session.cart = cart;

    if (wantsJson) {
      return res.json({
        success: true,
        message: "Added to cart.",
        cart: { items: cart.items },
      });
    } else {
      if (typeof req.flash === "function")
        req.flash("success", "Added to cart.");
      const back = req.query.back || req.get("referer") || "/sales";
      return res.redirect(back);
    }
  } catch (err) {
    console.error("❌ /api/cart/add error:", err);
    const accept = (req.get("accept") || "").toLowerCase();
    const wantsJson =
      req.query.json === "1" || accept.includes("application/json");
    if (wantsJson) {
      return res
        .status(500)
        .json({ success: false, message: "Failed to add to cart." });
    }
    if (typeof req.flash === "function")
      req.flash("error", "Failed to add to cart.");
    const back = req.query.back || req.get("referer") || "/sales";
    return res.redirect(back);
  }
});

/* =========================================================
 * Endpoints used by checkout.ejs
 * ======================================================= */

/* -----------------------------
 * PATCH /api/cart/item/:id
 * body: { quantity }
 * -> { items: [...] }
 * --------------------------- */
router.patch("/item/:id", express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    let { quantity } = req.body || {};
    quantity = Number(quantity);
    if (!Number.isFinite(quantity)) {
      return res
        .status(400)
        .json({ message: "Quantity must be a number.", items: ensureCart(req).items });
    }

    // If quantity <= 0, treat as remove (or clamp to 1; here we remove)
    if (quantity <= 0) {
      const cart = ensureCart(req);
      cart.items = (cart.items || []).filter(
        (i) => String(i.productId) !== String(id)
      );
      req.session.cart = cart;
      return res.json({ items: cart.items });
    }

    const cart = ensureCart(req);
    const idx = findIndexById(cart.items, id);

    if (idx < 0) {
      // If the item isn't present, try to seed it from DB (nice UX)
      const product = await findProductByPid(id);
      if (!product) {
        return res.status(404).json({ message: "Item not found.", items: cart.items });
      }
      cart.items.push(normalizeCartItem(product, quantity));
    } else {
      cart.items[idx].quantity = Math.max(1, Math.floor(quantity));
    }

    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error("❌ PATCH /api/cart/item/:id error:", err);
    return res
      .status(500)
      .json({ message: "Failed to update quantity.", items: ensureCart(req).items });
  }
});

/* -----------------------------
 * DELETE /api/cart/item/:id
 * -> { items: [...] }
 * --------------------------- */
router.delete("/item/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const cart = ensureCart(req);
    cart.items = (cart.items || []).filter(
      (i) => String(i.productId) !== String(id)
    );
    req.session.cart = cart;
    return res.json({ items: cart.items });
  } catch (err) {
    console.error("❌ DELETE /api/cart/item/:id error:", err);
    return res
      .status(500)
      .json({ message: "Failed to remove item.", items: ensureCart(req).items });
  }
});

/* -----------------------------
 * POST /api/cart/clear
 * -> { items: [] }
 * --------------------------- */
router.post("/clear", (req, res) => {
  req.session.cart = { items: [] };
  return res.json({ items: [] });
});

module.exports = router;
