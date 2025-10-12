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
 * GET /api/cart/add?pid=<customId or _id>&qty=1
 * Adds one (or qty) to the cart
 * --------------------------- */
router.get("/add", async (req, res) => {
  try {
    const pid = (req.query.pid || "").trim();
    const qty = Math.max(1, Number(req.query.qty || 1));

    const product = await findProductByPid(pid);
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // basic stock check (optional)
    if (typeof product.stock === "number" && product.stock <= 0) {
      return res.status(400).json({ success: false, message: "Out of stock." });
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

    return res.json({
      success: true,
      message: "Added to cart.",
      cart: { items: cart.items },
    });
  } catch (err) {
    console.error("❌ /api/cart/add error:", err);
    return res.status(500).json({ success: false, message: "Failed to add to cart." });
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

















/*// routes/cart.js
const express = require("express");
const router = express.Router();
const Product = require("../models/Product");

// -----------------------------
// Middleware: Ensure cart exists in session
// -----------------------------
router.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = { items: [] }; // { items: [{ productId, quantity }] }
  }
  next();
});

// -----------------------------
// Helper: find item index in cart
// -----------------------------
function findItemIndex(cart, productId) {
  return cart.items.findIndex((item) => item.productId.toString() === productId.toString());
}

// -----------------------------
// GET /api/cart
// Return cart with populated product details
// -----------------------------
router.get("/", async (req, res) => {
  try {
    const cart = req.session.cart;

    const detailedItems = await Promise.all(
      cart.items.map(async (item) => {
        const product = await Product.findById(item.productId).lean();
        if (!product) return null;
        return {
          productId: item.productId,
          quantity: item.quantity,
          name: product.name,
          price: product.price,
          image: product.image,
        };
      })
    );

    const items = detailedItems.filter(Boolean);
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

    res.json({ items, total });
  } catch (err) {
    console.error("❌ Cart fetch error:", err);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

// -----------------------------
// POST /api/cart/add
// Add item to cart (or increase quantity)
// -----------------------------
router.post("/add", (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body;
    if (!productId) return res.status(400).json({ error: "Missing productId" });

    const cart = req.session.cart;
    const index = findItemIndex(cart, productId);

    if (index >= 0) {
      cart.items[index].quantity += Number(quantity);
    } else {
      cart.items.push({ productId, quantity: Number(quantity) });
    }

    res.json({ success: true, cart });
  } catch (err) {
    console.error("❌ Add to cart error:", err);
    res.status(500).json({ error: "Failed to add item" });
  }
});

// -----------------------------
// POST /api/cart/increase
// -----------------------------
router.post("/increase", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;

    const index = findItemIndex(cart, productId);
    if (index >= 0) {
      cart.items[index].quantity += 1;
    }

    res.json({ success: true, cart });
  } catch (err) {
    console.error("❌ Increase error:", err);
    res.status(500).json({ error: "Failed to increase item" });
  }
});

// -----------------------------
// POST /api/cart/decrease
// -----------------------------
router.post("/decrease", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;

    const index = findItemIndex(cart, productId);
    if (index >= 0) {
      cart.items[index].quantity -= 1;
      if (cart.items[index].quantity <= 0) {
        cart.items.splice(index, 1); // remove if 0
      }
    }

    res.json({ success: true, cart });
  } catch (err) {
    console.error("❌ Decrease error:", err);
    res.status(500).json({ error: "Failed to decrease item" });
  }
});

// -----------------------------
// POST /api/cart/remove
// -----------------------------
router.post("/remove", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;

    cart.items = cart.items.filter((item) => item.productId.toString() !== productId.toString());

    res.json({ success: true, cart });
  } catch (err) {
    console.error("❌ Remove error:", err);
    res.status(500).json({ error: "Failed to remove item" });
  }
});

// -----------------------------
// POST /api/cart/clear
// -----------------------------
router.post("/clear", (req, res) => {
  try {
    req.session.cart = { items: [] };
    res.json({ success: true, cart: req.session.cart });
  } catch (err) {
    console.error("❌ Clear cart error:", err);
    res.status(500).json({ error: "Failed to clear cart" });
  }
});

module.exports = router;
*/

