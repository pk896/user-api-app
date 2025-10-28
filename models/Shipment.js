// models/Shipment.js
//const mongoose = require("mongoose");
const { mongoose } = require('../db'); // <-- use the shared instance
const { Schema } = mongoose;

/* ---------------------------------------
 * Subdocs
 * ------------------------------------- */
const HistorySchema = new Schema(
  {
    status: { type: String, trim: true },
    note: { type: String, trim: true },
    at: { type: Date, default: Date.now }, // preferred
    timestamp: { type: Date },             // legacy
  },
  { _id: false }
);

/* ---------------------------------------
 * Main schema
 * ------------------------------------- */
const ShipmentSchema = new Schema(
  {
    business: { type: Schema.Types.ObjectId, ref: "Business", required: true },

    // Links
    orderId: { type: String, trim: true, index: true },
    product: { type: Schema.Types.ObjectId, ref: "Product" },

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
      enum: [
        "Pending",
        "Processing",
        "In Transit",
        "Delivered",
        "Canceled",   // US
        "Cancelled",  // UK
      ],
      default: "Processing",
      index: true,
    },

    // Quantities / inventory safety
    quantity: { type: Number, default: 1, min: 1 },     // how many units this shipment represents
    inventoryCounted: { type: Boolean, default: false }, // prevents double-counting on Delivered

    // Key timestamps
    shippedAt: Date,
    deliveredAt: Date,

    // Audit trail
    history: [HistorySchema],
  },
  { timestamps: true }
);

/* ---------------------------------------
 * Hooks (normalize legacy)
 * ------------------------------------- */
ShipmentSchema.pre("save", function normalizeHistory(next) {
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
// By business + status + updatedAt (listing w/ filters)
ShipmentSchema.index({ business: 1, status: 1, updatedAt: -1 });
// Quick lookup by business + product (by-product view)
ShipmentSchema.index({ business: 1, product: 1, updatedAt: -1 });
// OrderId/TrackingNumber already have single-field indexes above

module.exports = mongoose.model("Shipment", ShipmentSchema);
