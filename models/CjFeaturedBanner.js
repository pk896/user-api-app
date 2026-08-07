// models/CjFeaturedBanner.js
'use strict';

const mongoose = require('mongoose');

/*
 * Separate homepage Featured Right-side Banner configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference the internal Product model
 * or the internal FeaturedBanner model.
 */
const cjFeaturedBannerSchema = new mongoose.Schema(
  {
    /*
     * The homepage currently has one featured right-side slot.
     *
     * Keeping a named unique slot prevents accidental creation
     * of multiple active configurations for the same location.
     */
    slot: {
      type: String,
      required: true,
      enum: ['right'],
      default: 'right',
      unique: true,
      trim: true,
    },

    /*
     * References CjProduct.cjProductId.
     *
     * Do not store an internal customId here.
     */
    cjProductId: {
      type: String,
      required: true,
      trim: true,
      index: true,
      maxlength: 300,
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
      maxlength: 120,
      default: 'Featured CJ Product',
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

module.exports =
  mongoose.models.CjFeaturedBanner ||
  mongoose.model(
    'CjFeaturedBanner',
    cjFeaturedBannerSchema,
  );
