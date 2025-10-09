// fix-product-image-urls.js
require('dotenv').config();
const mongoose = require("mongoose");
const fetch = require("node-fetch"); // npm install node-fetch@2
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const Product = require("./models/Product"); // adjust path if needed

// S3 client
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function fixProductImages() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✅ Connected to MongoDB");

    const bucketName = process.env.AWS_BUCKET_NAME;

    // List objects in products-images folder
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "products-images/",
    });
    const response = await s3.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      console.log("No images found in products-images folder.");
      return;
    }

    console.log(`Found ${response.Contents.length} images in S3`);

    // Iterate through each image in S3
    for (const obj of response.Contents) {
      const objectUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${obj.Key}`;

      // Check if URL is accessible
      try {
        const res = await fetch(objectUrl, { method: "HEAD" });
        if (!res.ok) {
          console.warn(`❌ Not accessible: ${objectUrl} (status ${res.status})`);
          continue;
        }
      } catch (err) {
        console.warn(`❌ Error fetching ${objectUrl}: ${err.message}`);
        continue;
      }

      // Extract filename from S3 key
      const filename = obj.Key.split("/").pop();

      // Find the product in MongoDB with this filename in the old image path
      const product = await Product.findOne({ image: { $regex: filename } });
      if (!product) {
        console.log(`⚠️ No product found matching image ${filename}`);
        continue;
      }

      // Update product's image URL
      product.image = objectUrl;
      await product.save();
      console.log(`✅ Updated product ${product.name} image URL`);
    }

    console.log("🎉 Done updating product images");
    process.exit(0);

  } catch (err) {
    console.error("❌ Error:", err);
    process.exit(1);
  }
}

fixProductImages();
