require("dotenv").config();
const mongoose = require("mongoose");
const { runMain } = require("./_runner");

// 👉 Reuse your real models if you have them
// const User = require('../models/User');
// const Product = require('../models/Product');
// const Order = require('../models/Order');
// const Message = require('../models/Message');

// Minimal models by collection name (avoid schema strictness here)
const opts = { strict: false, versionKey: false, timestamps: false };
const User = mongoose.model("users", new mongoose.Schema({}, opts));
const Product = mongoose.model("products", new mongoose.Schema({}, opts));
const Order = mongoose.model("orders", new mongoose.Schema({}, opts));
const Message = mongoose.model("messages", new mongoose.Schema({}, opts));

// ---------- Filters (edit as needed) ----------
const FILTERS = {
  products: {
    $or: [
      { name: /test|demo|sample/i },
      { description: /test|demo|sample/i },
      // { createdAt: { $lt: new Date('2025-01-01') } },
    ],
  },
  users: {
    $or: [
      { email: /@example\.com$/i },
      { email: /@mailinator\.com$/i },
      { email: /^sb-.*@personal\.example\.com$/i }, // PayPal sandbox buyers
      { name: /test|demo|sample/i },
    ],
  },
  orders: {
    $or: [
      { "payer.email_address": /^sb-.*@personal\.example\.com$/i }, // PayPal sandbox
      { status: /^TEST|DEMO$/i },
      // { createdAt: { $lt: new Date('2025-01-01') } },
    ],
  },
  messages: {
    $or: [
      { subject: /test|demo|sample/i },
      { body: /test|demo|sample/i },
      // { createdAt: { $lt: new Date('2025-01-01') } },
    ],
  },
};

// ---------- CLI flags ----------
// --yes        actually delete (otherwise preview only)
// --collections=users,products,orders,messages (subset to target)
const args = process.argv.slice(2);
const DO_DELETE = args.includes("--yes");

function parseList(name, def) {
  const m = args.find((a) => a.startsWith(`--${name}=`));
  if (!m) return def;
  return m
    .split("=")[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Choose which collections to touch
const TARGETS = parseList("collections", ["users", "products", "orders", "messages"]);

async function run(name, Model, filter) {
  if (!TARGETS.includes(name)) return;

  if (!filter || (typeof filter === "object" && Object.keys(filter).length === 0)) {
    console.log(`⚠️  Skipping ${name}: no filter defined`);
    return;
  }

  const count = await Model.countDocuments(filter);
  console.log(`📦 ${name}: ${count} to ${DO_DELETE ? "delete" : "preview"}`);
  if (!count) return;

  if (!DO_DELETE) {
    // Show a few samples
    const sample = await Model.find(filter).limit(5);
    console.log(`   ℹ️ sample ${name} docs:`, sample.map((s) => s._id.toString()));
    return;
  }

  const res = await Model.deleteMany(filter);
  console.log(`   🧹 deleted ${res.deletedCount} ${name}`);
}

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ MONGO_URI missing in .env");

  const redacted = uri.replace(/\/\/([^:/@]+):([^@]+)@/, "//****:****@");
  console.log(`🔗 Connecting: ${redacted}`);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 20000,
    socketTimeoutMS: 60000,
    connectTimeoutMS: 30000,
  });
  console.log("✅ Connected");

  try {
    await run("products", Product, FILTERS.products);
    await run("users", User, FILTERS.users);
    await run("orders", Order, FILTERS.orders);
    await run("messages", Message, FILTERS.messages);
    console.log(`👋 Done (${DO_DELETE ? "delete mode" : "preview mode"})`);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected");
  }
}

runMain(main);
