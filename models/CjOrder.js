// models/CjOrder.js
'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

function getBaseCurrency() {
  const currency = String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase();

  return /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
}

const MoneySchema = new Schema(
  {
    value: {
      type: String,
      required: true,
      trim: true,
    },

    currency: {
      type: String,
      required: true,
      default: getBaseCurrency,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },
  },
  {
    _id: false,
  },
);

const FxSnapshotSchema = new Schema(
  {
    rate: {
      type: Number,
      default: null,
    },

    from: {
      type: String,
      trim: true,
      uppercase: true,
      default: 'USD',
    },

    to: {
      type: String,
      trim: true,
      uppercase: true,
      default: getBaseCurrency,
    },

    provider: {
      type: String,
      trim: true,
      default: '',
    },

    convertedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  },
);

const CjOrderItemSchema = new Schema(
  {
    source: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      immutable: true,
    },

    cjProductId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    cjVariantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    productSku: {
      type: String,
      trim: true,
      default: '',
    },

    variantSku: {
      type: String,
      trim: true,
      default: '',
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    variantName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 500,
    },

    imageUrl: {
      type: String,
      trim: true,
      default: '',
    },

    category: {
      type: String,
      trim: true,
      default: '',
    },

    quantity: {
      type: Number,
      required: true,
      min: 1,
      max: 100,
    },

    /*
     * Authoritative VAT-free CJ item prices.
     *
     * Kasyora adds and collects no VAT in the CJ department.
     */
    unitPrice: {
      type: MoneySchema,
      default: undefined,
    },

    lineTotal: {
      type: MoneySchema,
      default: undefined,
    },

    /*
     * Historical CJ money field names.
     *
     * For all new CJ orders:
     * - unitPriceExVat and unitPriceIncVat contain the same
     *   VAT-free CJ selling price.
     * - unitVatAmount is always 0.00.
     * - lineSubtotalExVat and lineTotalIncVat contain the same
     *   VAT-free line total.
     * - lineVatAmount is always 0.00.
     *
     * These names remain temporarily for compatibility with
     * existing CJ order, email and supplier-order code.
     */
    unitPriceExVat: {
      type: MoneySchema,
      required: true,
    },

    unitVatAmount: {
      type: MoneySchema,
      required: true,
    },

    unitPriceIncVat: {
      type: MoneySchema,
      required: true,
    },

    lineSubtotalExVat: {
      type: MoneySchema,
      required: true,
    },

    lineVatAmount: {
      type: MoneySchema,
      required: true,
    },

    lineTotalIncVat: {
      type: MoneySchema,
      required: true,
    },

    /*
     * Kasyora adds and collects no VAT on CJ order items.
     *
     * Destination import VAT, customs duties and carrier
     * charges remain outside this local order calculation.
     */
    vatRate: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 0,
    },

    weightGrams: {
      type: Number,
      default: null,
      min: 0,
    },

    dimensionsMm: {
      length: {
        type: Number,
        default: null,
        min: 0,
      },

      width: {
        type: Number,
        default: null,
        min: 0,
      },

      height: {
        type: Number,
        default: null,
        min: 0,
      },
    },

    inventoryKnown: {
      type: Boolean,
      default: false,
    },

    inventorySnapshot: {
      type: Number,
      default: 0,
      min: 0,
    },

    validatedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  },
);

const CjDeliveryAddressSchema = new Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true,
    },

    lastName: {
      type: String,
      required: true,
      trim: true,
    },

    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
    },

    companyName: {
      type: String,
      trim: true,
      default: '',
    },

    addressLine1: {
      type: String,
      required: true,
      trim: true,
    },

    addressLine2: {
      type: String,
      trim: true,
      default: '',
    },

    houseNumber: {
      type: String,
      trim: true,
      default: '',
    },

    suburb: {
      type: String,
      trim: true,
      default: '',
    },

    city: {
      type: String,
      required: true,
      trim: true,
    },

    province: {
      type: String,
      required: true,
      trim: true,
    },

    postalCode: {
      type: String,
      required: true,
      trim: true,
    },

    countryCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    taxId: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },

    iossNumber: {
      type: String,
      trim: true,
      default: '',
      select: false,
    },
  },
  {
    _id: false,
  },
);

