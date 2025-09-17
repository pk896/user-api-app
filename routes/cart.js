// routes/cart.js
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
























// routes/cart.js
/*const express = require("express");
const router = express.Router();
const Product = require("../models/Product"); // ✅ make sure this exists

// Middleware: ensure cart exists in session
router.use((req, res, next) => {
  if (!req.session.cart) {
    req.session.cart = { items: [] }; // items = [{ productId, quantity }]
  }
  next();
});

/**
 * Helper: find item index in cart
 */
/*function findItemIndex(cart, productId) {
  return cart.items.findIndex((item) => item.productId === productId);
}

/**
 * GET /api/cart
 * Return cart with populated product details
 */
/*router.get("/", async (req, res) => {
  try {
    const cart = req.session.cart;

    // Fetch product details from DB
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

    res.json({ items: detailedItems.filter(Boolean) });
  } catch (err) {
    console.error("Cart fetch error:", err);
    res.status(500).json({ error: "Failed to fetch cart" });
  }
});

/**
 * POST /api/cart/add
 * Add item to cart (or increase quantity)
 */
/*router.post("/add", (req, res) => {
  const { productId, quantity = 1 } = req.body;
  if (!productId) return res.status(400).json({ error: "Missing productId" });

  const cart = req.session.cart;
  const index = findItemIndex(cart, productId);

  if (index >= 0) {
    cart.items[index].quantity += quantity;
  } else {
    cart.items.push({ productId, quantity });
  }

  res.json(cart);
});

/**
 * POST /api/cart/increase
 * Increase quantity of a product
 */
/*router.post("/increase", (req, res) => {
  const { productId } = req.body;
  const cart = req.session.cart;

  const index = findItemIndex(cart, productId);
  if (index >= 0) {
    cart.items[index].quantity += 1;
  }

  res.json(cart);
});

/**
 * POST /api/cart/decrease
 * Decrease quantity of a product
 */
/*router.post("/decrease", (req, res) => {
  const { productId } = req.body;
  const cart = req.session.cart;

  const index = findItemIndex(cart, productId);
  if (index >= 0) {
    cart.items[index].quantity -= 1;
    if (cart.items[index].quantity <= 0) {
      cart.items.splice(index, 1); // remove if 0
    }
  }

  res.json(cart);
});

/**
 * POST /api/cart/remove
 * Remove product from cart
 */
/*router.post("/remove", (req, res) => {
  const { productId } = req.body;
  const cart = req.session.cart;

  cart.items = cart.items.filter((item) => item.productId !== productId);

  res.json(cart);
});

/**
 * POST /api/cart/clear
 * Empty the cart
 */
/*router.post("/clear", (req, res) => {
  req.session.cart = { items: [] };
  res.json(req.session.cart,);
});

module.exports = router;
*/