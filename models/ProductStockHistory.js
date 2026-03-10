// models/ProductStockHistory.js
'use strict';

const mongoose = require('mongoose');

const productStockHistorySchema = new mongoose.Schema(
  {
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },

    productCustomId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    productName: {
      type: String,
      trim: true,
      default: '',
    },

    stockBefore: {
      type: Number,
      required: true,
      min: 0,
    },

    stockAfter: {
      type: Number,
      required: true,
      min: 0,
    },

    delta: {
      type: Number,
      required: true,
    },

    reason: {
      type: String,
      enum: ['create', 'manual-update'],
      default: 'manual-update',
      index: true,
    },
  },
  { timestamps: true }
);

productStockHistorySchema.index({ business: 1, createdAt: -1 });
productStockHistorySchema.index({ product: 1, createdAt: -1 });

module.exports =
  mongoose.models.ProductStockHistory ||
  mongoose.model('ProductStockHistory', productStockHistorySchema);