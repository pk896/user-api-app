/* models/DeliveryOption.js */
const mongoose = require("mongoose");

const deliveryOptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    deliveryDays: { type: Number, required: true },
    priceCents: { type: Number, required: true }, // store in cents
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliveryOption", deliveryOptionSchema);
