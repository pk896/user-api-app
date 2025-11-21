// db.js
// Shared mongoose shim for all models.
// ❗ Do NOT call mongoose.connect() here — connection happens in utils/db.js.

const mongoose = require('mongoose');

// Dual export for compatibility:
// - Destructured:  const { mongoose } = require('../db')
// - Direct:        const mongoose = require('../db')
module.exports = mongoose;
module.exports.mongoose = mongoose;
