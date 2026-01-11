// models/Wishlist.js
'use strict';

const mongoose = require('mongoose');

const wishlistSchema = new mongoose.Schema(
  {
    ownerType: {
      type: String,
      enum: ['user', 'business'],
      required: true,
      index: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

// ✅ one row per owner+product
wishlistSchema.index({ ownerType: 1, ownerId: 1, productId: 1 }, { unique: true });

module.exports = mongoose.models.Wishlist || mongoose.model('Wishlist', wishlistSchema);
