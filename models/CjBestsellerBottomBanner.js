// models/CjBestsellerBottomBanner.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate Bestseller Bottom Banner configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference:
 *
 * - BestsellerBottomBanner
 * - Product
 * - Product.customId
 * - productCustomId
 *
 * Each record links only to an imported CjProduct by cjProductId.
 */
const cjBestsellerBottomBannerSchema =
  new mongoose.Schema(
    {
      /*
       * Only one left record and one right record may exist.
       */
      slot: {
        type: String,
        enum: [
          'left',
          'right',
        ],
        required: true,
        unique: true,
        trim: true,
      },

      /*
       * Separate CJ catalogue identifier.
       *
       * This value must match CjProduct.cjProductId.
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
        default: '',
        maxlength: 120,
      },

      subtitle: {
        type: String,
        trim: true,
        default: '',
        maxlength: 160,
      },

      /*
       * Optional marketing text entered by the administrator.
       *
       * This is not used as an accounting or checkout price.
       */
      priceText: {
        type: String,
        trim: true,
        default: '',
        maxlength: 80,
      },

      buttonText: {
        type: String,
        trim: true,
        default: 'Shop Now',
        maxlength: 40,
      },

      /*
       * Separate uploaded banner image.
       */
      image: {
        type: String,
        trim: true,
        default: '',
        maxlength: 1000,
      },

      /*
       * Existing Bestseller page markup may use this exact
       * inline overlay style.
       */
      overlayStyle: {
        type: String,
        trim: true,
        default: '',
        maxlength: 500,
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
    {
      timestamps: true,
    },
  );

/*
 * Normalize important string values before validation and save.
 */
cjBestsellerBottomBannerSchema.pre(
  'validate',
  function normalizeCjBestsellerBottomBanner(
    next,
  ) {
    this.slot =
      String(
        this.slot || '',
      )
        .trim()
        .toLowerCase();

    this.cjProductId =
      String(
        this.cjProductId || '',
      ).trim();

    this.title =
      String(
        this.title || '',
      ).trim();

    this.subtitle =
      String(
        this.subtitle || '',
      ).trim();

    this.priceText =
      String(
        this.priceText || '',
      ).trim();

    this.buttonText =
      String(
        this.buttonText || '',
      ).trim() ||
      'Shop Now';

    this.image =
      String(
        this.image || '',
      ).trim();

    this.overlayStyle =
      String(
        this.overlayStyle || '',
      ).trim();

    const numericSortOrder =
      Number(
        this.sortOrder,
      );

    this.sortOrder =
      Number.isFinite(
        numericSortOrder,
      )
        ? numericSortOrder
        : 0;

    next();
  },
);

module.exports =
  mongoose.models
    .CjBestsellerBottomBanner ||
  mongoose.model(
    'CjBestsellerBottomBanner',
    cjBestsellerBottomBannerSchema,
  );