// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  items: [
    {
      id: String,
      name: String,
      quantity: Number,
      price: Number
    }
  ],
  subtotal: Number,
  tax: Number,
  shipping: Number,
  total: Number,
  status: { type: String, default: "Pending" }, // Pending | Completed | Failed
  paypalOrderId: String, // PayPal order ID
  paymentDetails: Object, // PayPal capture details
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model("Order", orderSchema);
