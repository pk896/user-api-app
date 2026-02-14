// models/BusinessResetToken.js
'use strict';

//const { mongoose } = require('../db');
const mongoose = require('mongoose');

const businessResetTokenSchema = new mongoose.Schema(
  {
    businessId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
    token: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// TTL index – document auto-removes when expiresAt < now
businessResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.BusinessResetToken ||
  mongoose.model('BusinessResetToken', businessResetTokenSchema);
