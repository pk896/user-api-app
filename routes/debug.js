// routes/debug.js (or in any routes file just for now)
const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

router.get('/debug/one-order', async (req, res) => {
  try {
    const order = await Order.findOne().lean();
    console.log('🔍 Sample order:\n', JSON.stringify(order, null, 2));
    res.send('Check server console for sample order');
  } catch (err) {
    console.error('debug one-order error:', err);
    res.status(500).send('error');
  }
});

module.exports = router;
