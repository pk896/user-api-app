// scripts/seed-products.js
require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const Product = require("../models/Product");
const { fruidsData } = require("./fruidsData-node.js");

// --------------------------
// AWS S3 Client Setup
// --------------------------
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// --------------------------
// Upload Helper
// --------------------------
async function uploadToS3(filePath, key) {
  const fileStream = fs.createReadStream(filePath);

  const uploadParams = {
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: fileStream,
    ContentType: "image/jpeg", // fallback, can adjust later
  };

  await s3.send(new PutObjectCommand(uploadParams));

  // Return public S3 URL
  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

// --------------------------
// Seed Function
// --------------------------
async function seedProducts() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log("✅ Connected to MongoDB");

    await Product.deleteMany();
    console.log("🗑️ Cleared old products");

    const productsWithUrls = [];

    for (const product of fruidsData) {
      // Extract filename from product.image
      const filename = path.basename(product.image);

      // Local path (from public/images/products-images)
      const localImagePath = path.join(__dirname, "../public/images/products-images", filename);

      if (!fs.existsSync(localImagePath)) {
        console.warn(`⚠️ Skipping ${filename} - file not found`);
        continue;
      }

      // Key for S3 bucket
      const s3Key = `products-images/${filename}`;

      // Upload to S3
      const imageUrl = await uploadToS3(localImagePath, s3Key);

      // Save product with S3 URL
      const newProduct = {
        ...product,
        image: imageUrl,
      };

      const savedProduct = await Product.create(newProduct);
      productsWithUrls.push(savedProduct);
    }

    console.log(`🍎 Seeded ${productsWithUrls.length} products`);
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding products:", err);
    process.exit(1);
  }
}

seedProducts();
