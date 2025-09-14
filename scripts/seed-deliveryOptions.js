/* scripts/seed-deliveryOptions.js */
const mongoose = require("mongoose");
require("dotenv").config();
const DeliveryOption = require("../models/DeliveryOption");

const options = [
  { name: "Standard", deliveryDays: 7, priceCents: 1000 },
  { name: "Express", deliveryDays: 3, priceCents: 500 },
  { name: "Next Day", deliveryDays: 1, priceCents: 0 },
];

async function seed() {
  await mongoose.connect(process.env.MONGO_URI);

  await DeliveryOption.deleteMany({}); // clear existing
  await DeliveryOption.insertMany(options);

  console.log("✅ Delivery options seeded");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
