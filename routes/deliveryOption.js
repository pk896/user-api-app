// routes/deliveryOption.js
const express = require("express");
const DeliveryOption = require("../models/DeliveryOption");
const router = express.Router();

// GET all delivery options
router.get("/", async (req, res) => {
  try {
    const options = await DeliveryOption.find();
    res.json(options);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch delivery options" });
  }
});

module.exports = router;
