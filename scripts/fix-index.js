// scripts/fix-index.js
require("dotenv").config();
const mongoose = require("mongoose");

async function fixIndex() {
  await mongoose.connect(process.env.MONGO_URI);
  const result = await mongoose.connection.db.collection("products").dropIndex("id_1");
  console.log("✅ Dropped old index:", result);
  await mongoose.disconnect();
}

fixIndex().catch(err => console.error("❌ Failed:", err));
