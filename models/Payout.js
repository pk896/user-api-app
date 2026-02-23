// models/Payout.js
'use strict';

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

    runKey: {
      type: String,
      trim: true,
    },
    
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

/* =========================
   Indexes
========================= */
payoutSchema.index({ runKey: 1 }, { unique: true, sparse: true });

// ✅ Useful indexes for admin pages + lookups
payoutSchema.index({ createdAt: -1 });

// ✅ Ensure a PayPal batchId is never reused inside the same mode (SANDBOX/LIVE)
// (batchId can be null/empty before PayPal returns it, so sparse is needed)
payoutSchema.index({ mode: 1, batchId: 1 }, { unique: true, sparse: true });

// ✅ Status filtering
payoutSchema.index({ status: 1, createdAt: -1 });

// ✅ Optional helper: quick search by seller in embedded items (works fine)
payoutSchema.index({ 'items.businessId': 1, createdAt: -1 });

module.exports = mongoose.models.Payout || mongoose.model('Payout', payoutSchema);

