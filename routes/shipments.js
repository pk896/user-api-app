const express = require("express");
const router = express.Router();
const Shipment = require("../models/Shipment");
const Product = require("../models/Product");
const requireBusiness = require("../middleware/requireBusiness");

/* ===========================================================
 * 📋 GET: All Shipments (Supplier / Seller)
 * =========================================================== */
router.get("/", requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    const shipments = await Shipment.find({ business: business._id })
      .populate("product", "name price")
      .sort({ createdAt: -1 })
      .lean();

    res.render("shipments/all-shipments", {
      title: "Manage Shipments",
      business,
      shipments,
      themeCss,
      success: req.flash("success"),
      error: req.flash("error"),
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error("❌ Error loading shipments:", err);
    req.flash("error", "Failed to load shipments.");
    res.redirect("/business/dashboard");
  }
});

/* ===========================================================
 * ➕ GET: Add Shipment Page
 * =========================================================== */
router.get("/add", requireBusiness, async (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

  const products = await Product.find({ business: req.session.business._id })
    .select("name _id")
    .lean();

  res.render("shipments/add-shipment", {
    title: "Add Shipment",
    business: req.session.business,
    products,
    themeCss,
    success: req.flash("success"),
    error: req.flash("error"),
  });
});

/* ===========================================================
 * ➕ POST: Create Shipment
 * =========================================================== */
router.post("/add", requireBusiness, async (req, res) => {
  try {
    const { orderId, productId, buyerName, buyerEmail, address } = req.body;
    await Shipment.create({
      business: req.session.business._id,
      orderId,
      product: productId,
      buyerName,
      buyerEmail,
      address,
    });
    req.flash("success", "✅ Shipment created successfully!");
    res.redirect("/shipments");
  } catch (err) {
    console.error("❌ Error creating shipment:", err);
    req.flash("error", "Failed to create shipment.");
    res.redirect("/shipments/add");
  }
});

/* ===========================================================
 * 🔎 GET: Track Shipment Page (Buyer)
 * =========================================================== */
router.get("/track", async (req, res) => {
  const theme = req.session.theme || "light";
  const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

  res.render("shipments/track-shipment", {
    title: "Track Shipment",
    themeCss,
    business: req.session.business,
    shipment: null,
    error: req.flash("error"),
    success: req.flash("success"),
  });
});

/* ===========================================================
 * 🔎 POST: Search Shipment by Order ID or Tracking Number
 * =========================================================== */
router.post("/track", async (req, res) => {
  try {
    const { query } = req.body;
    const theme = req.session.theme || "light";
    const themeCss = theme === "dark" ? "/css/dark.css" : "/css/light.css";

    const shipment = await Shipment.findOne({
      $or: [{ orderId: query.trim() }, { trackingNumber: query.trim() }],
    })
      .populate("product", "name price")
      .populate("business", "name email")
      .lean();

    if (!shipment) {
      req.flash("error", "❌ No shipment found for that Order ID or Tracking Number.");
      return res.redirect("/shipments/track");
    }

    res.render("shipments/track-shipment", {
      title: "Track Shipment",
      themeCss,
      shipment,
      business: req.session.business,
      success: req.flash("success"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("❌ Error tracking shipment:", err);
    req.flash("error", "Server error. Try again later.");
    res.redirect("/shipments/track");
  }
});

/* ===========================================================
 * ✏️ POST: Update Shipment Status with History
 * =========================================================== */
router.post("/update/:id", requireBusiness, async (req, res) => {
  try {
    const { status, trackingNumber, note } = req.body;
    const shipment = await Shipment.findOne({ 
      _id: req.params.id, 
      business: req.session.business._id 
    });

    if (!shipment) {
      req.flash("error", "Shipment not found or unauthorized.");
      return res.redirect("/shipments");
    }

    // ✅ Append to history
    shipment.history.push({
      status,
      note: note || `Status changed to ${status}`,
    });

    // ✅ Update main fields
    shipment.status = status;
    if (trackingNumber) shipment.trackingNumber = trackingNumber;

    // ✅ Auto update timestamps
    if (status === "In Transit" && !shipment.shippedAt) {
      shipment.shippedAt = new Date();
    } else if (status === "Delivered") {
      shipment.deliveredAt = new Date();
    }

    await shipment.save();
    req.flash("success", `🚚 Shipment marked as ${status}.`);
    res.redirect("/shipments");
  } catch (err) {
    console.error("❌ Error updating shipment:", err);
    req.flash("error", "Failed to update shipment.");
    res.redirect("/shipments");
  }
});


/* ===========================================================
 * 🗑️ POST: Delete Shipment
 * =========================================================== */
router.post("/delete/:id", requireBusiness, async (req, res) => {
  try {
    const shipment = await Shipment.findOneAndDelete({
      _id: req.params.id,
      business: req.session.business._id,
    });
    if (!shipment) {
      req.flash("error", "Shipment not found.");
      return res.redirect("/shipments");
    }
    req.flash("success", "🗑️ Shipment deleted successfully.");
    res.redirect("/shipments");
  } catch (err) {
    console.error("❌ Error deleting shipment:", err);
    req.flash("error", "Failed to delete shipment.");
    res.redirect("/shipments");
  }
});

module.exports = router;
