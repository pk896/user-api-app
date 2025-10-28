// models/Product.js
//const mongoose = require("mongoose");
const { mongoose } = require('../db'); // <-- use the shared instance

const productSchema = new mongoose.Schema(
  {
    // Custom readable product ID (not Mongo _id)
    customId: {
      type: String,
      required: true,
      unique: true, // ✅ ensures no duplicates
      trim: true,
    },

    name: {
      type: String,
      required: [true, "Product name is required"],
      trim: true,
    },

    price: {
      type: Number,
      required: [true, "Price is required"],
      min: [0, "Price must be a positive number"],
    },

    description: {
      type: String,
      trim: true,
      maxlength: 2000, // prevent overly long descriptions
    },

    imageUrl: {
      type: String,
      required: [true, "Product image is required"],
      validate: {
        validator: (v) => /^https?:\/\/.+/.test(v),
        message: (props) => `${props.value} is not a valid image URL!`,
      },
    },

    stock: {
      type: Number,
      default: 0,
      min: [0, "Stock cannot be negative"],
    },

    category: { type: String, trim: true },
    color: { type: String, trim: true },
    size: { type: String, trim: true },
    quality: { type: String, trim: true },
    made: { type: String, trim: true },
    manufacturer: { type: String, trim: true },
    type: { type: String, trim: true },
    // Inside productSchema definition
    soldCount: { type: Number, default: 0 },   // total units sold
    soldOrders: { type: Number, default: 0 },  // number of orders that included this product


    // 🔗 Reference to Business (owner)
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true, // ✅ keep indexed for fast queries
    },
  },
  { timestamps: true }
);

// --------------------------
// Indexes for performance
// --------------------------
productSchema.index({ category: 1 });

// --------------------------
// Safe JSON output (no internal Mongo fields)
// --------------------------
productSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Product", productSchema);
