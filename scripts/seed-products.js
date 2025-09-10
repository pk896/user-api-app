/*scripts/seed-products.js*/
//automatically fix the image paths so they match your public folder structure.
require('dotenv').config();
const mongoose = require('mongoose');
const { fruidsData } = require('./fruidsData-node.js');
const Product = require('../models/Product.js'); // adjust path if needed

// Helper function to fix image paths
function fixImagePath(product) {
  if (product.type === 'clothes') {
    product.image = `/images/clothes-images/${product.image.split('/').pop()}`;
  } else {
    // default to fruids folder
    product.image = `/images/fruids-images/${product.image.split('/').pop()}`;
  }
  return product;
}

async function seedOrUpdateProducts() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    for (let product of fruidsData) {
      product = fixImagePath(product);

      await Product.findOneAndUpdate(
        { id: product.id },
        { $set: product },
        { upsert: true, new: true } // create if doesn't exist
      );
    }

    console.log(`✅ Seeded or updated ${fruidsData.length} products with correct image paths`);
    mongoose.connection.close();
    console.log('📦 MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error seeding/updating products:', err);
    mongoose.connection.close();
  }
}

seedOrUpdateProducts();
















/*auto update the bd*/
/*require('dotenv').config();
const mongoose = require('mongoose');
const { fruidsData } = require('./fruidsData-node.js');
const Product = require('../models/Product.js'); // make sure path is correct

async function seedOrUpdateProducts() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    for (const product of fruidsData) {
      // Update if product with same id exists, otherwise insert
      await Product.findOneAndUpdate(
        { id: product.id },
        { $set: product },
        { upsert: true, new: true } // create if doesn't exist
      );
    }

    console.log(`✅ Seeded or updated ${fruidsData.length} products`);
    mongoose.connection.close();
    console.log('📦 MongoDB connection closed');
  } catch (err) {
    console.error('❌ Error seeding/updating products:', err);
    mongoose.connection.close();
  }
}

seedOrUpdateProducts();
*/





















// scripts/seed-products.js, update everytime after changes
/*require("dotenv").config();
const mongoose = require("mongoose");
const { fruidsData } = require("./fruidsData-node.js");
const Product = require("../models/Product"); // use your Product model

async function seedProducts() {
  try {
    // ✅ Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ MongoDB connected...");

    // ✅ Clear old products
    await Product.deleteMany({});
    console.log("🗑️ Old products removed");

    // ✅ Insert new products
    await Product.insertMany(fruidsData);
    console.log(`✅ ${fruidsData.length} products seeded successfully!`);

    // ✅ Close connection
    await mongoose.connection.close();
    console.log("📦 MongoDB connection closed");
  } catch (err) {
    console.error("❌ Error seeding products:", err);
    mongoose.connection.close();
  }
}

seedProducts();*/
















// scripts/seed-products.js
/*require("dotenv").config();
const mongoose = require("mongoose");
const Product = require("../models/Product"); // adjust path if needed
const { fruidsData } = require("./fruidsData-node"); // adjust path if needed

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI)
  .then(async () => {
    console.log("✅ MongoDB connected...");

    // Clear old data
    await Product.deleteMany({});
    console.log("🗑️ Old products removed");

    // Insert new data
    await Product.insertMany(fruidsData);
    console.log("✅ Products seeded successfully!");

    mongoose.connection.close();
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
  });
*/