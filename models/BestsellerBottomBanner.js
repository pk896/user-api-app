// models/BestsellerBottomBanner.js
'use strict';

const mongoose = require('mongoose');

const bestsellerBottomBannerSchema = new mongoose.Schema(
  {
    slot: {
      type: String,
      enum: ['left', 'right'],
      required: true,
      unique: true,
      index: true,
    },

    productCustomId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    title: {
      type: String,
      trim: true,
      default: '',
    },

    subtitle: {
      type: String,
      trim: true,
      default: '',
    },

    priceText: {
      type: String,
      trim: true,
      default: '',
    },

    buttonText: {
      type: String,
      trim: true,
      default: 'Shop Now',
    },

    image: {
      type: String,
      trim: true,
      default: '',
    },

    overlayStyle: {
      type: String,
      trim: true,
      default: '',
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.BestsellerBottomBanner ||
  mongoose.model('BestsellerBottomBanner', bestsellerBottomBannerSchema);

  