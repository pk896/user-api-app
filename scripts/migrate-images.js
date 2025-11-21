/**
 * scripts/migrate-images.js
 * - Finds Product docs with local image paths (e.g. "images/... " or "/images/...")
 * - Uploads the files to S3
 * - Rewrites the document's image field (default: imageUrl) to the public S3 URL
 *
 * Flags:
 *   --dry             : preview only (no DB writes, no S3 uploads)
 *   --limit=NUM       : only process first NUM matches
 *   --prefix=PATH     : S3 key prefix (default "products-images")
 *   --field=PATH      : field to migrate (default "imageUrl")
 */

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const mongoose = require("mongoose");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { runMain } = require("./_runner");
const Product = require("../models/Product");

// -------- CLI flags --------
const args = process.argv.slice(2);
const DRY = args.includes("--dry");

function getFlag(name, def) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  if (!m) return def;
  const v = m.split("=")[1];
  if (name === "limit") return Math.max(0, parseInt(v, 10) || 0);
  return v;
}

const LIMIT = getFlag("limit", 0);
const S3_PREFIX = getFlag("prefix", "products-images");
const FIELD = getFlag("field", "imageUrl"); // supports simple dotless path only

// Where to look for local files (in order)
const LOCAL_BASES = [
  path.join(__dirname, ".."),                            // repo root
  path.join(__dirname, "..", "public"),                  // /public/...
  path.join(__dirname, "..", "public", "images"),        // /public/images/...
  path.join(__dirname, "..", "public", "products-images")// /public/products-images/...
];

// -------- Helpers --------
function isLocalPath(p) {
  if (!p || typeof p !== "string") return false;
  const s = p.trim();
  if (!s) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  // treat "images/..." or "/images/..." or relative as local
  return true;
}

function detectContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function resolveLocalFile(relOrAbsPath) {
  // If absolute and exists, use it
  if (path.isAbsolute(relOrAbsPath) && fs.existsSync(relOrAbsPath)) {
    return relOrAbsPath;
  }
  // Normalize leading slashes ("/images/x.jpg" -> "images/x.jpg")
  const rel = relOrAbsPath.replace(/^[/\\]+/, "");
  for (const base of LOCAL_BASES) {
    const p = path.join(base, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function s3PublicUrl(bucket, region, key) {
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

async function uploadToS3(s3, bucket, region, localPath, keyPrefix) {
  const ext = path.extname(localPath).toLowerCase() || ".jpg";
  const key = `${keyPrefix}/${Date.now()}-${Math.floor(Math.random() * 1e9)}${ext}`;
  const ContentType = detectContentType(localPath);
  const Body = fs.createReadStream(localPath);

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body,
    ContentType,
    // ACL: "public-read", // only if your bucket policy requires it
  }));

  return s3PublicUrl(bucket, region, key);
}

// -------- Main --------
async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  const bucket = process.env.AWS_BUCKET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");
  if (!bucket) throw new Error("❌ Missing AWS_BUCKET_NAME (.env)");

  const s3 = new S3Client({
    region,
    credentials: (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
      ? { accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY }
      : undefined, // allow instance/profile creds
  });

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");
  console.log(`🔧 Field: ${FIELD}  |  Prefix: ${S3_PREFIX}  |  Mode: ${DRY ? "DRY" : "WRITE"}`);

  try {
    // Build the query dynamically for the chosen field (simple string field)
    // We want things that look local (not http/https). Use $regex to find likely local paths.
    const localRegex = /^(?!https?:\/\/).+/i;
    const query = { [FIELD]: { $regex: localRegex } };

    let cursor = Product.find(query).select(`_id name ${FIELD}`).cursor();

    let processed = 0;
    let updated = 0;
    for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
      if (LIMIT && processed >= LIMIT) break;

      const value = doc[FIELD];
      if (!isLocalPath(value)) {
        continue; // skip if somehow not local
      }

      // Resolve file on disk
      const localPath = resolveLocalFile(value);
      if (!localPath) {
        console.warn(`⚠️  Missing local file for ${doc._id} (${doc.name || ""}): ${value}`);
        processed += 1;
        continue;
      }

      console.log(`📤 ${doc._id} ${doc.name || ""}  ->  ${localPath}`);

      if (DRY) {
        processed += 1;
        continue;
      }

      try {
        const publicUrl = await uploadToS3(s3, bucket, region, localPath, S3_PREFIX);
        doc[FIELD] = publicUrl;
        await doc.save();
        updated += 1;
      } catch (e) {
        console.warn(`⚠️  Upload/save failed for ${doc._id}: ${e && e.message}`);
      }

      processed += 1;
    }

    console.log(`\n✅ Done. Processed: ${processed}  |  Updated: ${updated}  |  Mode: ${DRY ? "DRY" : "WRITE"}`);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected");
  }
}

runMain(main);
