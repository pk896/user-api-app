// models/Order.js
const { mongoose } = require('../db');
const { Schema } = mongoose;

const MoneySchema = new Schema({
  value: { type: String, required: true },
  currency: { type: String, default: 'USD' },
}, { _id: false });

const BreakdownMoneySchema = new Schema({
  value: { type: String, required: true },
  currency: { type: String, default: 'USD' },
}, { _id: false });

const SellerReceivableSchema = new Schema({
  gross:      { type: MoneySchema },
  paypalFee:  { type: MoneySchema },
  net:        { type: MoneySchema },
}, { _id: false });

const CaptureSchema = new Schema({
  captureId: String,
  status: String,
  amount: MoneySchema,
  sellerReceivable: SellerReceivableSchema,
  createTime: Date,
  updateTime: Date,
  links: [{ rel: String, href: String, method: String }],
}, { _id: false });

const OrderItemSchema = new Schema({
  productId: String,
  name: { type: String, required: true },
  price: MoneySchema,       // unit price
  quantity: { type: Number, min: 1, default: 1 },
  imageUrl: String,
}, { _id: false });

const PayerNameSchema = new Schema({
  given: String,
  surname: String,
}, { _id: false });

const PayerSchema = new Schema({
  payerId: String,
  email: String,
  name: PayerNameSchema,
  countryCode: String,
}, { _id: false });

const ShippingAddressSchema = new Schema({
  name: String,
  address_line_1: String,
  admin_area_2: String,
  admin_area_1: String,
  postal_code: String,
  country_code: String,
}, { _id: false });

const BreakdownSchema = new Schema({
  itemTotal: BreakdownMoneySchema,
  taxTotal: BreakdownMoneySchema,
  shipping: BreakdownMoneySchema,
}, { _id: false });

// ✅ delivery snapshot you wanted to display on thank-you/receipt
const DeliverySnapshotSchema = new Schema({
  id: String,             // DeliveryOption _id
  name: String,           // e.g., "Express"
  deliveryDays: Number,   // ETA days
  amount: String,         // "15.00" (string to match other money fields)
}, { _id: false });

const RefundSchema = new Schema({
  refundId: String,
  status: String,
  amount: String,
  currency: String,
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const OrderSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User' },

  orderId: { type: String, index: true, unique: true, sparse: true },
  status: { type: String, index: true },
  purchaseUnitRef: String,

  payer: PayerSchema,
  shipping: ShippingAddressSchema,

  amount: MoneySchema,           // captured total (string value + currency)
  breakdown: BreakdownSchema,

  fee: { type: String },
  net: { type: String },

  // ✅ store chosen delivery method snapshot
  delivery: DeliverySnapshotSchema,

  captures: [CaptureSchema],
  items: [OrderItemSchema],

  refunds: [RefundSchema],
  refundedTotal: { type: String, default: '0.00' },

  raw: { type: Schema.Types.Mixed }, // full PayPal response snapshot
}, { timestamps: true });

// Helpful indexes
OrderSchema.index({ createdAt: -1 });
OrderSchema.index({ 'payer.email': 1, createdAt: -1 });
OrderSchema.index({ status: 1, createdAt: -1 });

// ✅ Guard against OverwriteModelError
module.exports = mongoose.models.Order || mongoose.model('Order', OrderSchema);
