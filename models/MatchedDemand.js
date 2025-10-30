// models/MatchedDemand.js
const { mongoose } = require("../db");
const { Schema } = mongoose;

/**
 * A link between a Buyer's Demand and a Supplier's Product.
 */
const matchedDemandSchema = new Schema(
  {
    demandId: { type: Schema.Types.ObjectId, ref: "Demand", required: true, index: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },

    // Matching score (0-100)
    score: { type: Number, default: 0 },

    // Supplier → action on this match
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected"],
      default: "pending",
      index: true,
    },

    // Optional light message/quote
    supplierMessage: { type: String, default: "" },

    // Simple denormalized fields to render faster in lists (optional)
    snapshot: {
      demandTitle: String,
      demandQuantity: Number,
      demandLocation: String,
      productName: String,
      productType: String,
      productPrice: Number,
      productLocation: String,
    },
  },
  { timestamps: true }
);

matchedDemandSchema.index({ demandId: 1, productId: 1 }, { unique: true }); // prevent duplicates

module.exports = mongoose.model("MatchedDemand", matchedDemandSchema);
