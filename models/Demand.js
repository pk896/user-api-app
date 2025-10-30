// models/Demand.js
const { mongoose } = require("../db");
const { Schema } = mongoose;

/** Subdoc shown in your table */
const requesterSchema = new Schema(
  {
    businessName: { type: String, trim: true },
    contactName:  { type: String, trim: true },
    position:     { type: String, trim: true },
  },
  { _id: false }
);

/** Demand model — works with my-demands.ejs + matcher */
const demandSchema = new Schema(
  {
    // Owner
    buyerId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },

    // Table fields
    requester:   requesterSchema,
    productName: { type: String, trim: true },
    type:        { type: String, trim: true },     // alias of productType for UI
    status:      { type: String, trim: true, default: "Open" },

    // Matching fields
    title:        { type: String, trim: true },
    productType:  { type: String, trim: true },    // kept in sync with "type"
    quantity:     { type: Number, default: 0, min: 0 },
    quality:      { type: String, trim: true },
    targetPrice:  { type: Number, min: 0 },

    // Location (structured + optional free-form)
    country:  { type: String, trim: true },
    province: { type: String, trim: true },
    city:     { type: String, trim: true },
    town:     { type: String, trim: true },
    location: { type: String, trim: true },        // free-form like "Gauteng, ZA"

    // Notes (you slice in EJS)
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

/** Keep "type" <-> "productType" synced */
demandSchema.pre("save", function (next) {
  if (this.type && !this.productType) this.productType = this.type;
  if (this.productType && !this.type) this.type = this.productType;
  next();
});

/** Handy virtuals */
demandSchema.virtual("normalizedProductType").get(function () {
  return (this.productType || this.type || "").trim().toLowerCase();
});
demandSchema.virtual("displayLocation").get(function () {
  const parts = [this.country, this.province, this.city, this.town]
    .map(v => (v || "").trim())
    .filter(Boolean);
  return parts.join(", ");
});

/** Indexes */
demandSchema.index({ buyerId: 1, createdAt: -1 });
demandSchema.index({ status: 1, createdAt: -1 });
demandSchema.index({ type: 1 });
demandSchema.index({ productType: 1 });

module.exports = mongoose.models.Demand || mongoose.model("Demand", demandSchema);
