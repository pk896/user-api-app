// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  orderId: String,
  captureId: String,
  status: String,
  currency: String,
  amount: String,
  fee: String,
  net: String,
  payer: {
    id: String,
    email: String,
    name: { given: String, surname: String },
    country: String
  },
  shipping: {
    name: String,
    address_line_1: String,
    city: String,
    state: String,
    postal_code: String,
    country_code: String
  },
  refunds: [{
    refundId: String,
    status: String,
    amount: String,
    currency: String,
    createdAt: Date
  }],
  refundedTotal: { type: String, default: "0.00" },
  captureStatus: String,
  raw: Object
}, { timestamps: true });

module.exports = mongoose.model("Order", orderSchema);


