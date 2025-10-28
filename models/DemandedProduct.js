// models/DemandedProduct.js
const { mongoose } = require('../db');
const { Schema } = mongoose;

const trimSet = s => (s || '').trim();

const DemandedProductSchema = new Schema({
  // who demanded (the buyer business account in session)
  business: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },

  // explicit "who" fields filled by the user (so we can see who submitted it)
  requester: {
    businessName: { type: String, required: true, trim: true, set: trimSet },
    contactName:  { type: String, required: true, trim: true, set: trimSet },
    position:     { type: String, required: true, trim: true, set: trimSet },
  },

  // what they need
  type:        { type: String, trim: true, required: true, set: trimSet },  // e.g., "Electronics"
  productName: { type: String, trim: true, required: true, set: trimSet },
  quantity: {
    type: Number,
    min: 1,
    default: 1,
    set: v => Math.max(1, Math.floor(Number(v) || 1)) // force integer >=1
  },

  // where (for aggregation)
  country:  { type: String, trim: true, required: true, set: trimSet },
  province: { type: String, trim: true, set: trimSet },
  city:     { type: String, trim: true, set: trimSet },
  town:     { type: String, trim: true, set: trimSet },

  // optional metadata
  notes:  { type: String, trim: true, maxlength: 2000 },
  status: { type: String, enum: ["Open", "Matched", "Closed"], default: "Open", index: true },
}, {
  timestamps: true,
  versionKey: false,
});

// 🔎 Aggregation-friendly index
DemandedProductSchema.index({ type: 1, country: 1, province: 1, city: 1, town: 1 });

// 📋 Fast “my demands” listing: business + createdAt desc
DemandedProductSchema.index({ business: 1, createdAt: -1 });

// 🔍 Optional text search across common fields (incl. requester biz/contact)
/* Only one text index per collection */
DemandedProductSchema.index({
  productName: 'text',
  type: 'text',
  notes: 'text',
  'requester.businessName': 'text',
  'requester.contactName': 'text',
});

module.exports = mongoose.model("DemandedProduct", DemandedProductSchema);
