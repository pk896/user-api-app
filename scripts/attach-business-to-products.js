require("dotenv").config();
const mongoose = require("mongoose");
const { runMain } = require("./_runner");

const Business = require("../models/Business");
const Product  = require("../models/Product");

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");

  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  try {
    // 1) Pick the business to attach
    const email = process.argv[2]; // usage: node scripts/attach-business-to-products.js email@example.com
    let business;

    if (email) {
      business = await Business.findOne({ email });
      if (!business) {
        throw new Error(`❌ No business found with email: ${email}`);
      }
    } else {
      business = await Business.findOne();
      if (!business) {
        throw new Error("❌ No business found in the database.");
      }
      console.log(`⚠️ No email provided. Using first business: ${business.email}`);
    }

    console.log(`✅ Using business: ${business.name} (${business.email})`);

    // 2) Find products without a business
    const productsWithoutBusiness = await Product.find({
      $or: [{ business: null }, { business: { $exists: false } }],
    }).select("_id name");

    if (productsWithoutBusiness.length === 0) {
      console.log("⚠️ No products without a business found.");
    } else {
      console.log(`📦 Found ${productsWithoutBusiness.length} products without business.`);
      console.log("➡️ Products that will be updated:");
      for (const p of productsWithoutBusiness) {
        console.log(`   - ${p._id} | ${p.name}`);
      }

      // 3) Attach them
      const ids = productsWithoutBusiness.map((p) => p._id);
      const result = await Product.updateMany(
        { _id: { $in: ids } },
        { $set: { business: business._id } }
      );

      console.log(`🎉 Migration finished. Updated ${result.modifiedCount ?? 0} products.`);
    }

    // 4) Show ALL products linked to this business
    const linkedProducts = await Product.find({ business: business._id }).select("_id name");
    console.log(`\n✅ All products currently linked to ${business.name}:`);
    for (const p of linkedProducts) {
      console.log(`   - ${p._id} | ${p.name}`);
    }
    console.log(`📦 Total linked: ${linkedProducts.length}`);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected");
  }
}

runMain(main);
