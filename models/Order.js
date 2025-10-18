// models/Order.js
const mongoose = require("mongoose");
const { Schema } = mongoose;

const Money = new Schema(
  {
    value: { type: String, required: true },          // keep as string to avoid float drift, or use Decimal128
    currency: { type: String, required: true },       // e.g. "ZAR", "USD"
  },
  { _id: false }
);

const Capture = new Schema(
  {
    captureId: { type: String, index: true },         // e.g. "3AB12345..."
    status: String,                                   // "COMPLETED"
    amount: Money,
    sellerReceivable: {
      gross: Money,
      paypalFee: Money,
      net: Money,
    },
    createTime: Date,
    updateTime: Date,
    links: [{ rel: String, href: String, method: String }],
  },
  { _id: false }
);

const OrderItem = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    name: String,
    price: Money,                                     // unit price at time of purchase
    quantity: { type: Number, default: 1 },
    imageUrl: String,
  },
  { _id: false }
);

const orderSchema = new Schema(
  {
    // Relations (optional but recommended)
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },

    // PayPal
    orderId: { type: String, unique: true, index: true }, // PayPal order id
    status: String,                                       // top-level order status (e.g., "COMPLETED")
    purchaseUnitRef: String,                              // reference_id you sent (e.g., "PK-...")

    // Payer
    payer: {
      payerId: String,                                    // data.payer.payer_id
      email: String,                                      // data.payer.email_address
      name: { given: String, surname: String },
      countryCode: String,                                // data.payer.address.country_code (if present)
    },

    // Shipping (if you ever allow physical shipping)
    shipping: {
      name: String,
      address_line_1: String,
      admin_area_2: String,   // city
      admin_area_1: String,   // state/province
      postal_code: String,
      country_code: String,
    },

    // Financials (summary)
    amount: Money,                                        // final captured amount (sum of captures if multiple)
    breakdown: {
      itemTotal: Money,
      taxTotal: Money,
      shipping: Money,
    },

    // Captures (could be multiple)
    captures: [Capture],

    // Refunds
    refunds: [
      {
        refundId: { type: String, index: true },
        status: String,
        amount: Money,
        createdAt: Date,
      },
    ],
    refundedTotal: { type: Money, default: { value: "0.00", currency: "ZAR" } },

    // What was purchased (snapshot)
    items: [OrderItem],

    // Raw PayPal payload for audit/debug
    raw: Schema.Types.Mixed,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);

















/*// models/Order.js
const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema({
  orderId: String,
  captureId: String,
  status: String,
  currency: String,
  amount: String,
  fee: String,
  net: String,
  payer: {
    id: String,
    email: String,
    name: { given: String, surname: String },
    country: String
  },
  shipping: {
    name: String,
    address_line_1: String,
    city: String,
    state: String,
    postal_code: String,
    country_code: String
  },
  refunds: [{
    refundId: String,
    status: String,
    amount: String,
    currency: String,
    createdAt: Date
  }],
  refundedTotal: { type: String, default: "0.00" },
  captureStatus: String,
  raw: Object
}, { timestamps: true });

module.exports = mongoose.model("Order", orderSchema);
*/

