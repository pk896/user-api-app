// models/CjBestsellerCard.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate Bestseller Card configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference:
 *
 * - Product
 * - Product.customId
 * - BestsellerCard
 * - Internal Kasyora cart, checkout or orders
 *
 * It stores only CjProduct.cjProductId.
 */
const cjBestsellerCardSchema = new mongoose.Schema(
  {
    /*
     * The Bestseller page contains exactly two CJ cards:
     *
     * - left
     * - right
     *
     * The unique index prevents multiple records from being
     * created for the same position.
     */
    slot: {
      type: String,
      enum: ['left', 'right'],
      required: true,
      unique: true,
      trim: true,
    },

    /*
     * The authoritative link to the separate imported
     * CJ product catalogue.
     */
    cjProductId: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      index: true,
    },

    /*
     * Small promotional text shown above the main title.
     *
     * Example:
     * "Trending Worldwide"
     */
    eyebrowText: {
      type: String,
      trim: true,
      default: '',
      maxlength: 120,
    },

    /*
     * Optional storefront title.
     *
     * When blank, the linked CjProduct name will be used.
     */
    titleOverride: {
      type: String,
      trim: true,
      default: '',
      maxlength: 100,
    },

    /*
     * Large promotional message.
     *
     * Examples:
     * "Up To 40% Off"
     * "Limited Collection"
     */
    discountText: {
      type: String,
      trim: true,
      default: '',
      maxlength: 80,
    },

    /*
     * Text displayed on the modern CJ call-to-action button.
     */
    buttonText: {
      type: String,
      trim: true,
      default: 'Explore Product',
      maxlength: 40,
    },

    /*
     * Optional short supporting message used by the new
     * CJ-only storefront design.
     *
     * This is separate from the Internal Bestseller Card model.
     */
    supportingText: {
      type: String,
      trim: true,
      default: '',
      maxlength: 180,
    },

    /*
     * Controls whether this CJ card is rendered on:
     *
     * /store/bestseller?department=cj
     */
    active: {
      type: Boolean,
      default: true,
      index: true,
    },

    /*
     * Retained for predictable left/right retrieval and
     * future administration ordering.
     */
    sortOrder: {
      type: Number,
      default: 0,
      min: 0,
      max: 1000,
    },
  },
  {
    timestamps: true,
  },
);

/*
 * Secondary index for active storefront retrieval.
 *
 * The slot field already has its own unique index.
 */
cjBestsellerCardSchema.index({
  active: 1,
  sortOrder: 1,
  createdAt: 1,
});

module.exports =
  mongoose.models.CjBestsellerCard ||
  mongoose.model(
    'CjBestsellerCard',
    cjBestsellerCardSchema,
  );