// models/Payout.js
const mongoose = require('mongoose');

const payoutItemSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true },
    receiver: { type: String, required: true }, // PayPal email
    amountCents: { type: Number, required: true },
    currency: { type: String, default: 'USD' },

    status: { type: String, enum: ['PENDING', 'SENT', 'FAILED'], default: 'PENDING' },
    paypalItemId: { type: String, trim: true },   // payout_item_id if returned
    error: { type: String, trim: true },
  },
  { _id: false }
);

const payoutSchema = new mongoose.Schema(
  {
    createdByAdminId: { type: mongoose.Schema.Types.ObjectId, ref: 'Admin' },
    mode: { type: String, enum: ['SANDBOX', 'LIVE'], default: 'SANDBOX' },

    batchId: { type: String, trim: true },        // PayPal payout_batch_id
    senderBatchId: { type: String, trim: true },  // your unique id
    status: { type: String, enum: ['CREATED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'CREATED' },

    currency: { type: String, default: 'USD' },
    totalCents: { type: Number, default: 0 },

    items: { type: [payoutItemSchema], default: [] },
    note: { type: String, trim: true },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Payout', payoutSchema);
