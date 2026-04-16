// models/SellerProductDailyStat.js
'use strict';

const mongoose = require('mongoose');

const sellerProductDailyStatSchema = new mongoose.Schema(
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
      default: null,
      index: true,
    },

    productCustomId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    productName: {
      type: String,
      trim: true,
      default: '',
    },

    dayKey: {
      type: String,
      required: true,
      trim: true,
      index: true,
    }, // format: YYYY-MM-DD

    soldCount: {
      type: Number,
      default: 0,
      min: 0,
    },

    soldOrders: {
      type: Number,
      default: 0,
      min: 0,
    },

    revenue: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

sellerProductDailyStatSchema.index(
  { business: 1, productCustomId: 1, dayKey: 1 },
  { unique: true }
);

module.exports =
  mongoose.models.SellerProductDailyStat ||
  mongoose.model('SellerProductDailyStat', sellerProductDailyStatSchema);