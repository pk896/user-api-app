// models/AdminAuditLog.js
'use strict';

const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema(
  {
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },

    adminIdentifier: {
      type: String,
      default: '',
      trim: true,
    },

    adminName: {
      type: String,
      default: '',
      trim: true,
    },

    adminEmail: {
      type: String,
      default: '',
      trim: true,
      lowercase: true,
    },

    adminRole: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },

    action: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    entityType: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },

    entityId: {
      type: String,
      default: '',
      trim: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['success', 'failure'],
      default: 'success',
      index: true,
    },

    before: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    after: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    meta: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    ipAddress: {
      type: String,
      default: '',
      trim: true,
    },

    userAgent: {
      type: String,
      default: '',
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports =
  mongoose.models.AdminAuditLog ||
  mongoose.model('AdminAuditLog', adminAuditLogSchema);
