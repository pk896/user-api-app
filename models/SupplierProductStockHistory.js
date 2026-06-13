// models/SupplierProductStockHistory.js
'use strict';

const mongoose = require('mongoose');

const supplierProductStockHistorySchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    supplierProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupplierProduct',
      default: null,
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
      default: 0,
    },

    stockAfter: {
      type: Number,
      required: true,
      default: 0,
    },

    delta: {
      type: Number,
      required: true,
      default: 0,
      index: true,
    },

    reason: {
      type: String,
      trim: true,
      default: 'stock-update',
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

supplierProductStockHistorySchema.index({
  supplier: 1,
  createdAt: -1,
});

supplierProductStockHistorySchema.index({
  supplier: 1,
  supplierProduct: 1,
  createdAt: -1,
});

module.exports =
  mongoose.models.SupplierProductStockHistory ||
  mongoose.model(
    'SupplierProductStockHistory',
    supplierProductStockHistorySchema,
  );