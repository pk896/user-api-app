// models/SupplierProduct.js
'use strict';

const mongoose = require('mongoose');

const SupplierProductColorImageSchema = new mongoose.Schema(
  {
    color: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true, required: true },
  },
  { _id: false }
);

const SupplierProductShippingSchema = new mongoose.Schema(
  {
    weight: {
      value: { type: Number, default: null },
      unit: {
        type: String,
        enum: ['kg', 'g', 'lb', 'oz'],
        default: 'kg',
      },
    },
    dimensions: {
      length: { type: Number, default: null },
      width: { type: Number, default: null },
      height: { type: Number, default: null },
      unit: {
        type: String,
        enum: ['cm', 'in'],
        default: 'cm',
      },
    },
    shipSeparately: { type: Boolean, default: false },
    fragile: { type: Boolean, default: false },
    packagingHint: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const supplierProductSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    customId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: 160,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: '',
    },

    imageUrl: {
      type: String,
      required: [true, 'Product image is required'],
      trim: true,
    },

    wholesalePrice: {
      type: Number,
      required: [true, 'Wholesale price is required'],
      min: [0, 'Wholesale price cannot be negative'],
    },

    minimumOrderQuantity: {
      type: Number,
      default: 1,
      min: [1, 'Minimum order quantity must be at least 1'],
    },

    availableQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Available quantity cannot be negative'],
      index: true,
    },

    unit: {
      type: String,
      trim: true,
      default: 'units',
    },

    role: {
      type: String,
      trim: true,
      default: 'general',
      index: true,
    },

    type: {
      type: String,
      trim: true,
      index: true,
    },

    category: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },

    quality: {
      type: String,
      trim: true,
      default: '',
    },

    made: {
      type: String,
      trim: true,
      default: '',
    },

    madeCode: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true,
    },

    manufacturer: {
      type: String,
      trim: true,
      default: '',
    },

    keywords: {
      type: [String],
      default: [],
      index: true,
    },

    color: {
      type: String,
      trim: true,
      default: '',
    },

    size: {
      type: String,
      trim: true,
      default: '',
    },

    sizes: {
      type: [String],
      default: [],
    },

    colors: {
      type: [String],
      default: [],
    },

    colorImages: {
      type: [SupplierProductColorImageSchema],
      default: [],
    },

    countryOfOrigin: {
      type: String,
      trim: true,
      default: '',
    },

    supplyLocation: {
      country: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
    },

    leadTimeDays: {
      type: Number,
      default: 3,
      min: [0, 'Lead time cannot be negative'],
    },

    acceptsBulkOrders: {
      type: Boolean,
      default: true,
      index: true,
    },

    shipping: {
      type: SupplierProductShippingSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'archived'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true }
);

supplierProductSchema.index({
  name: 'text',
  description: 'text',
  category: 'text',
  type: 'text',
  manufacturer: 'text',
  keywords: 'text',
});

supplierProductSchema.index({ supplier: 1, status: 1, createdAt: -1 });
supplierProductSchema.index({ status: 1, category: 1, createdAt: -1 });

module.exports =
  mongoose.models.SupplierProduct ||
  mongoose.model('SupplierProduct', supplierProductSchema);
