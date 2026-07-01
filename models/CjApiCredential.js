// models/CjApiCredential.js
'use strict';

const mongoose = require('mongoose');

const cjApiCredentialSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      unique: true,
      index: true,
      immutable: true,
    },

    accessToken: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },

    refreshToken: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },

    accessTokenExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    refreshTokenExpiresAt: {
      type: Date,
      default: null,
      index: true,
    },

    openId: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },

    lastAuthenticatedAt: {
      type: Date,
      default: null,
    },

    lastRefreshedAt: {
      type: Date,
      default: null,
    },

    lastSuccessfulRequestAt: {
      type: Date,
      default: null,
    },

    lastHealthCheckAt: {
      type: Date,
      default: null,
    },

    lastHealthCheckStatus: {
      type: String,
      enum: ['NOT_TESTED', 'HEALTHY', 'FAILED'],
      default: 'NOT_TESTED',
      index: true,
    },

    lastErrorCode: {
      type: String,
      trim: true,
      default: '',
    },

    lastErrorMessage: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    lastRequestId: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

cjApiCredentialSchema.methods.hasUsableAccessToken = function hasUsableAccessToken(
  bufferMs = 5 * 60 * 1000,
) {
  if (!this.accessToken || !this.accessTokenExpiresAt) {
    return false;
  }

  return this.accessTokenExpiresAt.getTime() - bufferMs > Date.now();
};

cjApiCredentialSchema.methods.hasUsableRefreshToken =
  function hasUsableRefreshToken(bufferMs = 24 * 60 * 60 * 1000) {
    if (!this.refreshToken || !this.refreshTokenExpiresAt) {
      return false;
    }

    return this.refreshTokenExpiresAt.getTime() - bufferMs > Date.now();
  };

module.exports = mongoose.model('CjApiCredential', cjApiCredentialSchema);
