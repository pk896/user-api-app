// models/ShopMainBanner.js
'use strict';

const mongoose = require('mongoose');

const shopMainBannerSchema = new mongoose.Schema(
  {
    productCustomId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    title: {
      type: String,
      trim: true,
      maxlength: 80,
      default: 'SALE',
    },

    subtitle: {
      type: String,
      trim: true,
      maxlength: 160,
      default: 'Get UP To 50% Off',
    },

    buttonText: {
      type: String,
      trim: true,
      maxlength: 40,
      default: 'Shop Now',
    },

    image: {
      type: String,
      required: true,
      trim: true,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.ShopMainBanner ||
  mongoose.model('ShopMainBanner', shopMainBannerSchema);
