// models/KasyoraHomeHeaderImage.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely standalone header-image configuration
 * for the main Kasyora Home page.
 *
 * Used only by:
 *
 * - /home
 *
 * This model must never reuse or depend on:
 *
 * - ShopHeaderImage
 * - BusinessSignupHeaderImage
 * - ShopMainBanner
 * - CJ storefront banner models
 */
const kasyoraHomeHeaderImageSchema =
  new mongoose.Schema(
    {
      /*
       * Kasyora has exactly one Home Header Image
       * configuration.
       *
       * The fixed singleton key prevents accidental
       * creation of multiple Home-header records.
       */
      singletonKey: {
        type: String,
        default: 'main',
        enum: ['main'],
        unique: true,
        index: true,
        immutable: true,
      },

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
    },
    {
      timestamps: true,
    },
  );

module.exports =
  mongoose.models.KasyoraHomeHeaderImage ||
  mongoose.model(
    'KasyoraHomeHeaderImage',
    kasyoraHomeHeaderImageSchema,
  );
