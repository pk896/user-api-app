// models/Payout.js
const mongoose = require('mongoose');

const payoutItemSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    // PayPal email (normalized)
    receiver: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    amountCents: { type: Number, required: true },

    // keep currency consistent (USD not usd)
    currency: {
      type: String,
      default: 'USD',
      trim: true,
      uppercase: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['PENDING', 'SENT', 'FAILED'],
      default: 'PENDING',
    },

    paypalItemId: { type: String, trim: true }, // payout_item_id if returned
    error: { type: String, trim: true },
  },
  { _id: false }
);

const payoutSchema = new mongoose.Schema(
  {
    createdByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      index: true,
    },

    mode: {
      type: String,
      enum: ['SANDBOX', 'LIVE'],
      default: 'SANDBOX',
      index: true,
    },

    batchId: { type: String, trim: true }, // PayPal payout_batch_id

    // ✅ must be unique so retries don't create duplicate batches
    senderBatchId: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    status: {
      type: String,
      enum: ['CREATED', 'PROCESSING', 'COMPLETED', 'FAILED'],
      default: 'CREATED',
      index: true,
    },

    currency: {
      type: String,
      default: 'USD',
      trim: true,
      uppercase: true,
      index: true,
    },

    totalCents: { type: Number, default: 0 },

    items: { type: [payoutItemSchema], default: [] },
    note: { type: String, trim: true },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

// ✅ Useful indexes for admin pages + lookups
payoutSchema.index({ createdAt: -1 });
payoutSchema.index({ batchId: 1 }, { sparse: true });
payoutSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Payout', payoutSchema);
