// models/CjOrderEmailLog.js
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const cjOrderEmailLogSchema = new Schema(
  {
    department: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      immutable: true,
      index: true,
    },

    cjOrder: {
      type: Schema.Types.ObjectId,
      ref: 'CjOrder',
      required: true,
      index: true,
    },

    cjOrderNumber: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    eventType: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    recipient: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['PROCESSING', 'SENT', 'FAILED'],
      default: 'PROCESSING',
      index: true,
    },

    subject: {
      type: String,
      trim: true,
      default: '',
      maxlength: 500,
    },

    provider: {
      type: String,
      trim: true,
      default: '',
      maxlength: 100,
    },

    attemptCount: {
      type: Number,
      default: 1,
      min: 0,
    },

    claimedAt: {
      type: Date,
      default: Date.now,
    },

    sentAt: {
      type: Date,
      default: null,
      index: true,
    },

    failedAt: {
      type: Date,
      default: null,
    },

    retryAfter: {
      type: Date,
      default: null,
      index: true,
    },

    lastError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    source: {
      type: String,
      trim: true,
      default: '',
      maxlength: 200,
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

cjOrderEmailLogSchema.index(
  {
    cjOrder: 1,
    eventType: 1,
    recipient: 1,
  },
  {
    unique: true,
    name: 'unique_cj_order_event_recipient',
  },
);

cjOrderEmailLogSchema.index({
  status: 1,
  retryAfter: 1,
  updatedAt: 1,
});

module.exports = mongoose.model(
  'CjOrderEmailLog',
  cjOrderEmailLogSchema,
);
