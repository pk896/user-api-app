// models/Wishlist.js
const { mongoose } = require("../db");
const { Schema } = mongoose;

/**
 * A wishlist entry belongs to exactly one "actor":
 * - either a normal user (userId) OR a business account (businessId)
 * and points to one product (productId).
 */
const wishlistSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", default: null, index: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  },
  { timestamps: true }
);

// Ensure exactly one of userId or businessId is present
wishlistSchema.pre("save", function (next) {
  if (!!this.userId === !!this.businessId) {
    return next(new Error("Wishlist must belong to either a user or a business (not both)."));
  }
  next();
});

// Unique guards (one product per actor)
wishlistSchema.index({ userId: 1, productId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } });
wishlistSchema.index({ businessId: 1, productId: 1 }, { unique: true, partialFilterExpression: { businessId: { $type: "objectId" } } });

module.exports = mongoose.model("Wishlist", wishlistSchema);
