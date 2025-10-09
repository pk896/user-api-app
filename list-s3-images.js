// user-api-app/list-s3-images.js
require('dotenv').config();
const { S3Client, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

async function listProductImages() {
  try {
    const bucketName = process.env.AWS_BUCKET_NAME;

    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: "products-images/", // list only product images
    });

    const response = await s3.send(command);

    if (!response.Contents || response.Contents.length === 0) {
      console.log("No images found in products-images folder.");
      return;
    }

    console.log("✅ Product images in S3:");
    response.Contents.forEach(obj => {
      const objectUrl = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${obj.Key}`;
      console.log(`- ${obj.Key}`);
      console.log(`  URL: ${objectUrl}\n`);
    });

  } catch (err) {
    console.error("❌ Error listing images:", err);
  }
}

listProductImages();
