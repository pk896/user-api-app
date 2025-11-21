// models/Notification.js
const { mongoose } = require('../db');
const { Schema } = mongoose;

const NotificationSchema = new Schema(
  {
    // who should see it
    buyerId: { type: Schema.Types.ObjectId, ref: 'Business', index: true, required: true },

    // context
    type: {
      type: String,
      enum: ['match.accepted', 'match.rejected', 'match.pending'],
      required: true,
    },
    matchId: { type: Schema.Types.ObjectId, ref: 'MatchedDemand', index: true },
    demandId: { type: Schema.Types.ObjectId, ref: 'DemandedProduct' }, // or "Demand"
    productId: { type: Schema.Types.ObjectId, ref: 'Product' },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Business' },

    // display
    title: { type: String, required: true }, // short title
    message: { type: String, default: '' }, // optional detail

    // status
    readAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// Useful compound index for inbox lists
NotificationSchema.index({ buyerId: 1, createdAt: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);
