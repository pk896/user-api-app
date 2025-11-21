require("dotenv").config();
const mongoose = require("mongoose");
const { runMain } = require("./_runner");

const Order = require("../models/Order");
const Product = require("../models/Product");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  try {
    // Build a map of productId -> businessId
    const prods = await Product.find().select("_id business").lean();
    const owner = new Map(prods.map((p) => [String(p._id), String(p.business)]));

    // Find orders where items[].businessId is missing
    const orders = await Order.find({ "items.businessId": { $exists: false } });
    console.log(`🔎 Orders needing backfill: ${orders.length}`);

    let updated = 0;

    for (const o of orders) {
      let changed = false;

      for (const it of o.items || []) {
        if (!it.businessId && it.productId) {
          const b = owner.get(String(it.productId));
          if (b) {
            it.businessId = b; // set
            changed = true;
          }
        }
      }

      if (changed) {
        await o.save();
        updated += 1;
      }
    }

    console.log(`✅ Done backfilling. Orders updated: ${updated}`);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected");
  }
}

runMain(main);
