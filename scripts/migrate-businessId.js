require("dotenv").config();
const mongoose = require("mongoose");
const { runMain } = require("./_runner");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");

  console.log("🔗 Connecting to MongoDB…");
  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  const db = mongoose.connection.db;
  const collection = db.collection("products");

  // 1) Check how many docs have businessId
  const count = await collection.countDocuments({ businessId: { $exists: true } });
  if (count === 0) {
    console.log("⚠️ No documents with 'businessId' found. Nothing to migrate.");
    return; // just finish, no exit()
  }

  console.log(`📦 Found ${count} products with 'businessId'. Migrating…`);

  // 2) Migration: copy businessId -> business, then unset businessId
  // Prefer pipeline updates (MongoDB 4.2+)
  let modified = 0;
  try {
    const result = await collection.updateMany(
      { businessId: { $exists: true } },
      [
        { $set: { business: "$businessId" } },
        { $unset: "businessId" },
      ]
    );
    modified = result.modifiedCount ?? 0;
  } catch (e) {
    // Fallback for older Mongo: do it in two passes
    console.warn("⚠️ Pipeline update failed; attempting two-step fallback:", e.message);
    const setRes = await collection.updateMany(
      { businessId: { $exists: true } },
      { $set: { business: "$businessId" } } // Note: this form won't copy field value pre-4.2
    );

    // If your server is <4.2, copying with $set: { business: "$businessId" } won't work.
    // Do a manual copy with a cursor:
    const cursor = collection.find({ businessId: { $exists: true } }, { projection: { businessId: 1 } });
    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      await collection.updateOne(
        { _id: doc._id },
        { $set: { business: doc.businessId } }
      );
    }

    const unsetRes = await collection.updateMany(
      { businessId: { $exists: true } },
      { $unset: { businessId: "" } }
    );
    modified = unsetRes.modifiedCount ?? 0;
  }

  console.log(`🎉 Migration finished. Updated ${modified} products.`);
}

runMain(async () => {
  try {
    await main();
  } finally {
    // Ensure we always close the connection
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log("👋 Disconnected");
    }
  }
});
