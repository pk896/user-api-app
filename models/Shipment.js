// models/Shipment.js
const mongoose = require("mongoose");

const shipmentSchema = new mongoose.Schema(
  {
    business: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
    orderId: { type: String, required: true, trim: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    buyerName: String,
    buyerEmail: String,
    address: String,
    status: {
      type: String,
      enum: ["Pending", "In Transit", "Delivered", "Cancelled"],
      default: "Pending",
    },
    trackingNumber: String,
    shippedAt: Date,
    deliveredAt: Date,
    history: [
      {
        status: String,
        note: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shipment", shipmentSchema);
