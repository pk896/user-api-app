// models/Wishlist.js
const { mongoose } = require("../db");

const wishlistSchema = new mongoose.Schema(
  {
    ownerType: { type: String, enum: ["user", "business"], required: true },
    ownerId:   { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    productId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: "Product" },
  },
  { timestamps: true }
);

// A single owner can wishlist a product only once
wishlistSchema.index({ ownerType: 1, ownerId: 1, productId: 1 }, { unique: true });

// Safe export to avoid OverwriteModelError
module.exports = mongoose.models.Wishlist || mongoose.model("Wishlist", wishlistSchema);
