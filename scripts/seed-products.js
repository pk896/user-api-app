require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");
const fs = require("fs");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { runMain } = require("./_runner");

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
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      }
    : undefined, // allows instance/profile credentials too
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
      // ACL: "public-read", // uncomment only if your bucket policy requires it
    })
  );

  return `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

/* --------------------------
 * Main
 * ------------------------ */
async function main() {
  const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!MONGO_URI) {
    throw new Error("❌ Missing MONGO_URI (.env)");
  }
  if (!process.env.AWS_BUCKET_NAME || !process.env.AWS_REGION) {
    console.warn("⚠️ Missing AWS_BUCKET_NAME or AWS_REGION — image uploads may fail.");
  }

  await mongoose.connect(MONGO_URI);
  console.log("✅ Connected to MongoDB");

  try {
    // Clear products (optional)
    const del = await Product.deleteMany({});
    console.log(`🗑️ Cleared old products: ${del.deletedCount}`);

    const now = new Date();
    const createdIds = [];
    let i = 0;

    for (const raw of fruidsData) {
      i += 1;

      const name = raw.name || raw.title || `Product ${i}`;
      const price = Number(raw.price ?? raw.unit_price ?? 0);
      const stock = Number(raw.stock ?? raw.qty ?? 10);

      const filename = path.basename(raw.image || "");
      const localImagePath = path.join(__dirname, "../public/images/products-images", filename);

      let imageUrl = "";
      if (filename && fs.existsSync(localImagePath)) {
        try {
          const s3Key = `products-images/${filename}`;
          imageUrl = await uploadToS3(localImagePath, s3Key);
        } catch (e) {
          console.warn(`⚠️ S3 upload failed for ${filename}: ${e.message}`);
          // fallback so UI still shows an image locally/dev
          imageUrl = `/images/products-images/${filename}`;
        }
      } else if (filename) {
        console.warn(`⚠️ Image not found: ${localImagePath}`);
      }

      // Ensure unique customId (slug)
      let baseSlug = slugify(raw.customId || name);
      if (!baseSlug) baseSlug = `item-${Date.now()}-${i}`;
      let customId = baseSlug;

      let suffix = 1;
      // Avoid duplicates when re-running seeds
      while (await Product.findOne({ customId }).lean()) {
        customId = `${baseSlug}-${suffix++}`;
      }

      const doc = await Product.create({
        name,
        price,
        stock,
        imageUrl,
        customId,
        isNew: !!raw.isNew,
        sale: !!raw.sale,
        popular: !!raw.popular,
        description: raw.description || "",
        category: raw.category || raw.type || "General",
        createdAt: now,
        updatedAt: now,
      });

      createdIds.push(doc._id.toString());
    }

    console.log(`🍎 Seeded ${createdIds.length} products`);
    if (createdIds.length) console.log("   e.g.", createdIds.slice(0, 5));
    console.log("👋 Done");
  } finally {
    // Always disconnect even if we threw above
    await mongoose.disconnect();
  }
}

// Run with safe exit-code handling (no process.exit)
runMain(main);
