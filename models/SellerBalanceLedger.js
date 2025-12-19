// models/SellerBalanceLedger.js
const mongoose = require('mongoose');

const sellerBalanceLedgerSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    type: { type: String, enum: ['EARNING', 'REFUND_DEBIT', 'ADJUSTMENT', 'PAYOUT_DEBIT'], required: true },
    amountCents: { type: Number, required: true }, // + for earning, - for debits
    currency: { type: String, default: 'USD' },

    // References
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    payoutId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payout' },

    note: { type: String, trim: true },
    meta: { type: Object, default: {} },
  },
  { timestamps: true }
);

sellerBalanceLedgerSchema.index(
    { businessId: 1, type: 1, orderId: 1, 'meta.uniqueKey': 1 },
    { unique: true, sparse: true }
);

module.exports = mongoose.model('SellerBalanceLedger', sellerBalanceLedgerSchema);
