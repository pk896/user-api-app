// scripts/cleanup.js
require('dotenv').config();
const mongoose = require('mongoose');

// 👉 Reuse your real models if you have them
// const User = require('../models/User');
// const Product = require('../models/Product');
// const Order = require('../models/Order');
// const Message = require('../models/Message');

// If you don't want to import, define minimal models by collection name:
const opts = { strict: false, versionKey: false, timestamps: false };
const User     = mongoose.model('users',     new mongoose.Schema({}, opts));
const Product  = mongoose.model('products',  new mongoose.Schema({}, opts));
const Order    = mongoose.model('orders',    new mongoose.Schema({}, opts));
const Message  = mongoose.model('messages',  new mongoose.Schema({}, opts));

// ---------- Edit your test filters here ----------
/**
 * Common patterns (pick/adjust what you need):
 *  - Names containing “test”, “demo”, or “sample”
 *  - Users with test domains (example.com, mailinator, your sandbox emails)
 *  - Very old docs created during development
 *  - Orders from PayPal Sandbox only (payer email matches sb-...@personal.example.com)
 */
const FILTERS = {
  products: {
    $or: [
      { name: /test|demo|sample/i },
      { description: /test|demo|sample/i },
      // Example: everything before a date
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
      { 'payer.email_address': /^sb-.*@personal\.example\.com$/i }, // PayPal sandbox
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
const DO_DELETE = args.includes('--yes');

function parseList(name, def) {
  const m = args.find(a => a.startsWith(`--${name}=`));
  if (!m) return def;
  return m.split('=')[1].split(',').map(s => s.trim()).filter(Boolean);
}

// Choose which collections to touch
const TARGETS = parseList('collections', ['users','products','orders','messages']);

(async () => {
  try {
    const uri = process.env.MONGO_URI;
    if (!uri) {
      console.error('❌ MONGO_URI missing in .env');
      process.exit(1);
    }

    console.log(`🔗 Connecting: ${uri.replace(/\/\/(.*)@/, '//****:****@')}`);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 20000,
      socketTimeoutMS: 60000,
      connectTimeoutMS: 30000,
    });
    console.log('✅ Connected');

    const jobs = [];

    async function run(name, Model, filter) {
      if (!TARGETS.includes(name)) return;
      if (!filter || (typeof filter === 'object' && Object.keys(filter).length === 0)) {
        console.log(`⚠️  Skipping ${name}: no filter defined`);
        return;
      }
      const count = await Model.countDocuments(filter);
      console.log(`📦 ${name}: ${count} to ${DO_DELETE ? 'delete' : 'preview'}`);
      if (!count) return;

      if (!DO_DELETE) {
        // Show a few samples
        const sample = await Model.find(filter).limit(5);
        console.log(`   ℹ️ sample ${name} docs:`, sample.map(s => s._id.toString()));
        return;
      }

      const res = await Model.deleteMany(filter);
      console.log(`   🧹 deleted ${res.deletedCount} ${name}`);
    }

    await run('products', Product, FILTERS.products);
    await run('users',    User,    FILTERS.users);
    await run('orders',   Order,   FILTERS.orders);
    await run('messages', Message, FILTERS.messages);

    await mongoose.disconnect();
    console.log('👋 Done');
  } catch (e) {
    console.error('❌ Cleanup error:', e);
    process.exit(1);
  }
})();
