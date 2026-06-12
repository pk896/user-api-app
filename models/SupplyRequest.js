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

    // ==========================
    // 🏭 Wholesale import tracking
    // ==========================
    // When a seller imports an approved request into Product,
    // we store the imported seller product here so this request
    // cannot be imported twice by mistake.
    importedProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },

    importedQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Imported quantity cannot be negative'],
    },

    importedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // Short lock used while the import is running.
    // This protects supplier stock if the seller double-clicks Import Product.
    importLockedAt: {
      type: Date,
      default: null,
      index: true,
    },

    // ==========================
    // 🗑️ Imported product delete / return tracking
    // ==========================
    // If the seller deletes an imported product, the unsold stock is returned
    // to SupplierProduct.availableQuantity and recorded here for supplier tracking.
    importDeletedAt: {
      type: Date,
      default: null,
      index: true,
    },

    returnedQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Returned quantity cannot be negative'],
    },

    deletedImportedProductSnapshot: {
      customId: { type: String, trim: true, default: '' },
      name: { type: String, trim: true, default: '' },
      imageUrl: { type: String, trim: true, default: '' },
      stockReturned: { type: Number, default: 0 },
      sellerStockAtDelete: { type: Number, default: 0 },
      soldCountAtDelete: { type: Number, default: 0 },
      deletedAt: { type: Date, default: null },
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

// Helps prevent repeated importing of the same approved request.
supplyRequestSchema.index({
  seller: 1,
  status: 1,
  importedAt: 1,
  importLockedAt: 1,
});

supplyRequestSchema.index({
  supplier: 1,
  importDeletedAt: 1,
  importedAt: 1,
});

module.exports =
  mongoose.models.SupplyRequest ||
  mongoose.model('SupplyRequest', supplyRequestSchema);