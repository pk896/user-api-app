// config/db.js
'use strict';

const mongoose = require('mongoose');

const { MONGO_URI, NODE_ENV = 'development' } = process.env;

mongoose.set('strictQuery', true);

let isConnecting = false;
let reconnectTimer = null;
let listenersAttached = false;
let reconnectDelayMs = 5000;
const MAX_RECONNECT_DELAY_MS = 30000;

// 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
function readyStateLabel(state) {
  return (
    {
      0: 'disconnected',
      1: 'connected',
      2: 'connecting',
      3: 'disconnecting',
    }[state] || `unknown(${state})`
  );
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(reason = 'unknown') {
  // Do not schedule if already connected/connecting
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return;
  }

  // Prevent multiple timers
  if (reconnectTimer) {
    return;
  }

  console.log(`🔄 Reconnect scheduled in ${Math.floor(reconnectDelayMs / 1000)}s (${reason})...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;

    // Safety checks before reconnecting
    if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2 || isConnecting) {
      return;
    }

    try {
      await connectDB();
      // If connect succeeds, reset backoff
      reconnectDelayMs = 5000;
    } catch {
      // connectDB handles logging; no throw here
      // Exponential backoff up to max
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
      scheduleReconnect('previous reconnect failed');
    }
  }, reconnectDelayMs);
}

function attachConnectionListenersOnce() {
  if (listenersAttached) return;
  listenersAttached = true;

  mongoose.connection.on('connected', () => {
    clearReconnectTimer();
    reconnectDelayMs = 5000;
    console.log('✅ MongoDB connected');
  });

  mongoose.connection.on('error', (err) => {
    console.error('🔴 Mongoose error:', err.message);
    // Do NOT call connectDB directly here; wait for disconnected or scheduled retry
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('🟠 Mongoose disconnected');
    scheduleReconnect('disconnected event');
  });

  // Optional extra visibility
  mongoose.connection.on('reconnected', () => {
    clearReconnectTimer();
    reconnectDelayMs = 5000;
    console.log('🟢 Mongoose reconnected');
  });
}

async function connectDB() {
  if (!MONGO_URI) {
    throw new Error('MONGO_URI is not defined in .env');
  }

  attachConnectionListenersOnce();

  // Already connected or connecting
  if (mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) {
    return mongoose.connection;
  }

  // Prevent parallel connect attempts
  if (isConnecting) {
    return mongoose.connection;
  }

  isConnecting = true;

  try {
    await mongoose.connect(MONGO_URI, {
      autoIndex: NODE_ENV !== 'production',

      // Pool sizing (minPoolSize can keep pressure on Atlas; use 0 unless needed)
      maxPoolSize: 10,
      minPoolSize: 0,

      // Timeouts
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      connectTimeoutMS: 30000,
      heartbeatFrequencyMS: 10000,

      // Reliability
      retryWrites: true,
      retryReads: true,
    });

    return mongoose.connection;
  } catch (error) {
    console.error(
      `🔴 Failed to connect to MongoDB (${readyStateLabel(mongoose.connection.readyState)}):`,
      error.message
    );

    // Important: schedule retry, but DO NOT create duplicate timers
    scheduleReconnect('initial connect failed');

    // Important: do not throw during reconnect loops (prevents unhandled rejection spam)
    // If this is the first startup call, returning null lets app continue logs cleanly.
    return null;
  } finally {
    isConnecting = false;
  }
}

module.exports = connectDB;