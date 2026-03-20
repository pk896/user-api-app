// models/HomeMidBanner.js
'use strict';

const mongoose = require('mongoose');

const homeMidBannerSchema = new mongoose.Schema(
  {
    slot: {
      type: String,
      required: true,
      enum: ['left', 'right'],
      unique: true,
      index: true,
      trim: true,
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
      maxlength: 120,
      default: '',
    },

    subtitle: {
      type: String,
      trim: true,
      maxlength: 160,
      default: '',
    },

    priceText: {
      type: String,
      trim: true,
      maxlength: 80,
      default: '',
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

    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.HomeMidBanner ||
  mongoose.model('HomeMidBanner', homeMidBannerSchema);