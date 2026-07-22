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
      index: true,
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

/*
 * There can be only one saved configuration for the CJ
 * homepage right-side featured banner.
 */
cjFeaturedBannerSchema.index(
  {
    slot: 1,
  },
  {
    unique: true,
  },
);

module.exports =
  mongoose.models.CjFeaturedBanner ||
  mongoose.model(
    'CjFeaturedBanner',
    cjFeaturedBannerSchema,
  );
