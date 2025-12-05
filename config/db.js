// config/db.js
const mongoose = require('mongoose');

const { MONGO_URI, NODE_ENV = 'development' } = process.env;

// Optional (recommended)
mongoose.set('strictQuery', true);

let isConnecting = false;

// Set up event listeners ONCE, before connecting
mongoose.connection.on('connected', () => {
  console.log('✅ MongoDB connected');
});

mongoose.connection.on('error', (err) => {
  console.error('🔴 Mongoose error:', err.message);
});

mongoose.connection.on('disconnected', () => {
  console.warn('🟠 Mongoose disconnected');
  
  // Only attempt reconnect if not already trying
  if (!isConnecting) {
    console.log('🔄 Attempting to reconnect in 5 seconds...');
    setTimeout(() => {
      if (mongoose.connection.readyState === 0) {
        connectDB();
      }
    }, 5000);
  }
});

// 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
async function connectDB() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in .env');
  }

  // If already connecting or connected, return
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return mongoose.connection;
  }

  isConnecting = true;
  
  try {
    await mongoose.connect(MONGO_URI, {
      autoIndex: NODE_ENV !== 'production',
      maxPoolSize: 20,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      heartbeatFrequencyMS: 10000,
      connectTimeoutMS: 30000,
      retryWrites: true,
      retryReads: true,
    });

    // Removed the console.log here - let the 'connected' event handle it
    return mongoose.connection;
  } catch (error) {
    console.error('🔴 Failed to connect to MongoDB:', error.message);
    
    // Retry connection after delay
    setTimeout(() => {
      console.log('🔄 Retrying connection...');
      connectDB();
    }, 5000);
    
    throw error;
  } finally {
    isConnecting = false;
  }
}

module.exports = connectDB;