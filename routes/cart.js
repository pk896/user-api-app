// routes/cart.js
const express = require("express");
const router = express.Router();
const Product = require("../models/Product");

/* ----------------------------------------------------------
 * 🧩 Middleware: Ensure session cart always exists
 * -------------------------------------------------------- */
router.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = { items: [] }; // Structure: { items: [{ productId, quantity }] }
  }
  next();
});

/* ----------------------------------------------------------
 * 🔍 Helper: Find item index in the cart
 * -------------------------------------------------------- */
function findItemIndex(cart, productId) {
  return cart.items.findIndex((item) => item.productId.toString() === productId.toString());
}

/* ----------------------------------------------------------
 * 🛒 GET /api/cart
 * Fetch detailed cart with product info
 * -------------------------------------------------------- */
router.get("/", async (req, res) => {
  try {
    const cart = req.session.cart;

    // Populate each cart item with product details
    const detailedItems = await Promise.all(
      cart.items.map(async (item) => {
        const product = await Product.findById(item.productId).lean();
        if (!product) return null;
        return {
          productId: item.productId,
          quantity: item.quantity,
          name: product.name,
          price: product.price,
          imageUrl: product.imageUrl,
        };
      })
    );

    const items = detailedItems.filter(Boolean);
    const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);
    const totalCount = items.reduce((sum, i) => sum + i.quantity, 0);

    res.json({ success: true, items, total, totalCount });
  } catch (err) {
    console.error("❌ Cart fetch error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch cart" });
  }
});

/* ----------------------------------------------------------
 * ➕ POST /api/cart/add
 * Add item to cart or increase its quantity
 * -------------------------------------------------------- */
router.post("/add", async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body;
    if (!productId) return res.status(400).json({ success: false, error: "Missing productId" });

    const product = await Product.findById(productId);
    if (!product) return res.status(404).json({ success: false, error: "Product not found" });

    const cart = req.session.cart;
    const index = findItemIndex(cart, productId);

    if (index >= 0) {
      cart.items[index].quantity += Number(quantity);
    } else {
      cart.items.push({ productId, quantity: Number(quantity) });
    }

    const totalCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);

    res.json({ success: true, cart, totalCount });
  } catch (err) {
    console.error("❌ Add to cart error:", err);
    res.status(500).json({ success: false, error: "Failed to add item" });
  }
});

/* ----------------------------------------------------------
 * ⬆️ POST /api/cart/increase
 * Increase item quantity by 1
 * -------------------------------------------------------- */
router.post("/increase", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;
    const index = findItemIndex(cart, productId);

    if (index >= 0) cart.items[index].quantity += 1;

    const totalCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
    res.json({ success: true, cart, totalCount });
  } catch (err) {
    console.error("❌ Increase error:", err);
    res.status(500).json({ success: false, error: "Failed to increase item" });
  }
});

/* ----------------------------------------------------------
 * ⬇️ POST /api/cart/decrease
 * Decrease item quantity or remove if zero
 * -------------------------------------------------------- */
router.post("/decrease", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;
    const index = findItemIndex(cart, productId);

    if (index >= 0) {
      cart.items[index].quantity -= 1;
      if (cart.items[index].quantity <= 0) {
        cart.items.splice(index, 1);
      }
    }

    const totalCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
    res.json({ success: true, cart, totalCount });
  } catch (err) {
    console.error("❌ Decrease error:", err);
    res.status(500).json({ success: false, error: "Failed to decrease item" });
  }
});

/* ----------------------------------------------------------
 * ❌ POST /api/cart/remove
 * Remove product entirely from cart
 * -------------------------------------------------------- */
router.post("/remove", (req, res) => {
  try {
    const { productId } = req.body;
    const cart = req.session.cart;

    cart.items = cart.items.filter((item) => item.productId.toString() !== productId.toString());

    const totalCount = cart.items.reduce((sum, i) => sum + i.quantity, 0);
    res.json({ success: true, cart, totalCount });
  } catch (err) {
    console.error("❌ Remove error:", err);
    res.status(500).json({ success: false, error: "Failed to remove item" });
  }
});

/* ----------------------------------------------------------
 * 🧹 POST /api/cart/clear
 * Empty entire cart
 * -------------------------------------------------------- */
router.post("/clear", (req, res) => {
  try {
    req.session.cart = { items: [] };
    res.json({ success: true, cart: req.session.cart, totalCount: 0 });
  } catch (err) {
    console.error("❌ Clear cart error:", err);
    res.status(500).json({ success: false, error: "Failed to clear cart" });
  }
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

