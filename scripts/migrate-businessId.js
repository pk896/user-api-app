// scripts/migrate-businessId.js
require("dotenv").config();
const mongoose = require("mongoose");

async function migrate() {
  try {
    console.log("🔗 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const db = mongoose.connection.db;
    const collection = db.collection("products");

    // Check if products have businessId
    const count = await collection.countDocuments({ businessId: { $exists: true } });
    if (count === 0) {
      console.log("⚠️ No documents with 'businessId' found. Nothing to migrate.");
      process.exit(0);
    }

    console.log(`📦 Found ${count} products with 'businessId'. Migrating...`);

    // Migration: copy businessId → business
    const result = await collection.updateMany(
      { businessId: { $exists: true } },
      [
        {
          $set: {
            business: "$businessId"
          }
        },
        {
          $unset: "businessId"
        }
      ]
    );

    console.log(`🎉 Migration finished. Updated ${result.modifiedCount} products.`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Migration error:", err);
    process.exit(1);
  }
}

migrate();
