// models/MatchedDemand.js
const mongoose = require('mongoose');
const { Schema } = mongoose;

const MatchedDemandSchema = new Schema(
  {
    demandId: { type: Schema.Types.ObjectId, ref: 'DemandedProduct', index: true }, // or "Demand"
    buyerId: { type: Schema.Types.ObjectId, ref: 'Business', index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Business', index: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', index: true },

    // status the supplier sets: "pending" | "accepted" | "rejected"
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending',
      index: true,
    },

    // numeric score (100 for type-only now)
    score: { type: Number, default: 0, index: true },

    // snapshot for resilience
    snapshot: {
      demandTitle: String,
      demandQuantity: Number,
      demandLocation: String,
      productName: String,
      productType: String,
      productPrice: Number,
      productLocation: String,
    },

    // supplier response
    supplierMessage: { type: String, default: '' },
  },
  { timestamps: true },
);

// unique-ish pair (same demand+product shouldn’t duplicate)
MatchedDemandSchema.index({ demandId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.model('MatchedDemand', MatchedDemandSchema);
