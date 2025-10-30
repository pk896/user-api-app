// models/Product.js
// Use the shared mongoose instance
const { mongoose } = require("../db");

const productSchema = new mongoose.Schema(
  {
    // Readable product ID (separate from Mongo _id)
    customId: {
      type: String,
      required: true,
      unique: true,
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
      maxlength: 2000,
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

    // Classification / attributes
    category: { type: String, trim: true },
    color:    { type: String, trim: true },
    size:     { type: String, trim: true },
    quality:  { type: String, trim: true },
    made:     { type: String, trim: true },
    manufacturer: { type: String, trim: true },

    // 🧭 Type is what we match on (type-only matching)
    type: { type: String, trim: true, index: true }, // single index definition here

    // Sales counters
    soldCount:  { type: Number, default: 0 },
    soldOrders: { type: Number, default: 0 },

    // 🔗 Owner (supplier) business
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

/* ---------------------------
 * Indexes (no duplicates)
 * ------------------------- */
// Keep category indexed if you filter by it in lists
productSchema.index({ category: 1 });

// Helpful compound for owner dashboards (optional)
// productSchema.index({ business: 1, type: 1 });

/* ---------------------------
 * Safe JSON output
 * ------------------------- */
productSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.model("Product", productSchema);
