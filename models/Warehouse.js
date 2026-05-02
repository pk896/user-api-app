// models/Warehouse.js
'use strict';

const mongoose = require('mongoose');

const WarehouseAddressSchema = new mongoose.Schema(
  {
    street1: { type: String, required: true, trim: true },
    street2: { type: String, default: '', trim: true },
    city: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    zip: { type: String, required: true, trim: true },
    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },
  },
  { _id: false }
);

const WarehouseSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: 40,
      index: true,
    },

    country: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
      index: true,
    },

    province: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },

    provinceCode: {
      type: String,
      default: '',
      trim: true,
      uppercase: true,
      index: true,
    },

    address: {
      type: WarehouseAddressSchema,
      required: true,
    },

    phone: {
      type: String,
      default: '',
      trim: true,
      maxlength: 40,
    },

    email: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
      maxlength: 140,
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    isDefault: {
      type: Boolean,
      default: false,
      index: true,
    },

    priority: {
      type: Number,
      default: 100,
      index: true,
    },

    supportedCountries: {
      type: [String],
      default: [],
      set: function (values) {
        return Array.isArray(values)
          ? values.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean)
          : [];
      },
    },

    supportedProvinces: {
      type: [String],
      default: [],
      set: function (values) {
        return Array.isArray(values)
          ? values.map((v) => String(v || '').trim()).filter(Boolean)
          : [];
      },
    },

    notes: {
      type: String,
      default: '',
      trim: true,
      maxlength: 1000,
    },
  },
  { timestamps: true }
);

WarehouseSchema.index({ country: 1, provinceCode: 1, isActive: 1, priority: 1 });
WarehouseSchema.index({ country: 1, isDefault: 1, isActive: 1, priority: 1 });

WarehouseSchema.pre('validate', function (next) {
  if (this.country) {
    this.country = String(this.country).trim().toUpperCase();
  }

  if (this.address && this.address.country) {
    this.address.country = String(this.address.country).trim().toUpperCase();
  }

  if (!this.address.country && this.country) {
    this.address.country = this.country;
  }

  if (this.address.country && this.country && this.address.country !== this.country) {
    return next(new Error('Warehouse address.country must match warehouse country.'));
  }

  if (this.code) {
    this.code = String(this.code).trim().toUpperCase();
  }

  if (this.provinceCode) {
    this.provinceCode = String(this.provinceCode).trim().toUpperCase();
  }

  next();
});

const Warehouse =
  mongoose.models.Warehouse || mongoose.model('Warehouse', WarehouseSchema);

module.exports = Warehouse;
module.exports.Warehouse = Warehouse;
