// models/Order.js
'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// ✅ Single canonical paid-like list (always compare UPPERCASE)
const PAID_STATES = ['COMPLETED', 'PAID', 'SHIPPED', 'DELIVERED'];

// ---------- Schemas ----------
const MoneySchema = new Schema(
  {
    value: { type: String, required: true }, // keep as string to avoid FP drift
    currency: { type: String, default: 'USD' },
  },
  { _id: false }
);

const BreakdownMoneySchema = new Schema(
  {
    value: { type: String, required: true },
    currency: { type: String, default: 'USD' },
  },
  { _id: false }
);

const SellerReceivableSchema = new Schema(
  {
    gross: { type: MoneySchema },
    paypalFee: { type: MoneySchema },
    net: { type: MoneySchema },
  },
  { _id: false }
);

const CaptureSchema = new Schema(
  {
    captureId: { type: String, index: true }, // ✅ helps find by captureId fast
    status: String,
    amount: MoneySchema,
    sellerReceivable: SellerReceivableSchema,
    createTime: Date,
    updateTime: Date,
    links: [{ rel: String, href: String, method: String }],
  },
  { _id: false }
);

const OrderItemSchema = new Schema(
  {
    // NOTE: this is your Product.customId (string), not ObjectId
    productId: { type: String, index: true },
    name: { type: String, required: true },

    // ✅ NET unit price snapshot (used for seller crediting)
    price: MoneySchema,

    // ✅ GROSS unit price snapshot (used for receipts/UI)
    priceGross: MoneySchema,

    quantity: { type: Number, min: 1, default: 1 },
    imageUrl: String,

    // ✅ NEW: store size/color/etc so receipt & admin views can show it
    variants: {
      size: { type: String, trim: true },
      color: { type: String, trim: true },
    },
  },
  { _id: false }
);

const PayerNameSchema = new Schema({ given: String, surname: String }, { _id: false });

const PayerSchema = new Schema(
  {
    payerId: String,
    email: String,
    name: PayerNameSchema,
    countryCode: String,
  },
  { _id: false }
);

const ShippingAddressSchema = new Schema(
  {
    name: String,

    // ✅ contact (so couriers can call)
    phone: String,
    email: String,

    address_line_1: String,
    address_line_2: String,
    admin_area_2: String,
    admin_area_1: String,
    postal_code: String,
    country_code: String,
  },
  { _id: false }
);

const BreakdownSchema = new Schema(
  {
    itemTotal: BreakdownMoneySchema,
    taxTotal: BreakdownMoneySchema,
    shipping: BreakdownMoneySchema,
  },
  { _id: false }
);

// ✅ delivery snapshot for thank-you/receipt
const DeliverySnapshotSchema = new Schema(
  {
    id: String, // DeliveryOption _id
    name: String, // e.g., "Express"
    deliveryDays: Number,
    amount: String, // "15.00"
  },
  { _id: false }
);

