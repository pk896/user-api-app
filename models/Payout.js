// models/Payout.js
'use strict';

const mongoose = require('mongoose');

function getBaseCurrency() {
  return String(process.env.BASE_CURRENCY || '').trim().toUpperCase() || 'USD';
}

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

    currency: {
      type: String,
      default: getBaseCurrency,
      trim: true,
      uppercase: true,
      index: true,
    },

    // Local status used by your UI and balance logic.
    // Keep SENT / FAILED / PENDING, but allow monitoring states safely.
    status: {
      type: String,
      enum: [
        'PENDING',
        'SENT',
        'FAILED',
        'UNCLAIMED',
        'ONHOLD',
        'RETURNED',
        'BLOCKED',
        'DENIED',
        'REVERSED',
        'REFUNDED',
      ],
      default: 'PENDING',
      index: true,
    },

    paidAt: { type: Date, default: null },

    paypalItemId: { type: String, trim: true },

    // Short safe error/message for admin page.
    error: { type: String, trim: true },

    // Production-safe PayPal item status tracking.
    paypalTransactionStatus: { type: String, trim: true, uppercase: true, index: true },
    lastSyncedAt: { type: Date, default: null },
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

    confirmedByAdminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },

    confirmedAt: { type: Date, default: null, index: true },

    mode: {
      type: String,
      enum: ['SANDBOX', 'LIVE'],
      default: 'SANDBOX',
      index: true,
    },

    batchId: { type: String, trim: true },

    senderBatchId: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    // PayPal-Request-Id for idempotent PayPal POST retry safety.
    paypalRequestId: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    status: {
      type: String,
      enum: ['CREATED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELED'],
      default: 'CREATED',
      index: true,
    },

    // Review/confirm lifecycle for production safety.
    approvalStatus: {
      type: String,
      enum: ['DRAFT', 'REVIEWED', 'CONFIRMED', 'SUBMITTED', 'COMPLETED', 'FAILED', 'CANCELED'],
      default: 'SUBMITTED',
      index: true,
    },

    currency: {
      type: String,
      default: getBaseCurrency,
      trim: true,
      uppercase: true,
      index: true,
    },

    totalCents: { type: Number, default: 0 },

    items: { type: [payoutItemSchema], default: [] },

    note: { type: String, trim: true },

    // One active payout creation lock per currency.
    runKey: {
      type: String,
      trim: true,
    },

    // Stable local duplicate-prevention fingerprint.
    // This protects you from creating two payout documents for the same exact eligible set.
    fingerprint: {
      type: String,
      trim: true,
      index: true,
      unique: true,
      sparse: true,
    },

    fingerprintExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Auto-sync lock so webhook/manual sync do not fight each other.
    syncLockKey: {
      type: String,
      trim: true,
      index: true,
    },

    syncLockExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    autoSyncAttempts: { type: Number, default: 0 },
    lastAutoSyncAt: { type: Date, default: null },
    lastManualSyncAt: { type: Date, default: null },

    lastWebhookEventId: {
      type: String,
      trim: true,
      index: true,
    },

    lastWebhookAt: { type: Date, default: null },

    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

/* =========================
   Indexes
========================= */

payoutSchema.index({ runKey: 1 }, { unique: true, sparse: true });

payoutSchema.index({ createdAt: -1 });

payoutSchema.index(
  { mode: 1, batchId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      batchId: { $type: 'string' },
    },
  }
);

payoutSchema.index({ status: 1, createdAt: -1 });
payoutSchema.index({ approvalStatus: 1, createdAt: -1 });
payoutSchema.index({ 'items.businessId': 1, createdAt: -1 });
payoutSchema.index({ 'items.status': 1, createdAt: -1 });
payoutSchema.index({ mode: 1, currency: 1, status: 1, createdAt: -1 });

// Helps find local payout from PayPal webhook batch id quickly.
payoutSchema.index({ batchId: 1, createdAt: -1 });

module.exports = mongoose.models.Payout || mongoose.model('Payout', payoutSchema);