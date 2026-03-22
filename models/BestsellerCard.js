// models/BestsellerCard.js
'use strict';

const mongoose = require('mongoose');

const bestsellerCardSchema = new mongoose.Schema(
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

    eyebrowText: {
      type: String,
      trim: true,
      default: '',
    },

    titleOverride: {
      type: String,
      trim: true,
      default: '',
    },

    discountText: {
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
  mongoose.models.BestsellerCard ||
  mongoose.model('BestsellerCard', bestsellerCardSchema);