const CjShippingSchema = new Schema(
  {
    source: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      immutable: true,
    },

    /*
     * Normalized shipping-option identifier returned by the
     * CJ freight calculation flow.
     */
    id: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    quoteRequestId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    quoteCreatedAt: {
      type: Date,
      default: null,
    },

    quoteExpiresAt: {
      type: Date,
      default: null,
    },

    originCountryCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    destinationCountryCode: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    optionId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    channelId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    logisticsOptionId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    logisticsName: {
      type: String,
      required: true,
      trim: true,
    },

    logisticsModel: {
      type: String,
      trim: true,
      default: '',
    },

    deliveryEstimate: {
      type: String,
      trim: true,
      default: '',
    },

    shippingAmount: {
      type: MoneySchema,
      required: true,
    },

    /*
     * Historical zero-VAT compatibility product total stored
     * with the selected shipping snapshot.
     *
     * This is not a VAT-inclusive calculation. It contains the
     * same VAT-free CJ product total used by the order.
     */
    productTotalIncVat: {
      type: MoneySchema,
      default: undefined,
    },

    /*
     * Product total plus the selected CJ shipping amount.
     * This is a fulfilment snapshot and does not alter the
     * customer's captured PayPal total.
     */
    payableTotal: {
      type: MoneySchema,
      default: undefined,
    },

    freightUsd: {
      type: MoneySchema,
      required: true,
    },

    taxesFeeUsd: {
      type: MoneySchema,
      required: true,
    },

    clearanceOperationFeeUsd: {
      type: MoneySchema,
      required: true,
    },

    tariffUsd: {
      type: MoneySchema,
      required: true,
    },

    remoteFeeUsd: {
      type: MoneySchema,
      required: true,
    },

    fxSnapshot: {
      type: FxSnapshotSchema,
      default: () => ({}),
    },

    selectedAt: {
      type: Date,
      required: true,
    },

    selectedByAdmin: {
      type: Boolean,
      default: false,
    },

    message: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },
  },
  {
    _id: false,
  },
);

const CjPayerSchema = new Schema(
  {
    payerId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true,
    },

    givenName: {
      type: String,
      trim: true,
      default: '',
    },

    surname: {
      type: String,
      trim: true,
      default: '',
    },

    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },
  },
  {
    _id: false,
  },
);

const CjPaypalSchema = new Schema(
  {
    orderId: {
      type: String,
      trim: true,
      default: '',
    },

    orderStatus: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },

    captureId: {
      type: String,
      trim: true,
      default: '',
    },

    captureStatus: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
      index: true,
    },

    purchaseUnitReferenceId: {
      type: String,
      trim: true,
      default: '',
    },

    customId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    invoiceId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    amount: {
      type: MoneySchema,
      default: undefined,
    },

    createdAt: {
      type: Date,
      default: null,
    },

    capturedAt: {
      type: Date,
      default: null,
    },

    rawCreateResponse: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },

    rawCaptureResponse: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },
  },
  {
    _id: false,
  },
);

const CjSupplierOrderSchema = new Schema(
  {
    createStatus: {
      type: String,
      enum: ['NOT_CREATED', 'PENDING', 'PROCESSING', 'SUCCESS', 'FAILED'],
      default: 'NOT_CREATED',
      index: true,
    },

    cjOrderId: {
      type: String,
      trim: true,
      default: '',
    },

    cjOrderNumber: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    trackingNumber: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    trackingUrl: {
      type: String,
      trim: true,
      default: '',
    },

    logisticsName: {
      type: String,
      trim: true,
      default: '',
    },

    createAttemptedAt: {
      type: Date,
      default: null,
    },

    createdAt: {
      type: Date,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    lastErrorCode: {
      type: String,
      trim: true,
      default: '',
    },

    lastErrorMessage: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    lastRequestId: {
      type: String,
      trim: true,
      default: '',
    },

    createRequestSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },

    createResponseSnapshot: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },
  },
  {
    _id: false,
  },
);

const CjTrackingEventSchema = new Schema(
  {
    status: {
      type: String,
      trim: true,
      default: '',
    },

    description: {
      type: String,
      trim: true,
      default: '',
    },

    location: {
      type: String,
      trim: true,
      default: '',
    },

    occurredAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: false,
  },
);

const CjTrackingSchema = new Schema(
  {
    status: {
      type: String,
      enum: [
        'PENDING',
        'PROCESSING',
        'SHIPPED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'CANCELLED',
        'RETURNED',
        'FAILED',
      ],
      default: 'PENDING',
      index: true,
    },

    trackingNumber: {
      type: String,
      trim: true,
      default: '',
    },

    trackingUrl: {
      type: String,
      trim: true,
      default: '',
    },

    carrierName: {
      type: String,
      trim: true,
      default: '',
    },

    estimatedDelivery: {
      type: Date,
      default: null,
    },

    events: {
      type: [CjTrackingEventSchema],
      default: [],
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },

    lastError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },
  },
  {
    _id: false,
  },
);

const CjRefundSchema = new Schema(
  {
    refundId: {
      type: String,
      trim: true,
      required: true,
      index: true,
    },

    captureId: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    status: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },

    amount: {
      type: MoneySchema,
      required: true,
    },

    reason: {
      type: String,
      trim: true,
      default: '',
    },

    source: {
      type: String,
      trim: true,
      default: '',
    },

    recordedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    _id: false,
  },
);

