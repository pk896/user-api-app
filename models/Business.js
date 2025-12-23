// models/Business.js
const mongoose = require('mongoose');

function isValidEmail(v) {
  const s = String(v || '').trim();
  if (!s) return true; // allow empty (optional)
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function maskEmail(email = '') {
  const [name, domain] = String(email).split('@');
  if (!name || !domain) return email;

  const maskedName =
    name.length <= 2
      ? name[0] + '*'
      : name[0] + '*'.repeat(Math.max(1, name.length - 2)) + name[name.length - 1];

  const parts = domain.split('.');
  const domName = parts[0] || '';
  const domExt = parts.slice(1).join('.') || '';

  const maskedDomain =
    domName.length <= 2
      ? (domName[0] || '*') + '*'
      : domName[0] + '*'.repeat(Math.max(1, domName.length - 2)) + domName[domName.length - 1];

  return `${maskedName}@${maskedDomain}${domExt ? '.' + domExt : ''}`;
}

/**
 * Optional: sub-schema for payouts (no _id for cleaner docs)
 * - default ensures payouts always exists (prevents undefined checks)
 */
const payoutsSchema = new mongoose.Schema(
  {
    paypalEmail: {
      type: String,
      trim: true,
      lowercase: true,
      index: true,
      validate: {
        validator: isValidEmail,
        message: 'PayPal email must be a valid email address',
      },
    },
    enabled: { type: Boolean, default: false, index: true },
    updatedAt: { type: Date, default: null },
  },
  { _id: false },
);

const businessSchema = new mongoose.Schema(
  {
    name: { type: String, required: [true, 'Business name is required'], trim: true },

    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      trim: true,
      index: true,
      unique: true, // ✅ prevent duplicates at DB level
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
      default: 'buyer',
      index: true,
    },

    internalBusinessId: { type: String, unique: true, index: true },

    officialNumber: {
      type: String,
      required: [true, 'Business number is required'],
      trim: true,
    },

    officialNumberType: {
      type: String,
      enum: ['CIPC_REG', 'VAT', 'TIN', 'OTHER'],
      default: 'OTHER',
    },

    phone: { type: String, required: [true, 'Phone number is required'], trim: true },

    country: { type: String, required: [true, 'Country is required'], trim: true },
    city: { type: String, required: [true, 'City is required'], trim: true },
    address: { type: String, required: [true, 'Business address is required'], trim: true },

    representative: {
      fullName: { type: String, required: [true, 'Representative full name is required'], trim: true },
      phone: { type: String, required: [true, 'Representative phone is required'], trim: true },
      idNumber: { type: String, required: [true, 'Representative ID number is required'], trim: true },
    },

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
        enum: ['bank', 'paypal', 'payoneer', 'wise', 'other'], // ✅ matches your routes
        default: 'bank',
      },
      updatedAt: { type: Date, default: null },
    },

    /**
     * ✅ Payouts (PayPal email used by payouts flow)
     * - payouts always exists due to default
     * - paypalEmail is optional, validated when present
     */
    payouts: {
      type: payoutsSchema,
      default: () => ({ enabled: false, updatedAt: null }),
    },

    verification: {
      status: {
        type: String,
        enum: ['unverified', 'pending', 'verified', 'rejected'],
        default: 'pending',
        index: true,
      },
      method: { type: String, enum: ['manual', 'documents', 'registry', 'vat'], default: 'manual' },
      provider: { type: String, default: 'manual' },
      checkedAt: { type: Date, default: null },
      verifiedAt: { type: Date, default: null },
      reason: { type: String, default: '' },
      updatedAt: { type: Date, default: null },
    },

    isVerified: { type: Boolean, default: false, index: true },
    emailVerifiedAt: { type: Date, default: null },
    emailVerificationToken: { type: String, index: true },
    emailVerificationExpires: { type: Date, default: null },
    verificationEmailSentAt: { type: Date, default: null },

    welcomeEmailSentAt: { type: Date, default: null, index: true },
    officialNumberVerifiedEmailSentAt: { type: Date, default: null, index: true },
    officialNumberRejectedEmailSentAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// ✅ optional helper index for admin payouts lists
businessSchema.index({ 'payouts.enabled': 1, 'payouts.updatedAt': -1 });

businessSchema.methods.toSafeJSON = function () {
  const obj = this.toObject({ virtuals: false });

  // Never leak secrets
  delete obj.password;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;

  // Bank details: keep safe subset + mask account number
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
      updatedAt: bd.updatedAt || null,
    };

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

  // Payouts: do NOT leak real PayPal email in views/APIs (use DB doc/select for payouts logic)
  if (obj.payouts && obj.payouts.paypalEmail) {
    obj.payouts = {
      ...obj.payouts,
      paypalEmailMasked: maskEmail(obj.payouts.paypalEmail),
      paypalEmail: undefined,
    };
  }

  return obj;
};

module.exports = mongoose.model('Business', businessSchema);

