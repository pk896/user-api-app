// models/User.js
const { mongoose } = require('../db');
const bcrypt = require('bcrypt');

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, minlength: 2, maxlength: 80, required: true },
    email: { type: String, unique: true, lowercase: true, trim: true, required: true },
    age: {
      type: Number,
      min: [16, 'You must be at least 16 years old.'],
      max: [120, 'Please enter a valid age.'],
      validate: {
        validator: (v) => v == null || Number.isInteger(v),
        message: 'Age must be a whole number.',
      },
    },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);

// Helpers
userSchema.methods.setPassword = async function setPassword(plain) {
  const saltRounds = 12;
  this.passwordHash = await bcrypt.hash(String(plain), saltRounds);
};

userSchema.methods.verifyPassword = async function verifyPassword(plain) {
  if (!this.passwordHash || typeof this.passwordHash !== 'string') {return false;}
  return bcrypt.compare(String(plain), this.passwordHash);
};

module.exports = mongoose.models.User || mongoose.model('User', userSchema);
