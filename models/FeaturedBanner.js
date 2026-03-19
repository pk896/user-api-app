// models/FeaturedBanner.js
'use strict';

const mongoose = require('mongoose');

const featuredBannerSchema = new mongoose.Schema(
  {
    productCustomId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    badgeText: {
      type: String,
      trim: true,
      maxlength: 80,
      default: 'Special Offer',
    },
    offerText: {
      type: String,
      trim: true,
      maxlength: 80,
      default: 'Featured Product',
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
  mongoose.models.FeaturedBanner || mongoose.model('FeaturedBanner', featuredBannerSchema);