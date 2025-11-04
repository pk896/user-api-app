// routes/wishlist.js
const express = require("express");
const router = express.Router();
const Wishlist = require("../models/Wishlist");
const Product = require("../models/Product");
const requireAnySession = require("../middleware/requireAnySession");

// --- who is acting? (user OR business)
function getActorFilter(req) {
  if (req.session?.user) {
    return { filter: { userId: req.session.user._id, businessId: null }, actorType: "user" };
  }
  if (req.session?.business) {
    return { filter: { userId: null, businessId: req.session.business._id }, actorType: "business" };
  }
  return { filter: null, actorType: null };
}

// --- helper: resolve Product._id from incoming param (handles ObjectId or customId/slug)
async function resolveProductObjectId(param) {
  const str = String(param || "");
  const is24Hex = /^[0-9a-fA-F]{24}$/.test(str);
  if (is24Hex) {
    const p = await Product.findById(str).select("_id");
    if (p) return p._id;
  }
  const p2 = await Product.findOne({ $or: [{ customId: str }, { slug: str }] }).select("_id");
  return p2 ? p2._id : null;
}

// --- ADD to wishlist
router.post("/wishlist/add/:productId", requireAnySession, async (req, res) => {
  try {
    const { filter, actorType } = getActorFilter(req);
    if (!filter) {
      req.flash("error", "Please log in to use the wishlist.");
      return res.redirect("/users/login");
    }

    const incoming = req.params.productId;
    const pid = await resolveProductObjectId(incoming);

    if (!pid) {
      console.warn("[wishlist:add] product not found for:", incoming);
      req.flash("error", "Product not found.");
      return res.redirect("/users/wishlist");
    }

    const result = await Wishlist.updateOne(
      { ...filter, productId: pid },
      { $setOnInsert: { ...filter, productId: pid } },
      { upsert: true }
    );

    console.log(
      `[wishlist:add] actor=${actorType} filter=${JSON.stringify(filter)} upserted=${!!result?.upsertedCount}`
    );

    req.flash("success", "Added to your wishlist.");
    const redirectTo = req.body.redirect || "/users/wishlist";
    return res.redirect(redirectTo);
  } catch (err) {
    console.error("Wishlist add error:", err);
    req.flash("error", "Could not add to wishlist.");
    return res.redirect("/users/wishlist");
  }
});

// --- REMOVE from wishlist
router.post("/wishlist/remove/:productId", requireAnySession, async (req, res) => {
  try {
    const { filter, actorType } = getActorFilter(req);
    if (!filter) {
      req.flash("error", "Please log in to use the wishlist.");
      return res.redirect("/users/login");
    }

    const incoming = req.params.productId;
    const pid = await resolveProductObjectId(incoming);

    if (!pid) {
      console.warn("[wishlist:remove] product not found for:", incoming);
      req.flash("error", "Product not found.");
      return res.redirect("/users/wishlist");
    }

    const del = await Wishlist.deleteOne({ ...filter, productId: pid });
    console.log(
      `[wishlist:remove] actor=${actorType} filter=${JSON.stringify(filter)} deleted=${del?.deletedCount || 0}`
    );

    req.flash("success", "Removed from your wishlist.");
    const redirectTo = req.body.redirect || "/users/wishlist";
    return res.redirect(redirectTo);
  } catch (err) {
    console.error("Wishlist remove error:", err);
    req.flash("error", "Could not remove from wishlist.");
    return res.redirect("/users/wishlist");
  }
});

// --- VIEW wishlist page
router.get("/wishlist", requireAnySession, async (req, res) => {
  try {
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";
    const { filter, actorType } = getActorFilter(req);
    if (!filter) {
      req.flash("error", "Please log in to use the wishlist.");
      return res.redirect("/users/login");
    }

    const items = await Wishlist.find(filter)
      .populate({ path: "productId", model: "Product" })
      .sort({ createdAt: -1 });

    const products = items.map(i => i.productId).filter(Boolean);

    return res.render("users-wishlist", {
      layout: "layout",
      themeCss,
      active: "wishlist",
      products,
      success: req.flash("success"),
      error: req.flash("error"),
      actorType
    });
  } catch (err) {
    console.error("Wishlist page error:", err);
    req.flash("error", "Could not load wishlist.");
    return res.redirect("/sales");
  }
});

// --- OPTIONAL: Add-to-cart from wishlist (session cart)
router.post("/wishlist/:productId/add-to-cart", requireAnySession, async (req, res) => {
  try {
    const incoming = req.params.productId;
    const oid = await resolveProductObjectId(incoming);
    if (!oid) {
      req.flash("error", "Product not found.");
      return res.redirect("/users/wishlist");
    }

    const product = await Product.findById(oid).lean();
    if (!product) {
      req.flash("error", "Product not found.");
      return res.redirect("/users/wishlist");
    }

    const qty = Math.max(1, parseInt(req.body.qty || "1", 10));

    // Session cart structure matches your sample: quantity, customId, imageUrl, etc.
    req.session.cart = req.session.cart || { items: [] };
    const items = req.session.cart.items;

    const idx = items.findIndex(i => String(i.productId) === String(product._id));
    if (idx >= 0) {
      items[idx].quantity = Math.max(1, Number(items[idx].quantity || 1) + qty);
    } else {
      items.push({
        productId: String(product._id),
        customId: product.customId || String(product._id),
        name: product.name || product.title || "Product",
        price: Number(product.price || 0),
        imageUrl: product.imageUrl || (Array.isArray(product.images) ? product.images[0] : null) || "",
        quantity: qty,
      });
    }

    req.flash("success", "Added to cart.");
    return res.redirect("/users/wishlist");
  } catch (err) {
    console.error("Wishlist add-to-cart error:", err);
    req.flash("error", "Could not add to cart.");
    return res.redirect("/users/wishlist");
  }
});

module.exports = router;