const cjOrderSchema = new Schema(
  {
    department: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      immutable: true,
      index: true,
    },

    cjOrderNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },

    businessBuyerId: {
      type: Schema.Types.ObjectId,
      ref: 'Business',
      default: null,
      index: true,
    },

    guestSessionId: {
      type: String,
      trim: true,
      default: '',
      index: true,
      select: false,
    },

    customerEmail: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      index: true,
    },

    status: {
      type: String,
      enum: [
        'PAYMENT_PENDING',
        'PAID',
        'CJ_ORDER_PENDING',
        'CJ_ORDER_CREATED',
        'PROCESSING',
        'SHIPPED',
        'DELIVERED',
        'CANCELLED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'PAYMENT_FAILED',
      ],
      default: 'PAYMENT_PENDING',
      index: true,
    },

    paymentStatus: {
      type: String,
      enum: [
        'CREATED',
        'APPROVED',
        'PENDING',
        'COMPLETED',
        'DECLINED',
        'CANCELLED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'FAILED',
      ],
      default: 'CREATED',
      index: true,
    },

    fulfillmentStatus: {
      type: String,
      enum: [
        'PENDING',
        'CJ_ORDER_PENDING',
        'CJ_ORDER_CREATED',
        'PROCESSING',
        'SHIPPED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
        'CANCELLED',
        'RETURNED',
        'FAILED',
      ],
      default: 'PENDING',
      index: true,
    },

    currency: {
      type: String,
      required: true,
      default: getBaseCurrency,
      trim: true,
      uppercase: true,
      minlength: 3,
      maxlength: 3,
    },

    /*
     * Kasyora-added VAT is always zero for the separate
     * CJ Dropshipping order flow.
     */
    vatRate: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      max: 0,
    },

    items: {
      type: [CjOrderItemSchema],
      required: true,
      validate: {
        validator(value) {
          return Array.isArray(value) && value.length > 0;
        },

        message: 'A CJ order must contain at least one item.',
      },
    },

    itemCount: {
      type: Number,
      required: true,
      min: 1,
    },

    /*
     * Authoritative VAT-free CJ product total.
     *
     * This is the total of all CJ order items before shipping.
     * Kasyora adds and collects no VAT in the CJ department.
     */
    productTotal: {
      type: MoneySchema,
      default: undefined,
    },

    /*
     * Historical CJ order-total field names.
     *
     * For all new CJ orders:
     * - productSubtotalExVat and productTotalIncVat contain
     *   the same VAT-free product total.
     * - productVatAmount is always 0.00.
     *
     * These names remain temporarily for compatibility with
     * existing order, email, admin and supplier-order code.
     */
    productSubtotalExVat: {
      type: MoneySchema,
      required: true,
    },

    productVatAmount: {
      type: MoneySchema,
      required: true,
    },

    productTotalIncVat: {
      type: MoneySchema,
      required: true,
    },

    shippingTotal: {
      type: MoneySchema,
      required: true,
    },

    payableTotal: {
      type: MoneySchema,
      required: true,
    },

    deliveryAddress: {
      type: CjDeliveryAddressSchema,
      required: true,
    },

    selectedShipping: {
      type: CjShippingSchema,
      required: true,
    },

    payer: {
      type: CjPayerSchema,
      default: () => ({}),
    },

    paypal: {
      type: CjPaypalSchema,
      default: () => ({}),
    },

    supplierOrder: {
      type: CjSupplierOrderSchema,
      default: () => ({}),
    },

    tracking: {
      type: CjTrackingSchema,
      default: () => ({}),
    },

    refunds: {
      type: [CjRefundSchema],
      default: [],
    },

    refundedTotal: {
      type: MoneySchema,
      default: () => ({
        value: '0.00',
        currency: getBaseCurrency(),
      }),
    },

    paidAt: {
      type: Date,
      default: null,
      index: true,
    },

    cancelledAt: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    lastPaymentErrorCode: {
      type: String,
      trim: true,
      default: '',
    },

    lastPaymentErrorMessage: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    metadata: {
      type: Schema.Types.Mixed,
      default: {},
      select: false,
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

cjOrderSchema.index({
  customerEmail: 1,
  createdAt: -1,
});

cjOrderSchema.index({
  status: 1,
  createdAt: -1,
});

cjOrderSchema.index({
  paymentStatus: 1,
  createdAt: -1,
});

cjOrderSchema.index({
  fulfillmentStatus: 1,
  createdAt: -1,
});

cjOrderSchema.index({
  'paypal.orderId': 1,
});

cjOrderSchema.index({
  'paypal.captureId': 1,
});

cjOrderSchema.index({
  'supplierOrder.cjOrderId': 1,
});

cjOrderSchema.index({
  'tracking.trackingNumber': 1,
});

module.exports = mongoose.model('CjOrder', cjOrderSchema);
