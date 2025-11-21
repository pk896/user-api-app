// utils/notify.js
const Notification = require('../models/Notification');

async function createNotification(input) {
  const required = ['buyerId', 'type', 'title'];
  for (const k of required) {
    if (!input[k]) {throw new Error(`Missing ${k} for notification`);}
  }
  return Notification.create({
    buyerId: input.buyerId,
    type: input.type, // 'match.accepted' | 'match.rejected' | 'match.pending'
    matchId: input.matchId || null,
    demandId: input.demandId || null,
    productId: input.productId || null,
    supplierId: input.supplierId || null,
    title: input.title,
    message: input.message || '',
  });
}

module.exports = { createNotification };
