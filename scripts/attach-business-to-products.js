// scripts/attach-business-to-products.js
require("dotenv").config();
const mongoose = require("mongoose");
const Business = require("../models/Business");
const Product = require("../models/Product");

async function main() {
  try {
    console.log("🔗 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // 1. Find the business (use first one if no email passed)
    const email = process.argv[2]; // you can run: node scripts/attach-business-to-products.js email@example.com
    let business;

    if (email) {
      business = await Business.findOne({ email });
      if (!business) {
        console.log(`❌ No business found with email: ${email}`);
        process.exit(1);
      }
    } else {
      business = await Business.findOne();
      if (!business) {
        console.log("❌ No business found in the database.");
        process.exit(1);
      }
      console.log(`⚠️ No email provided. Using first business: ${business.email}`);
    }

    console.log(`✅ Using business: ${business.name} (${business.email})`);

    // 2. Find products without business
    const productsWithoutBusiness = await Product.find({
      $or: [{ business: null }, { business: { $exists: false } }]
    });

    if (productsWithoutBusiness.length === 0) {
      console.log("⚠️ No products without a business found.");
    } else {
      console.log(`📦 Found ${productsWithoutBusiness.length} products without business.`);
      console.log("➡️ Products that will be updated:");
      productsWithoutBusiness.forEach(p => {
        console.log(`   - ${p._id} | ${p.name}`);
      });

      // 3. Update them
      const result = await Product.updateMany(
        { _id: { $in: productsWithoutBusiness.map(p => p._id) } },
        { $set: { business: business._id } }
      );

      console.log(`🎉 Migration finished. Updated ${result.modifiedCount} products.`);
    }

    // 4. Show ALL products linked to this business
    const linkedProducts = await Product.find({ business: business._id });
    console.log(`\n✅ All products currently linked to ${business.name}:`);
    linkedProducts.forEach(p => {
      console.log(`   - ${p._id} | ${p.name}`);
    });
    console.log(`📦 Total linked: ${linkedProducts.length}`);

    process.exit(0);

  } catch (err) {
    console.error("❌ Error during migration:", err);
    process.exit(1);
  }
}

main();
