// utils/db.js
const mongoose = require('mongoose');

const MONGO_URL = process.env.MONGO_URI || process.env.MONGODB_URI; // 👈 accept both
if (!MONGO_URL) {
  console.error('❌ MONGO_URI / MONGODB_URI missing in .env');
  process.exit(1);
}

const opts = {
  maxPoolSize: 10,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  heartbeatFrequencyMS: 10000,
  retryWrites: true,
  autoIndex: true,
};

let hasConnectedOnce = false;

mongoose.connection.on('connecting', () => console.log('[mongoose] connecting...'));
mongoose.connection.on('connected',  () => { hasConnectedOnce = true; console.log('[mongoose] connected'); });
mongoose.connection.on('reconnected', () => console.log('✅ mongoose reconnected'));
mongoose.connection.on('disconnected', () => { if (hasConnectedOnce) console.warn('⚠️ mongoose disconnected'); });
mongoose.connection.on('error', (err) => console.error('❌ mongoose error:', err.message));

async function connectWithRetry() {
  try {
    await mongoose.connect(MONGO_URL, opts);
  } catch (err) {
    console.error('❌ initial connect failed:', err.message);
    setTimeout(connectWithRetry, 3000);
  }
}

module.exports = { connectWithRetry };
