// models/CjProductSyncLog.js
'use strict';

const mongoose = require('mongoose');

const cjProductSyncLogSchema = new mongoose.Schema(
  {
    cjProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CjProduct',
      default: null,
      index: true,
    },

    cjProductId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    action: {
      type: String,
      enum: [
        'CATALOGUE_VIEW',
        'DETAIL_VIEW',
        'IMPORT',
        'REIMPORT',
        'PRICE_UPDATE',
        'STATUS_UPDATE',
        'MANUAL_SYNC',
        'AUTOMATIC_SYNC',
      ],
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['SUCCESS', 'FAILED', 'PARTIAL'],
      required: true,
      index: true,
    },

    requestId: {
      type: String,
      trim: true,
      default: '',
    },

    message: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

cjProductSyncLogSchema.index({
  cjProductId: 1,
  createdAt: -1,
});

module.exports = mongoose.model(
  'CjProductSyncLog',
  cjProductSyncLogSchema,
);
