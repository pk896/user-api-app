// models/SellerBalanceLedger.js
'use strict';

const mongoose = require('mongoose');

const sellerBalanceLedgerSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: 'Business', required: true, index: true },
    type: { type: String, enum: ['EARNING', 'REFUND_DEBIT', 'ADJUSTMENT', 'PAYOUT_DEBIT'], required: true },
    amountCents: { type: Number, required: true }, // + for earning, - for debits
    currency: { type: String, default: 'USD', trim: true, uppercase: true, index: true },

    // ✅ NEW: when this ledger row becomes withdrawable
    // Use it mainly for EARNING rows.
    availableAt: { type: Date, default: null, index: true },

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

// ✅ Helpful for your “eligible now” queries (matured earnings)
sellerBalanceLedgerSchema.index({ businessId: 1, currency: 1, type: 1, availableAt: 1 });

module.exports = mongoose.model('SellerBalanceLedger', sellerBalanceLedgerSchema);
