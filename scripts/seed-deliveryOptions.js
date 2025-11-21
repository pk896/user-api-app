require("dotenv").config();
const mongoose = require("mongoose");
const { runMain } = require("./_runner");
const DeliveryOption = require("../models/DeliveryOption");

const options = [
  { name: "Standard",  deliveryDays: 7, priceCents: 1000 },
  { name: "Express",   deliveryDays: 3, priceCents: 500  },
  { name: "Next Day",  deliveryDays: 1, priceCents: 0    },
];

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error("❌ Missing MONGO_URI (.env)");

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");

  try {
    await DeliveryOption.deleteMany({});
    await DeliveryOption.insertMany(options);
    console.log("✅ Delivery options seeded");
  } finally {
    await mongoose.disconnect();
    console.log("👋 Disconnected");
  }
}

runMain(main);
