// models/CjShopSidebarBanner.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely separate Shop Sidebar Banner configuration
 * for the Kasyora CJ Store.
 *
 * This model must never reference:
 *
 * - Product
 * - Product.customId
 * - ShopSidebarBanner
 * - Internal Kasyora cart, checkout or orders
 *
 * The linked product is identified only by:
 *
 * - CjProduct.cjProductId
 */
const cjShopSidebarBannerSchema = new mongoose.Schema(
  {
    /*
     * Links only to CjProduct.cjProductId.
     *
     * We intentionally do not use a Mongoose ObjectId reference,
     * because CJ catalogue identity is controlled by cjProductId.
     */
    cjProductId: {
      type: String,
      required: [true, 'CJ product ID is required'],
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
      default: 'Get UP To 50% Off',
    },

    buttonText: {
      type: String,
      trim: true,
      maxlength: 40,
      default: 'Shop Now',
    },

    /*
     * Admin-uploaded sidebar banner image.
     *
     * This remains separate from the linked CJ product image.
     */
    image: {
      type: String,
      required: [true, 'Banner image is required'],
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

/*
 * Only one CJ Shop Sidebar Banner configuration should exist.
 *
 * The admin flow will update the latest record instead of
 * creating multiple active CJ sidebar banners.
 */
cjShopSidebarBannerSchema.index({
  active: 1,
  updatedAt: -1,
});

module.exports =
  mongoose.models.CjShopSidebarBanner ||
  mongoose.model(
    'CjShopSidebarBanner',
    cjShopSidebarBannerSchema,
  );
