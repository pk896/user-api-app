// models/KasyoraHomeHeaderImage.js
'use strict';

const mongoose = require('mongoose');

const kasyoraHomeHeaderImageSchema =
  new mongoose.Schema(
    {
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
  mongoose.models.KasyoraHomeHeaderImage ||
  mongoose.model(
    'KasyoraHomeHeaderImage',
    kasyoraHomeHeaderImageSchema,
  );
