// models/User.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const userSchema = new Schema(
  {
    // Display name shown in the UI
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },

    // Login username (separate from email)
    // We enforce this on new LOCAL signups in the route (not required for old docs)
    username: {
      type: String,
      trim: true,
      minlength: 3,
      maxlength: 50,
      index: { unique: true, sparse: true }, // sparse → old users without username still work
    },

    // Primary contact / verification email (Gmail, Outlook, etc.)
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      validate: {
        validator(value) {
          return emailRegex.test(value);
        },
        message: 'Please provide a valid email address.',
      },
    },

    // Optional age (you validate 16–120 in the route)
    age: {
      type: Number,
      min: 0,
      max: 120,
    },

    // Hashed password for local login (bcrypt hash)
    passwordHash: {
      type: String,
      default: null,
    },

    /**
     * Provider:
     *  - "local"  → email/username + password only
     *  - "google" → Google only
     *  - "both"   → account linked: can use local OR Google
     */
    provider: {
      type: String,
      enum: ['local', 'google', 'both'],
      default: 'local',
    },

    // Google OAuth ID (sub / profile.id)
    googleId: {
      type: String,
      index: true,
      default: null,
    },

    // Legacy / generic providerId if you used it elsewhere
    providerId: {
      type: String,
      default: null,
    },

    // Has this email been verified (via email link or trusted provider)?
    isEmailVerified: {
      type: Boolean,
      default: false,
    },

    // Email verification flow
    emailVerificationToken: {
      type: String,
      default: null,
      index: true,
    },
    emailVerificationExpires: {
      type: Date,
      default: null,
    },

    // Password reset flow (used by /users/password/* routes)
    resetPasswordToken: {
      type: String,
      default: null,
      index: true,
    },
    resetPasswordExpires: {
      type: Date,
      default: null,
    },

    // Last time the user successfully logged in
    lastLogin: {
      type: Date,
      default: null,
    },

    // Simple email preferences for future use
    emailPreferences: {
      important: {
        type: Boolean,
        default: true, // system emails, security, orders, etc.
      },
      marketing: {
        type: Boolean,
        default: false, // promos, newsletters, etc.
      },
    },
  },
  {
    timestamps: true, // createdAt, updatedAt
  },
);

// Unique index on email (professional requirement)
userSchema.index({ email: 1 }, { unique: true });

// Optional: normalize email & trim name before save
userSchema.pre('save', function (next) {
  if (this.email) {
    this.email = this.email.trim().toLowerCase();
  }
  if (this.username) {
    this.username = this.username.trim();
  }
  if (this.name) {
    this.name = this.name.trim();
  }
  next();
});

// Convenience helper: mark email as verified
userSchema.methods.markEmailVerified = function () {
  this.isEmailVerified = true;
  this.emailVerificationToken = null;
  this.emailVerificationExpires = null;
};

module.exports = mongoose.model('User', userSchema);