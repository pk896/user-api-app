// models/SupplyRequest.js
'use strict';

const mongoose = require('mongoose');

const supplyRequestSchema = new mongoose.Schema(
  {
    seller: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    supplierProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupplierProduct',
      required: true,
      index: true,
    },

    requestedQuantity: {
      type: Number,
      required: [true, 'Requested quantity is required'],
      min: [1, 'Requested quantity must be at least 1'],
    },

    message: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },

    contactName: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },

    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },

    contactPhone: {
      type: String,
      trim: true,
      default: '',
    },

    deliveryCountry: {
      type: String,
      trim: true,
      default: '',
    },

    deliveryCity: {
      type: String,
      trim: true,
      default: '',
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
      default: 'pending',
      index: true,
    },

    supplierResponse: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },

    approvedAt: {
      type: Date,
      default: null,
    },

    rejectedAt: {
      type: Date,
      default: null,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

supplyRequestSchema.index(
  { seller: 1, supplier: 1, supplierProduct: 1, status: 1 },
  { name: 'seller_supplier_product_status_idx' }
);

supplyRequestSchema.index({ supplier: 1, status: 1, createdAt: -1 });
supplyRequestSchema.index({ seller: 1, status: 1, createdAt: -1 });

module.exports =
  mongoose.models.SupplyRequest ||
  mongoose.model('SupplyRequest', supplyRequestSchema);