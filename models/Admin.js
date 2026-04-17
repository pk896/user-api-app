// models/Admin.js
'use strict';

const mongoose = require('mongoose');
const { ADMIN_ROLES, getPermissionsForRole } = require('../utils/adminRoles');

const adminSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Admin full name is required'],
      trim: true,
    },

    email: {
      type: String,
      required: [true, 'Admin email is required'],
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },

    username: {
      type: String,
      required: [true, 'Admin username is required'],
      trim: true,
      lowercase: true,
      unique: true,
      index: true,
    },

    passwordHash: {
      type: String,
      required: [true, 'Admin password hash is required'],
    },

    role: {
      type: String,
      enum: ADMIN_ROLES,
      required: [true, 'Admin role is required'],
      index: true,
    },

    permissions: {
      type: [String],
      default: [],
    },

    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    mustChangePassword: {
      type: Boolean,
      default: false,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },

    lastLoginIp: {
      type: String,
      default: '',
      trim: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },

    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

adminSchema.pre('validate', function (next) {
  this.email = String(this.email || '').trim().toLowerCase();
  this.username = String(this.username || '').trim().toLowerCase();

  if (!Array.isArray(this.permissions) || this.permissions.length === 0) {
    this.permissions = getPermissionsForRole(this.role);
  }

  next();
});

module.exports = mongoose.models.Admin || mongoose.model('Admin', adminSchema);
