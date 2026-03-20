// models/HomePromoOffer.js
'use strict';

const mongoose = require('mongoose');

const homePromoOfferSchema = new mongoose.Schema(
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

    eyebrowText: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },

    titleOverride: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },

    discountText: {
      type: String,
      trim: true,
      maxlength: 40,
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
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.HomePromoOffer ||
  mongoose.model('HomePromoOffer', homePromoOfferSchema);