// models/CjHomePromoOffer.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate homepage promo-offer configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference:
 *
 * - Internal Product
 * - Product.customId
 * - HomePromoOffer
 */
const cjHomePromoOfferSchema = new mongoose.Schema(
  {
    /*
     * The CJ homepage supports exactly two promo cards:
     *
     * - left
     * - right
     *
     * The unique slot index prevents multiple saved records
     * for the same CJ homepage position.
     */
    slot: {
      type: String,
      required: true,
      enum: ['left', 'right'],
      trim: true,
    },

    /*
     * References CjProduct.cjProductId.
     *
     * Never store an Internal Product customId here.
     */
    cjProductId: {
      type: String,
      required: true,
      trim: true,
      index: true,
      maxlength: 300,
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
  },
);

/*
 * Only one CJ promo-offer record may exist for each slot.
 */
cjHomePromoOfferSchema.index(
  {
    slot: 1,
  },
  {
    unique: true,
  },
);

module.exports =
  mongoose.models.CjHomePromoOffer ||
  mongoose.model(
    'CjHomePromoOffer',
    cjHomePromoOfferSchema,
  );
