// models/Rating.js
'use strict';

const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true,
      index: true,
    },

    // ✅ allow guest too
    raterType: {
      type: String,
      enum: ['user', 'business', 'guest'],
      required: true,
      index: true,
    },

    raterUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    raterBusiness: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
      index: true,
    },

    // ✅ guest identity (cookie-based)
    guestKey: { type: String, default: null, index: true },

    stars: { type: Number, min: 1, max: 5, required: true },

    // ✅ ensure empty text becomes "" (not undefined) so UI/API handling is consistent
    title: { type: String, trim: true, maxlength: 120, default: '' },
    body: { type: String, trim: true, maxlength: 2000, default: '' },

    status: {
      type: String,
      enum: ['published', 'hidden', 'flagged'],
      default: 'published',
      index: true,
    },
  },
  { timestamps: true },
);

// ✅ One rating per USER per product
ratingSchema.index(
  { productId: 1, raterType: 1, raterUser: 1 },
  {
    unique: true,
    partialFilterExpression: { raterType: 'user', raterUser: { $type: 'objectId' } },
  },
);

// ✅ One rating per BUSINESS per product
ratingSchema.index(
  { productId: 1, raterType: 1, raterBusiness: 1 },
  {
    unique: true,
    partialFilterExpression: { raterType: 'business', raterBusiness: { $type: 'objectId' } },
  },
);

// ✅ One rating per GUEST per product
ratingSchema.index(
  { productId: 1, raterType: 1, guestKey: 1 },
  {
    unique: true,
    partialFilterExpression: { raterType: 'guest', guestKey: { $type: 'string' } },
  },
);

module.exports = mongoose.models.Rating || mongoose.model('Rating', ratingSchema);
