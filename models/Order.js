// models/Order.js
const { mongoose } = require('../db');
const { Schema } = mongoose;

// --- Reusable helpers ---
const PAID_STATES = ['Completed', 'Paid', 'Shipped', 'Delivered']; // used in dashboards/KPIs

const MoneySchema = new Schema(
  {
    value: { type: String, required: true }, // keep as string to avoid FP drift
    currency: { type: String, default: 'USD' },
  },
  { _id: false },
);

const BreakdownMoneySchema = new Schema(
  {
    value: { type: String, required: true },
    currency: { type: String, default: 'USD' },
  },
  { _id: false },
);

const SellerReceivableSchema = new Schema(
  {
    gross: { type: MoneySchema },
    paypalFee: { type: MoneySchema },
    net: { type: MoneySchema },
  },
  { _id: false },
);

const CaptureSchema = new Schema(
  {
    captureId: String,
    status: String,
    amount: MoneySchema,
    sellerReceivable: SellerReceivableSchema,
    createTime: Date,
    updateTime: Date,
    links: [{ rel: String, href: String, method: String }],
  },
  { _id: false },
);

const OrderItemSchema = new Schema(
  {
    // NOTE: this is your Product.customId (string), not ObjectId
    productId: { type: String, index: true },
    name: { type: String, required: true },
    price: MoneySchema, // unit price snapshot at time of order
    quantity: { type: Number, min: 1, default: 1 },
    imageUrl: String,
  },
  { _id: false },
);

const PayerNameSchema = new Schema(
  { given: String, surname: String },
  { _id: false },
);

const PayerSchema = new Schema(
  {
    payerId: String,
    email: String,
    name: PayerNameSchema,
    countryCode: String,
  },
  { _id: false },
);

const ShippingAddressSchema = new Schema(
  {
    name: String,
    address_line_1: String,
    admin_area_2: String,
    admin_area_1: String,
    postal_code: String,
    country_code: String,
  },
  { _id: false },
);

const BreakdownSchema = new Schema(
  {
    itemTotal: BreakdownMoneySchema,
    taxTotal: BreakdownMoneySchema,
    shipping: BreakdownMoneySchema,
  },
  { _id: false },
);

// ✅ delivery snapshot you wanted to display on thank-you/receipt
const DeliverySnapshotSchema = new Schema(
  {
    id: String,          // DeliveryOption _id
    name: String,        // e.g., "Express"
    deliveryDays: Number,
    amount: String,      // "15.00"
  },
  { _id: false },
);

const RefundSchema = new Schema(
  {
    refundId: String,
    status: String,
    amount: String,
    currency: String,
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const OrderSchema = new Schema(
  {
    // If a personal user placed the order
    userId: { type: Schema.Types.ObjectId, ref: 'User' },

    // If a business buyer placed the order (used by buyer dashboard)
    businessBuyer: { type: Schema.Types.ObjectId, ref: 'Business', index: true },

    orderId: { type: String, index: true, unique: true, sparse: true },
    status: { type: String, index: true }, // consider restricting with enum if you want
    purchaseUnitRef: String,

    payer: PayerSchema,
    shipping: ShippingAddressSchema,

    amount: MoneySchema,      // captured total
    breakdown: BreakdownSchema,

    fee: { type: String },    // convenience fields (string)
    net: { type: String },

    // chosen delivery method snapshot
    delivery: DeliverySnapshotSchema,

    captures: [CaptureSchema],
    items: [OrderItemSchema],

    refunds: [RefundSchema],
    refundedTotal: { type: String, default: '0.00' },

    raw: { type: Schema.Types.Mixed }, // full PayPal snapshot

    // ✅ idempotency guard for inventory adjustment after capture
    inventoryAdjusted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// ---------- Indexes ----------
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ 'payer.email': 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });
OrderSchema.index({ 'items.productId': 1, createdAt: -1 });  // fast seller/per-product lookups
OrderSchema.index({ businessBuyer: 1, createdAt: -1 });      // fast buyer dashboard

// ---------- Statics / helpers ----------
OrderSchema.statics.PAID_STATES = PAID_STATES;
OrderSchema.methods.isPaidLike = function isPaidLike() {
  return PAID_STATES.includes(this.status);
};

// ✅ Guard against OverwriteModelError in dev
module.exports = mongoose.models.Order || mongoose.model('Order', OrderSchema);
