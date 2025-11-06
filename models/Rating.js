// models/Rating.js
const { mongoose } = require("../db");

const ratingSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
  raterType: { type: String, enum: ["user", "business"], required: true },
  raterUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  raterBusiness: { type: mongoose.Schema.Types.ObjectId, ref: "Business", default: null },
  stars: { type: Number, min: 1, max: 5, required: true },
  title: { type: String, trim: true, maxlength: 120 },
  body:  { type: String, trim: true, maxlength: 2000 },
  status: { type: String, enum: ["published", "hidden", "flagged"], default: "published", index: true },
}, { timestamps: true });

// One rating per USER per product
ratingSchema.index(
  { productId: 1, raterType: 1, raterUser: 1 },
  { unique: true, partialFilterExpression: { raterType: "user", raterUser: { $type: "objectId" } } }
);

// One rating per BUSINESS per product
ratingSchema.index(
  { productId: 1, raterType: 1, raterBusiness: 1 },
  { unique: true, partialFilterExpression: { raterType: "business", raterBusiness: { $type: "objectId" } } }
);

module.exports = mongoose.models.Rating || mongoose.model("Rating", ratingSchema);
