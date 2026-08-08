// models/BusinessSignupHeaderImage.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely standalone header-image configuration
 * for the Kasyora Business Signup page.
 *
 * Used only by:
 *
 * - /business/signup
 *
 * This model must never reuse or depend on:
 *
 * - ShopHeaderImage
 * - KasyoraHomeHeaderImage
 * - ShopMainBanner
 * - CJ storefront banner models
 */
const businessSignupHeaderImageSchema =
  new mongoose.Schema(
    {
      /*
       * Kasyora has one Business Signup Header Image.
       *
       * The fixed singleton key prevents accidental creation
       * of multiple signup-header configurations.
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
       * Admin-uploaded signup-page background image stored in S3.
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
    },
    {
      timestamps: true,
    },
  );

module.exports =
  mongoose.models.BusinessSignupHeaderImage ||
  mongoose.model(
    'BusinessSignupHeaderImage',
    businessSignupHeaderImageSchema,
  );