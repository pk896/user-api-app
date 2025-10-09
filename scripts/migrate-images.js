require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const Product = require("../models/Product");

const s3 = new S3Client({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = process.env.AWS_BUCKET_NAME;

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const products = await Product.find({ imageUrl: { $regex: "^images/" } });

    for (const product of products) {
      const localPath = path.join(__dirname, "..", product.imageUrl);
      if (!fs.existsSync(localPath)) continue;

      const fileExt = path.extname(localPath);
      const fileName = `products/${Date.now()}-${Math.floor(Math.random()*1000)}${fileExt}`;
      const buffer = fs.readFileSync(localPath);

      await s3.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: fileName,
        Body: buffer,
        ContentType: "image/jpeg"
      }));

      product.imageUrl = `https://${BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
      await product.save();

      console.log(`✅ Migrated: ${product.name}`);
    }

    console.log("🎉 Migration finished");
    process.exit(0);
  } catch (err) {
    console.error("Migration error:", err);
    process.exit(1);
  }
})();
