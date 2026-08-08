// models/BusinessLoginHeaderImage.js
'use strict';

const mongoose = require('mongoose');

/*
 * Completely standalone header-image configuration
 * for the Kasyora Business Login page.
 *
 * Used only by:
 *
 * - /business/login
 *
 * This model must never reuse or depend on:
 *
 * - ShopHeaderImage
 * - BusinessSignupHeaderImage
 * - KasyoraHomeHeaderImage
 * - Store banner models
 * - CJ storefront banner models
 */
const businessLoginHeaderImageSchema =
  new mongoose.Schema(
    {
      /*
       * Kasyora has exactly one Business Login
       * Header Image configuration.
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
  mongoose.models.BusinessLoginHeaderImage ||
  mongoose.model(
    'BusinessLoginHeaderImage',
    businessLoginHeaderImageSchema,
  );