// utils/db.js
const mongoose = require("mongoose");

async function connectDB(uri) {
  try {
    await mongoose.connect(uri, { autoIndex: true });
    return mongoose;
  } catch (err) {
    const e = new Error(`Mongo connect failed: ${err && err.message}`);
    e.cause = err;
    throw e; // let caller crash start-up naturally
  }
}

mongoose.connection.on("error", (err) => {
  console.error("Mongo connection error:", err && err.message);
  // Do not process.exit() here
});

module.exports = { mongoose, connectDB };
