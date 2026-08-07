// models/CjHomeMidBanner.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate Home Mid Banner configuration
 * for the Kasyora CJ Store.
 *
 * The same left and right CJ banner records will be used on:
 *
 * - /store?department=cj
 * - /store/shop?department=cj
 *
 * This model must never reference:
 *
 * - Product
 * - Product.customId
 * - HomeMidBanner
 * - Internal Kasyora commerce records
 */
const cjHomeMidBannerSchema = new mongoose.Schema(
  {
    /*
     * Only one left banner and one right banner
     * may exist for the CJ storefront.
     */
    slot: {
      type: String,

      required: true,

      enum: [
        'left',
        'right',
      ],

      unique: true,

      trim: true,
    },

    /*
     * Public CJ product identifier.
     *
     * This must contain CjProduct.cjProductId only.
     * It must never contain an Internal Product.customId.
     */
    cjProductId: {
      type: String,

      required: true,

      trim: true,

      maxlength: 300,

      index: true,
    },

    title: {
      type: String,

      trim: true,

      maxlength: 120,

      default: '',
    },

    subtitle: {
      type: String,

      trim: true,

      maxlength: 160,

      default: '',
    },

    priceText: {
      type: String,

      trim: true,

      maxlength: 80,

      default: '',
    },

    buttonText: {
      type: String,

      trim: true,

      maxlength: 40,

      default: 'Shop Now',
    },

    /*
     * Admin-uploaded banner image stored in S3.
     */
    image: {
      type: String,

      required: true,

      trim: true,

      maxlength: 2000,
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

    minimize: false,
  },
);

/*
 * Defensive index supporting active banner loading
 * in left-to-right display order.
 */
cjHomeMidBannerSchema.index({
  active: 1,

  sortOrder: 1,

  slot: 1,
});

module.exports =
  mongoose.models.CjHomeMidBanner ||
  mongoose.model(
    'CjHomeMidBanner',
    cjHomeMidBannerSchema,
  );
