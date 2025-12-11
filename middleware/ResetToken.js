// models/ResetToken.js
const mongoose = require('mongoose');

const resetTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    token: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { timestamps: true },
);

// Auto-delete expired docs (TTL)
resetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ✅ SAFE EXPORT
module.exports = mongoose.models.ResetToken || mongoose.model('ResetToken', resetTokenSchema);
