// models/Shipment.js
const { mongoose } = require('../db'); // shared instance
const { Schema } = mongoose;

/* ---------------------------------------
 * Subdocs
 * ------------------------------------- */
const HistorySchema = new Schema(
  {
    status: { type: String, trim: true },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now }, // preferred timestamp
    timestamp: { type: Date },             // legacy
  },
  { _id: false },
);

// Canonical statuses (reuse in routes if needed)
const STATUSES = ['Pending', 'Processing', 'In Transit', 'Delivered', 'Canceled', 'Cancelled'];

/* ---------------------------------------
 * Main schema
 * ------------------------------------- */
const ShipmentSchema = new Schema(
  {
    // Owner (seller/supplier)
    business: { type: Schema.Types.ObjectId, ref: 'Business', required: true, index: true },

    // Optional: buyer organization (useful for buyer dashboards)
    buyerBusiness: { type: Schema.Types.ObjectId, ref: 'Business', index: true },

    // Links
    orderId: { type: String, trim: true, index: true }, // multiple shipments can share same orderId
    product: { type: Schema.Types.ObjectId, ref: 'Product', index: true },

    // Buyer / shipping
    buyerName: { type: String, trim: true },
    buyerEmail: { type: String, trim: true },
    address: { type: String, trim: true },

    // Logistics
    carrier: { type: String, trim: true },
    trackingNumber: { type: String, trim: true, index: true },

    // Status
    status: {
      type: String,
      enum: STATUSES,
      default: 'Processing',
      index: true,
    },

    // Quantities / inventory safety
    quantity: { type: Number, default: 1, min: 1 }, // how many units this shipment represents
    inventoryCounted: { type: Boolean, default: false }, // prevents double-counting on Delivered

    // Key timestamps
    shippedAt: Date,
    deliveredAt: Date,

    // Audit trail
    history: [HistorySchema],
  },
  { timestamps: true },
);

/* ---------------------------------------
 * Hooks (normalize legacy)
 * ------------------------------------- */
ShipmentSchema.pre('save', function normalizeHistory(next) {
  if (Array.isArray(this.history)) {
    this.history.forEach((h) => {
      if (!h.at && h.timestamp) h.at = h.timestamp;
    });
  }
  next();
});

/* ---------------------------------------
 * Indexes for common queries
 * ------------------------------------- */
// existing singles above; add helpful compounds:
ShipmentSchema.index({ business: 1, status: 1, updatedAt: -1 }); // dashboard listing
ShipmentSchema.index({ business: 1, product: 1, updatedAt: -1 }); // by-product
ShipmentSchema.index({ business: 1, orderId: 1, updatedAt: -1 }); // per-order drilldown
ShipmentSchema.index({ buyerBusiness: 1, status: 1, updatedAt: -1 }); // buyer-side views

// Re-export statuses for routes
ShipmentSchema.statics.STATUSES = STATUSES;

// Guard against OverwriteModelError in dev
module.exports = mongoose.models.Shipment || mongoose.model('Shipment', ShipmentSchema);
