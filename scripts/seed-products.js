// scripts/seed-products.js
require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const Product = require("../models/Product");
const { fruidsData } = require("./fruidsData-node.js");

/* --------------------------
 * Helpers
 * ------------------------ */
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

function detectContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

/* --------------------------
 * AWS S3 Client Setup
 * ------------------------ */
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function uploadToS3(filePath, key) {
  const fileStream = fs.createReadStream(filePath);
  const ContentType = detectContentType(filePath);

  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: fileStream,
      ContentType,
      // If your bucket policy is NOT public, you may need:
      // ACL: "public-read",
    })
  );

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

/* --------------------------
 * Main Seed Function
 * ------------------------ */
async function seedProducts() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) {
    console.error("❌ Missing MONGO_URI (.env)");
    process.exit(1);
  }
  if (!process.env.AWS_BUCKET_NAME || !process.env.AWS_REGION) {
    console.warn("⚠️ Missing AWS_BUCKET_NAME or AWS_REGION — image uploads may fail.");
  }

  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");

    // Clear products
    const del = await Product.deleteMany({});
    console.log(`🗑️ Cleared old products: ${del.deletedCount}`);

    const now = new Date();
    const created = [];
    let i = 0;

    for (const raw of fruidsData) {
      i++;

      // Pull fields from your fruidsData
      const name = raw.name || raw.title || `Product ${i}`;
      const price = Number(raw.price ?? raw.unit_price ?? 0);
      const stock = Number(raw.stock ?? raw.qty ?? 10);

      // image filename assumed at raw.image (e.g. 'apple.jpg')
      const filename = path.basename(raw.image || "");
      const localImagePath = path.join(
        __dirname,
        "../public/images/products-images",
        filename
      );

      let imageUrl = "";
      if (filename && fs.existsSync(localImagePath)) {
        try {
          const s3Key = `products-images/${filename}`;
          imageUrl = await uploadToS3(localImagePath, s3Key);
        } catch (e) {
          console.warn(`⚠️ S3 upload failed for ${filename}: ${e.message}`);
          // fallback to local path so the UI still shows images in dev
          imageUrl = `/images/products-images/${filename}`;
        }
      } else {
        console.warn(`⚠️ Image not found: ${localImagePath}`);
      }

      // Ensure unique customId (slug)
      let baseSlug = slugify(raw.customId || name);
      if (!baseSlug) baseSlug = `item-${Date.now()}-${i}`;
      let customId = baseSlug;

      // If your Product has unique index on customId, avoid duplicates
      // (rare in seeds, but good hygiene)
      let suffix = 1;
      while (await Product.findOne({ customId })) {
        customId = `${baseSlug}-${suffix++}`;
      }

      // Optional flags
      const isNew = !!raw.isNew;
      const sale = !!raw.sale;
      const popular = !!raw.popular;

      const doc = await Product.create({
        name,
        price,
        stock,
        imageUrl,   // 👈 match your views
        customId,   // 👈 match your views
        isNew,
        sale,
        popular,
        // Keep whatever your Product schema expects:
        description: raw.description || "",
        category: raw.category || raw.type || "General",
        // timestamps (if schema doesn’t auto manage)
        createdAt: now,
        updatedAt: now,
      });

      created.push(doc._id.toString());
    }

    console.log(`🍎 Seeded ${created.length} products`);
    if (created.length) {
      console.log("   e.g.", created.slice(0, 5));
    }

    await mongoose.disconnect();
    console.log("👋 Done");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error seeding products:", err);
    process.exit(1);
  }
}

seedProducts();























/*// scripts/seed-products.js
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
*/