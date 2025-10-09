// models/ContactMessage.js
const mongoose = require("mongoose");

const contactMessageSchema = new mongoose.Schema({
  business: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: false,
  },
  subject: { type: String, trim: true },
  thread: [
    {
      sender: { type: String, enum: ["admin", "business"], required: true },
      message: { type: String, required: true },
      timestamp: { type: Date, default: Date.now },
    },
  ],
  readByBusiness: { type: Boolean, default: false },
  readByAdmin: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("ContactMessage", contactMessageSchema);
