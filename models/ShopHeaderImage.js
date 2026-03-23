// models/ShopHeaderImage.js
'use strict';

const mongoose = require('mongoose');

const shopHeaderImageSchema = new mongoose.Schema(
  {
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
  mongoose.models.ShopHeaderImage ||
  mongoose.model('ShopHeaderImage', shopHeaderImageSchema);
