require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { runMain } = require("./scripts/_runner"); // adjust if this file is in project root
const Product = require("./models/Product");      // adjust if your path differs

function detectContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");
  const bucket = process.env.AWS_BUCKET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";
  if (!bucket) throw new Error("❌ Missing AWS_BUCKET_NAME (.env)");

  const s3 = new S3Client({
    region,
    credentials: (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined,
  });

  await mongoose.connect(uri);
  try {
    const products = await Product.find({ imageUrl: { $regex: "^images/" } });
    for (const product of products) {
      const rel = product.imageUrl.replace(/^[/\\]+/, "");
      const localPath = path.join(__dirname, rel);
      if (!fs.existsSync(localPath)) continue;

      const contentType = detectContentType(localPath);
      const ext = path.extname(localPath).toLowerCase() || ".jpg";
      const key = `products/${Date.now()}-${Math.floor(Math.random() * 1e6)}${ext}`;
      const Body = fs.createReadStream(localPath);

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body,
        ContentType: contentType,
      }));

      product.imageUrl = `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
      await product.save();
      console.log(`✅ Migrated: ${product.name}`);
    }
    console.log("🎉 Migration finished");
  } finally {
    await mongoose.disconnect();
  }
}

runMain(main);