// --- Tracking ---
const ShippingTrackingSchema = new Schema(
  {
    carrier: { type: String, default: 'OTHER', trim: true },
    carrierLabel: String,
    trackingNumber: String,
    trackingUrl: String,
    labelUrl: String,

    // ✅ Shippo token like "usps", "ups" (used for Shippo tracking endpoint)
    carrierToken: { type: String },

    // ✅ Live tracking cache (Shippo / courier APIs)
    liveStatus: { type: String },
    liveEvents: { type: Array, default: [] },
    lastTrackingUpdate: { type: Date },
    estimatedDelivery: { type: Date },

    // ✅ Optional: last provider update timestamp
    lastUpdate: { type: Date },

    status: {
      type: String,
      enum: ['PENDING', 'PROCESSING', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED'],
      default: 'PENDING',
    },
    shippedAt: Date,
    deliveredAt: Date,
  },
  { _id: false }
);

const RefundSchema = new Schema(
  {
    refundId: { type: String, index: true }, // ✅ helps idempotency + lookups
    status: String,
    amount: String,
    currency: String,
    createdAt: { type: Date, default: Date.now },
    source: String, // ✅ lets webhook store "webhook:EVENT"
  },
  { _id: false }
);

// ---------- Main Order schema ----------
const OrderSchema = new Schema(
  {
    // If a personal user placed the order
    userId: { type: Schema.Types.ObjectId, ref: 'User' },

    // If a business buyer placed the order (used by buyer dashboard)
    businessBuyer: { type: Schema.Types.ObjectId, ref: 'Business', index: true },

    orderId: { type: String, index: true, unique: true, sparse: true },

    // ✅ these two are what payouts/charts should filter on
    status: { type: String, index: true }, // e.g. COMPLETED / REFUNDED / PARTIALLY_REFUNDED
    paymentStatus: { type: String, index: true }, // e.g. paid / refunded (optional but helpful)

    // ✅ easy, reliable captureId storage for webhooks
    paypal: {
      captureId: { type: String, index: true },
      orderId: { type: String, index: true }, // PayPal order id (same as your orderId usually)
    },

    purchaseUnitRef: String,

    payer: PayerSchema,

    // PayPal shipping address snapshot
    shipping: ShippingAddressSchema,

    // ✅ Fulfillment lifecycle (separate from PayPal payment status)
    fulfillmentStatus: {
      type: String,
      enum: ['PENDING', 'PAID', 'PACKING', 'LABEL_CREATED', 'SHIPPED', 'DELIVERED', 'CANCELLED'],
      default: 'PENDING',
      index: true,
    },

    // ✅ Shippo ids + label (for API tracking + reprints)
    shippo: {
      shipmentId: { type: String, index: true },
      transactionId: { type: String, index: true },
      payerShipmentId: { type: String, default: null },
      rateId: String,
      // ✅ the payer-selected rateId (admin must buy THIS one)
      payerRateId: { type: String, index: true },

      labelUrl: String,
      trackingStatus: String, // raw Shippo status if you want

      // ✅ Shippo carrier token like "usps", "ups" (your adminShippo saves this)
      carrier: String,

      // ✅ Persist chosen rate so admin page can show provider/service/price after refresh
      chosenRate: {
        provider: String,       // e.g. "USPS"
        service: String,        // e.g. "Priority Mail International"
        amount: String,         // e.g. "72.56"
        currency: String,       // e.g. "USD"
        estimatedDays: Number,  // e.g. 8
        durationTerms: String,  // e.g. "~8 days"
      },

      // ✅ customs declaration id (reused for international)
      customsDeclarationId: { type: String, index: true },

      // ✅ International metadata (used for label buying / audit)
      isInternational: { type: Boolean, default: false },
      fromCountry: { type: String, trim: true, uppercase: true }, // e.g. ZA
      toCountry: { type: String, trim: true, uppercase: true },   // e.g. US

      // ✅ When Shippo selection was persisted (optional but useful)
      createdAt: Date,

      // ✅ auto-buy bookkeeping (so we don’t spam / re-buy / re-try forever)
      autoBuyEnabled: { type: Boolean, default: true },
      autoBuyAttemptedAt: Date,
      autoBuyStatus: {
        type: String,
        enum: ['PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'SKIPPED'],
        default: 'PENDING',
      },

      autoBuyLastError: String,
      autoBuyLastSuccessAt: Date,

      // ✅ Admin rates snapshot (saved by /admin/orders/:orderId/shippo/rates)
      adminShipmentId: { type: String, index: true },
      adminLastRatesAt: Date,
      adminLastRatesShipmentId: String,

      adminLastRates: [
        {
          object_id: String,
          id: String,
          provider: String,
          service: String,
          amount: String,
          currency: String,
          estimatedDays: Number,
          durationTerms: String,
        },
      ],

      lastRatesAt: Date,
    },

    // Courier + tracking info
    shippingTracking: ShippingTrackingSchema,


    amount: MoneySchema, // captured total
    breakdown: BreakdownSchema,

    platformFeeBps: { type: Number, default: 1000 }, // 10% default (basis points)

    fee: { type: String },
    net: { type: String },

    delivery: DeliverySnapshotSchema,

    captures: [CaptureSchema],
    items: [OrderItemSchema],

    refunds: [RefundSchema],
    refundedTotal: { type: String, default: '0.00' },
    refundedAt: Date,

    raw: { type: Schema.Types.Mixed },

   // ✅ idempotency guard for inventory adjustment after capture
    inventoryAdjusted: { type: Boolean, default: false },

    // ✅ track what we deducted (so restore is correct & idempotent)
    inventoryAdjustedItems: [
      {
        productId: { type: String }, // Product.customId
        quantity: { type: Number, min: 1, default: 1 },
      },
    ],

    // ✅ idempotency guard for restoring stock on full refund
    inventoryRestored: { type: Boolean, default: false }, 
  },
  { timestamps: true }
);

// ---------- Indexes ----------
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ 'payer.email': 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ paymentStatus: 1, createdAt: -1 });
OrderSchema.index({ 'items.productId': 1, createdAt: -1 });
OrderSchema.index({ businessBuyer: 1, createdAt: -1 });
OrderSchema.index({ 'paypal.captureId': 1, createdAt: -1 });
OrderSchema.index({ 'captures.captureId': 1, createdAt: -1 });
OrderSchema.index({ 'refunds.refundId': 1, createdAt: -1 });

// Shippo
OrderSchema.index({ fulfillmentStatus: 1, createdAt: -1 });
OrderSchema.index({ 'shippo.transactionId': 1, createdAt: -1 });
OrderSchema.index({ 'shippo.shipmentId': 1, createdAt: -1 });

// ---------- Statics / helpers ----------
OrderSchema.statics.PAID_STATES = PAID_STATES;

OrderSchema.methods.isPaidLike = function isPaidLike() {
  const s = String(this.status || '').trim().toUpperCase();
  const ps = String(this.paymentStatus || '').trim().toUpperCase();

  // paid-like if either field indicates paid/completed
  if (PAID_STATES.includes(s)) return true;
  if (PAID_STATES.includes(ps)) return true;

  // extra common variants (optional but helpful)
  if (ps === 'CAPTURED') return true; // you use CAPTURED in adminShippo filter
  if (s === 'CAPTURED') return true;

  return false;
};

// ✅ Guard against OverwriteModelError in dev
module.exports = mongoose.models.Order || mongoose.model('Order', OrderSchema);
