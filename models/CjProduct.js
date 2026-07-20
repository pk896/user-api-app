// models/CjProduct.js
'use strict';

const mongoose = require('mongoose');

function getBaseCurrency() {
  const value = String(process.env.BASE_CURRENCY || 'USD')
    .trim()
    .toUpperCase();

  return /^[A-Z]{3}$/.test(value) ? value : 'USD';
}

function getVatRate() {
  const value = Number(process.env.VAT_RATE || 0.15);

  if (!Number.isFinite(value)) return 0.15;

  return Math.max(0, Math.min(1, value));
}

const MoneySchema = new mongoose.Schema(
  {
    value: {
      type: Number,
      required: true,
      min: 0,
    },

    currency: {
      type: String,
      required: true,
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

const FxSnapshotSchema = new mongoose.Schema(
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

const CjInventorySnapshotSchema = new mongoose.Schema(
  {
    countryCode: {
      type: String,
      trim: true,
      uppercase: true,
      default: '',
    },

    warehouseName: {
      type: String,
      trim: true,
      default: '',
    },

    warehouseId: {
      type: String,
      trim: true,
      default: '',
    },

    totalInventory: {
      type: Number,
      default: 0,
      min: 0,
    },

    cjInventory: {
      type: Number,
      default: 0,
      min: 0,
    },

    factoryInventory: {
      type: Number,
      default: 0,
      min: 0,
    },
  },
  {
    _id: false,
  },
);

const CjProductVariantSchema = new mongoose.Schema(
  {
    cjVariantId: {
      type: String,
      required: true,
      trim: true,
    },

    variantSku: {
      type: String,
      required: true,
      trim: true,
    },

    variantName: {
      type: String,
      trim: true,
      default: '',
    },

    variantKey: {
      type: String,
      trim: true,
      default: '',
    },

    imageUrl: {
      type: String,
      trim: true,
      default: '',
    },

    barcode: {
      type: String,
      trim: true,
      default: '',
    },

    barcode2: {
      type: String,
      trim: true,
      default: '',
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

    sourceCostUsd: {
      type: MoneySchema,
      required: true,
    },

    convertedSourceCost: {
      type: MoneySchema,
      required: true,
    },

    sellingPriceExVat: {
      type: MoneySchema,
      required: true,
    },

    fxSnapshot: {
      type: FxSnapshotSchema,
      default: () => ({}),
    },

    inventory: {
      type: [CjInventorySnapshotSchema],
      default: [],
    },

    totalInventory: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    inventoryKnown: {
      type: Boolean,
      default: false,
    },

    isEnabled: {
      type: Boolean,
      default: true,
      index: true,
    },

    lastSourceCostChangeAt: {
      type: Date,
      default: null,
    },

    lastInventorySyncAt: {
      type: Date,
      default: null,
    },

    lastSyncedAt: {
      type: Date,
      default: null,
    },
  },
  {
    _id: true,
  },
);

const CjProductImageSchema = new mongoose.Schema(
  {
    url: {
      type: String,
      required: true,
      trim: true,
    },

    sortOrder: {
      type: Number,
      default: 0,
    },
  },
  {
    _id: false,
  },
);

const cjProductSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ['CJ'],
      default: 'CJ',
      immutable: true,
      index: true,
    },

    cjProductId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    productSku: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
      index: true,
    },

    originalName: {
      type: String,
      trim: true,
      default: '',
      maxlength: 1000,
    },

    descriptionHtml: {
      type: String,
      default: '',
    },

    mainImageUrl: {
      type: String,
      required: true,
      trim: true,
    },

    images: {
      type: [CjProductImageSchema],
      default: [],
    },

    productType: {
      type: String,
      trim: true,
      default: '',
      index: true,
    },

    productUnit: {
      type: String,
      trim: true,
      default: '',
    },

    category: {
      id: {
        type: String,
        trim: true,
        default: '',
        index: true,
      },

      name: {
        type: String,
        trim: true,
        default: '',
        index: true,
      },

      firstId: {
        type: String,
        trim: true,
        default: '',
      },

      firstName: {
        type: String,
        trim: true,
        default: '',
      },

      secondId: {
        type: String,
        trim: true,
        default: '',
      },

      secondName: {
        type: String,
        trim: true,
        default: '',
      },
    },

    customs: {
      hsCode: {
        type: String,
        trim: true,
        default: '',
      },

      name: {
        type: String,
        trim: true,
        default: '',
      },

      nameEn: {
        type: String,
        trim: true,
        default: '',
      },

      materialNameEn: {
        type: String,
        trim: true,
        default: '',
      },

      packingNameEn: {
        type: String,
        trim: true,
        default: '',
      },

      logisticsProperties: {
        type: [String],
        default: [],
      },
    },

    productWeightGrams: {
      type: Number,
      default: null,
      min: 0,
    },

    packingWeightGrams: {
      type: Number,
      default: null,
      min: 0,
    },

    variants: {
      type: [CjProductVariantSchema],
      default: [],
    },

    /*
     * Published CJ rating aggregates.
     *
     * These values are maintained only by the separate
     * CJ rating utilities and routes.
     *
     * They must never be calculated from or written by
     * the internal Kasyora Rating/Product flow.
     */
    avgRating: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
      index: true,
    },

    ratingsCount: {
      type: Number,
      default: 0,
      min: 0,
      index: true,
    },

    pricing: {
      baseCurrency: {
        type: String,
        default: getBaseCurrency,
        trim: true,
        uppercase: true,
      },

      vatRate: {
        type: Number,
        default: getVatRate,
        min: 0,
        max: 1,
      },

      defaultMarkupPercent: {
        type: Number,
        default: 30,
        min: 0,
        max: 10000,
      },

      minimumSellingPriceExVat: {
        type: Number,
        default: 0,
        min: 0,
      },

      maximumSellingPriceExVat: {
        type: Number,
        default: 0,
        min: 0,
      },
    },

    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'archived'],
      default: 'draft',
      index: true,
    },

    cjSaleStatus: {
      type: String,
      trim: true,
      default: '',
    },

    cjAuthorityStatus: {
      type: String,
      trim: true,
      default: '',
    },

    cjListedNumber: {
      type: Number,
      default: 0,
      min: 0,
    },

    sourceCreatedAt: {
      type: Date,
      default: null,
    },

    importedByAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Admin',
      default: null,
      index: true,
    },

    importedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    lastFullSyncAt: {
      type: Date,
      default: null,
      index: true,
    },

    lastSyncStatus: {
      type: String,
      enum: ['NEVER', 'SUCCESS', 'FAILED', 'PARTIAL'],
      default: 'NEVER',
      index: true,
    },

    lastSyncError: {
      type: String,
      trim: true,
      default: '',
      maxlength: 2000,
    },

    lastCjRequestId: {
      type: String,
      trim: true,
      default: '',
    },
  },
  {
    timestamps: true,
    minimize: false,
  },
);

cjProductSchema.index({
  name: 'text',
  productSku: 'text',
  'variants.variantSku': 'text',
  'category.name': 'text',
});

cjProductSchema.index({
  status: 1,
  updatedAt: -1,
});

/*
 * Supports CJ shop sorting by real published ratings.
 */
cjProductSchema.index({
  status: 1,
  avgRating: -1,
  ratingsCount: -1,
  updatedAt: -1,
});

cjProductSchema.index({
  'variants.cjVariantId': 1,
});

cjProductSchema.virtual('enabledVariants').get(function enabledVariants() {
  return Array.isArray(this.variants) ? this.variants.filter((variant) => variant.isEnabled) : [];
});

cjProductSchema.set('toJSON', {
  virtuals: true,
});

cjProductSchema.set('toObject', {
  virtuals: true,
});

module.exports = mongoose.model('CjProduct', cjProductSchema);
