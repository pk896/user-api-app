// models/CjShopMainBanner.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate Shop Main Banner configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference:
 *
 * - Product
 * - Product.customId
 * - ShopMainBanner
 * - Internal cart, checkout or orders
 */
const cjShopMainBannerSchema =
  new mongoose.Schema(
    {
      /*
       * There is only one CJ Shop Main Banner.
       *
       * The fixed unique key prevents accidental creation
       * of multiple CJ main-banner configurations.
       */
      singletonKey: {
        type: String,
        default: 'main',
        enum: ['main'],
        unique: true,
        index: true,
        immutable: true,
      },

      /*
       * References only CjProduct.cjProductId.
       */
      cjProductId: {
        type: String,
        required: true,
        trim: true,
        index: true,
        maxlength: 300,
      },

      title: {
        type: String,
        trim: true,
        maxlength: 80,
        default: 'SALE',
      },

      subtitle: {
        type: String,
        trim: true,
        maxlength: 160,
        default: 'Get Up To 50% Off',
      },

      buttonText: {
        type: String,
        trim: true,
        maxlength: 40,
        default: 'Shop Now',
      },

      /*
       * Admin-uploaded CJ banner artwork.
       *
       * This does not reuse the Internal ShopMainBanner image.
       */
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
    },
  );

module.exports =
  mongoose.models.CjShopMainBanner ||
  mongoose.model(
    'CjShopMainBanner',
    cjShopMainBannerSchema,
  );
