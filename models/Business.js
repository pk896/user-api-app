// models/Business.js
//const { mongoose } = require('../db'); // <-- use the shared instance
const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Business name is required'],
      trim: true,
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      //unique: true, // ✅ unique index
      lowercase: true,
      trim: true,
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters long'],
    },

    role: {
      type: String,
      enum: ['seller', 'supplier', 'buyer'],
      required: [true, 'Role is required'],
      default: 'buyer', // safest default
      index: true,
    },

    businessNumber: {
      type: String,
      required: [true, 'Business number is required'],
      trim: true,
    },

    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },

    country: {
      type: String,
      required: [true, 'Country is required'],
      trim: true,
    },

    city: {
      type: String,
      required: [true, 'City is required'],
      trim: true,
    },

    address: {
      type: String,
      required: [true, 'Business address is required'],
      trim: true,
    },

    idOrPassport: {
      type: String,
      required: [true, 'ID or Passport number is required'],
      trim: true,
    },

    // 🔐 Email verification fields (same idea as user flow)
    isVerified: {
      type: Boolean,
      default: false,
      index: true,
    },

    emailVerificationToken: {
      type: String,
      index: true,
    },

    emailVerificationExpires: {
      type: Date,
    },

    verifiedAt: {
      type: Date,
    },

    verificationEmailSentAt: {
      type: Date,
    },
  },
  { timestamps: true },
);

// --------------------------
// Safe JSON output (hide password)
// --------------------------
businessSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

module.exports = mongoose.model('Business', businessSchema);
