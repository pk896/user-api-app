// models/ResetToken.js
const { mongoose } = require("../db");

const resetTokenSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    token: { type: String, required: true, unique: true },
    // TTL by 'expiresAt' only—do NOT also declare index: true on the path itself
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Single TTL index (expiresAt)
resetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.ResetToken || mongoose.model("ResetToken", resetTokenSchema);
