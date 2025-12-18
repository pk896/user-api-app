// models/Business.js
const mongoose = require('mongoose');

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Business name is required'], trim: true },

    email: { type: String, required: [true, 'Email is required'], lowercase: true, trim: true, index: true },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters long'],
    },

    role: {
      type: String,
      enum: ['seller', 'supplier', 'buyer'],
      required: [true, 'Role is required'],
      default: 'buyer',
      index: true,
    },

    // ✅ internal stable id (global)
    internalBusinessId: { type: String, unique: true, index: true },

    // This is your official number (global)
    officialNumber: { type: String, required: [true, 'Business number is required'], trim: true },

    officialNumberType: {
      type: String,
      enum: ['CIPC_REG', 'VAT', 'TIN', 'OTHER'],
      default: 'OTHER',
    },

    phone: { type: String, required: [true, 'Phone number is required'], trim: true },

    country: { type: String, required: [true, 'Country is required'], trim: true },
    city: { type: String, required: [true, 'City is required'], trim: true },
    address: { type: String, required: [true, 'Business address is required'], trim: true },

    // ✅ Authorized Representative (person creating the account)
    representative: {
      fullName: { type: String, required: [true, 'Representative full name is required'], trim: true },
      phone: { type: String, required: [true, 'Representative phone is required'], trim: true },
      idNumber: { type: String, required: [true, 'Representative ID number is required'], trim: true },
    },

    // 💳 Bank details (for payouts)
    bankDetails: {
      accountHolderName: { type: String, trim: true },
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      branchCode: { type: String, trim: true },
      swiftCode: { type: String, trim: true },
      iban: { type: String, trim: true },
      accountType: { type: String, trim: true },
      currency: { type: String, trim: true },
      payoutMethod: {
        type: String,
        enum: ['bank', 'paypal', 'other'],
        default: 'bank',
      },
      updatedAt: { type: Date },
    },

    // ✅ removed: idOrPassport

    verification: {
      status: {
        type: String,
        enum: ['unverified', 'pending', 'verified', 'rejected'],
        default: 'pending',
        index: true,
      },
      method: { type: String, enum: ['manual', 'documents', 'registry', 'vat'], default: 'manual' },
      provider: { type: String, default: 'manual' },
      checkedAt: Date,
      verifiedAt: Date,
      reason: String,
    },

    // Email verification (your existing flow)
    isVerified: { type: Boolean, default: false, index: true },
    emailVerifiedAt: { type: Date },
    emailVerificationToken: { type: String, index: true },
    emailVerificationExpires: { type: Date },
    verificationEmailSentAt: { type: Date },

    // ✅ prevents sending the “welcome after verify-email” twice
    welcomeEmailSentAt: { type: Date, default: null, index: true },

    // ✅ prevent sending verification-status emails twice
    officialNumberVerifiedEmailSentAt: { type: Date, default: null, index: true },
    officialNumberRejectedEmailSentAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

/**
 * ✅ Safe JSON for sending to views/APIs
 * - Keep password/id/token hidden
 * - Prevent bank data leaks: only keep holder name + masked/last4
 */
businessSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();

  // Sensitive
  delete obj.password;
  delete obj.emailVerificationToken;

  // ✅ Bank details: prevent leaks in views/APIs
  if (obj.bankDetails) {
    const bd = obj.bankDetails || {};

    const safeBankDetails = {
      accountHolderName: bd.accountHolderName || '',
      bankName: bd.bankName || '',
      payoutMethod: bd.payoutMethod || 'bank',
      currency: bd.currency || '',
      accountType: bd.accountType || '',
      branchCode: bd.branchCode || '',
      swiftCode: bd.swiftCode || '',
      iban: bd.iban || '',
      updatedAt: bd.updatedAt,
    };

    // Mask account number -> last4 only
    if (bd.accountNumber) {
      const s = String(bd.accountNumber).replace(/\s+/g, '');
      safeBankDetails.accountNumberLast4 = s.length >= 4 ? s.slice(-4) : '';
      safeBankDetails.accountNumberMasked = s.length >= 4 ? `****${s.slice(-4)}` : '****';
    } else {
      safeBankDetails.accountNumberLast4 = '';
      safeBankDetails.accountNumberMasked = '****';
    }

    obj.bankDetails = safeBankDetails;
  }

  return obj;
};

module.exports = mongoose.model('Business', businessSchema);
