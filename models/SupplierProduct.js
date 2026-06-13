// models/SupplierProduct.js
'use strict';

const mongoose = require('mongoose');
const SupplierProductStockHistory = require('./SupplierProductStockHistory');

const SupplierProductColorImageSchema = new mongoose.Schema(
  {
    color: { type: String, trim: true, required: true },
    imageUrl: { type: String, trim: true, required: true },
  },
  { _id: false }
);

const SupplierProductShippingSchema = new mongoose.Schema(
  {
    weight: {
      value: { type: Number, default: null },
      unit: {
        type: String,
        enum: ['kg', 'g', 'lb', 'oz'],
        default: 'kg',
      },
    },
    dimensions: {
      length: { type: Number, default: null },
      width: { type: Number, default: null },
      height: { type: Number, default: null },
      unit: {
        type: String,
        enum: ['cm', 'in'],
        default: 'cm',
      },
    },
    shipSeparately: { type: Boolean, default: false },
    fragile: { type: Boolean, default: false },
    packagingHint: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const supplierProductSchema = new mongoose.Schema(
  {
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },

    customId: {
      type: String,
      trim: true,
      unique: true,
      sparse: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
      maxlength: 160,
    },

    description: {
      type: String,
      trim: true,
      maxlength: 3000,
      default: '',
    },

    imageUrl: {
      type: String,
      required: [true, 'Product image is required'],
      trim: true,
    },

    wholesalePrice: {
      type: Number,
      required: [true, 'Wholesale price is required'],
      min: [0, 'Wholesale price cannot be negative'],
    },

    minimumOrderQuantity: {
      type: Number,
      default: 1,
      min: [1, 'Minimum order quantity must be at least 1'],
    },

    availableQuantity: {
      type: Number,
      default: 0,
      min: [0, 'Available quantity cannot be negative'],
      index: true,
    },

    unit: {
      type: String,
      trim: true,
      default: 'units',
    },

    role: {
      type: String,
      trim: true,
      default: 'general',
      index: true,
    },

    type: {
      type: String,
      trim: true,
      index: true,
    },

    category: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },

    quality: {
      type: String,
      trim: true,
      default: '',
    },

    made: {
      type: String,
      trim: true,
      default: '',
    },

    madeCode: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
      index: true,
    },

    manufacturer: {
      type: String,
      trim: true,
      default: '',
    },

    keywords: {
      type: [String],
      default: [],
      index: true,
    },

    color: {
      type: String,
      trim: true,
      default: '',
    },

    size: {
      type: String,
      trim: true,
      default: '',
    },

    sizes: {
      type: [String],
      default: [],
    },

    colors: {
      type: [String],
      default: [],
    },

    colorImages: {
      type: [SupplierProductColorImageSchema],
      default: [],
    },

    countryOfOrigin: {
      type: String,
      trim: true,
      default: '',
    },

    supplyLocation: {
      country: { type: String, trim: true, default: '' },
      city: { type: String, trim: true, default: '' },
    },

    leadTimeDays: {
      type: Number,
      default: 3,
      min: [0, 'Lead time cannot be negative'],
    },

    acceptsBulkOrders: {
      type: Boolean,
      default: true,
      index: true,
    },

    shipping: {
      type: SupplierProductShippingSchema,
      default: () => ({}),
    },

    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'archived'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: true }
);

/* =========================================================
 * SUPPLIER PRODUCT STOCK HISTORY
 *
 * Records every real availableQuantity change:
 * - product creation
 * - supplier manual stock update
 * - seller wholesale import deduction
 * - failed import rollback
 * - returned seller stock
 * - product deletion
 * ======================================================= */

function safeSupplierStock(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function writeSupplierStockHistory({
  supplier,
  supplierProduct,
  productCustomId = '',
  productName = '',
  stockBefore = 0,
  stockAfter = 0,
  reason = 'stock-update',
}) {
  try {
    const before = safeSupplierStock(stockBefore);
    const after = safeSupplierStock(stockAfter);

    if (before === after) return;
    if (!supplier) return;

    await SupplierProductStockHistory.create({
      supplier,
      supplierProduct: supplierProduct || null,
      productCustomId: String(productCustomId || '').trim(),
      productName: String(productName || '').trim(),
      stockBefore: before,
      stockAfter: after,
      delta: after - before,
      reason: String(reason || 'stock-update').trim(),
    });
  } catch (err) {
    // Stock operations must not fail only because history logging failed.
    console.error('❌ Failed to write supplier stock history:', err);
  }
}

/* ---------------------------------------------------------
 * document.save()
 * Handles:
 * - new supplier products
 * - supplier edit page stock changes
 *
 * $locals is Mongoose's safe temporary storage for passing
 * information from pre-save middleware to post-save middleware.
 * ------------------------------------------------------- */
supplierProductSchema.pre('save', async function supplierStockPreSave(next) {
  try {
    this.$locals = this.$locals || {};

    if (this.isNew) {
      this.$locals.supplierStockHistory = {
        shouldWrite: true,
        stockBefore: 0,
        reason: 'product-created',
      };

      return next();
    }

    if (!this.isModified('availableQuantity')) {
      this.$locals.supplierStockHistory = {
        shouldWrite: false,
        stockBefore: safeSupplierStock(this.availableQuantity),
        reason: 'supplier-stock-update',
      };

      return next();
    }

    const existingProduct = await this.constructor
      .findById(this._id)
      .select('availableQuantity')
      .lean();

    this.$locals.supplierStockHistory = {
      shouldWrite: true,
      stockBefore: safeSupplierStock(
        existingProduct?.availableQuantity,
      ),
      reason: 'supplier-stock-update',
    };

    return next();
  } catch (err) {
    return next(err);
  }
});

supplierProductSchema.post(
  'save',
  async function supplierStockPostSave(savedProduct) {
    try {
      const historyState =
        savedProduct.$locals?.supplierStockHistory || null;

      if (!historyState?.shouldWrite) {
        return;
      }

      const stockBefore = safeSupplierStock(
        historyState.stockBefore,
      );

      const stockAfter = safeSupplierStock(
        savedProduct.availableQuantity,
      );

      if (stockBefore === stockAfter) {
        return;
      }

      await writeSupplierStockHistory({
        supplier: savedProduct.supplier,
        supplierProduct: savedProduct._id,
        productCustomId: savedProduct.customId,
        productName: savedProduct.name,
        stockBefore,
        stockAfter,
        reason:
          historyState.reason ||
          'supplier-stock-update',
      });
    } catch (err) {
      console.error(
        '❌ SupplierProduct post-save history error:',
        err,
      );
    }
  },
);

/* ---------------------------------------------------------
 * findOneAndUpdate() / findByIdAndUpdate()
 *
 * Handles:
 * - $set: { availableQuantity: ... }
 * - $inc: { availableQuantity: ... }
 *
 * Seller wholesale imports use $inc to deduct supplier stock.
 * ------------------------------------------------------- */
supplierProductSchema.pre(
  'findOneAndUpdate',
  async function supplierStockPreFindOneAndUpdate(next) {
    try {
      const update = this.getUpdate() || {};

      const changesAvailableQuantity =
        Object.prototype.hasOwnProperty.call(
          update,
          'availableQuantity',
        ) ||
        Object.prototype.hasOwnProperty.call(
          update.$set || {},
          'availableQuantity',
        ) ||
        Object.prototype.hasOwnProperty.call(
          update.$inc || {},
          'availableQuantity',
        );

      if (!changesAvailableQuantity) {
        this._supplierProductBeforeUpdate = null;
        return next();
      }

      const existingProduct = await this.model
        .findOne(this.getQuery())
        .select(
          '_id supplier customId name availableQuantity status',
        )
        .lean();

      this._supplierProductBeforeUpdate =
        existingProduct || null;

      return next();
    } catch (err) {
      return next(err);
    }
  },
);

supplierProductSchema.post(
  'findOneAndUpdate',
  async function supplierStockPostFindOneAndUpdate() {
    try {
      const beforeProduct =
        this._supplierProductBeforeUpdate;

      if (!beforeProduct?._id) return;

      const updatedProduct = await this.model
        .findById(beforeProduct._id)
        .select(
          '_id supplier customId name availableQuantity status',
        )
        .lean();

      if (!updatedProduct) return;

      const before = safeSupplierStock(
        beforeProduct.availableQuantity,
      );

      const after = safeSupplierStock(
        updatedProduct.availableQuantity,
      );

      if (before === after) return;

      const update = this.getUpdate() || {};

      const increment = safeSupplierStock(
        update.$inc?.availableQuantity,
      );

      let reason = 'supplier-stock-update';

      if (increment < 0) {
        reason = 'seller-import-deduction';
      } else if (increment > 0) {
        reason = 'stock-return-or-restock';
      }

      await writeSupplierStockHistory({
        supplier:
          updatedProduct.supplier ||
          beforeProduct.supplier,

        supplierProduct:
          updatedProduct._id ||
          beforeProduct._id,

        productCustomId:
          updatedProduct.customId ||
          beforeProduct.customId,

        productName:
          updatedProduct.name ||
          beforeProduct.name,

        stockBefore: before,
        stockAfter: after,
        reason,
      });
    } catch (err) {
      console.error(
        '❌ SupplierProduct post-findOneAndUpdate history error:',
        err,
      );
    }
  },
);

/* ---------------------------------------------------------
 * findOneAndDelete() / findByIdAndDelete()
 *
 * Removing a supplier product also removes its available
 * stock from the supplier's total inventory.
 * ------------------------------------------------------- */
supplierProductSchema.post(
  'findOneAndDelete',
  async function supplierStockPostDelete(deletedProduct) {
    try {
      if (!deletedProduct) return;

      const stockBefore = safeSupplierStock(
        deletedProduct.availableQuantity,
      );

      if (stockBefore <= 0) return;

      await writeSupplierStockHistory({
        supplier: deletedProduct.supplier,
        supplierProduct: deletedProduct._id,
        productCustomId: deletedProduct.customId,
        productName: deletedProduct.name,
        stockBefore,
        stockAfter: 0,
        reason: 'product-deleted',
      });
    } catch (err) {
      console.error(
        '❌ SupplierProduct post-delete history error:',
        err,
      );
    }
  },
);

supplierProductSchema.index({
  name: 'text',
  description: 'text',
  category: 'text',
  type: 'text',
  manufacturer: 'text',
  keywords: 'text',
});

supplierProductSchema.index({ supplier: 1, status: 1, createdAt: -1 });
supplierProductSchema.index({ status: 1, category: 1, createdAt: -1 });

module.exports =
  mongoose.models.SupplierProduct ||
  mongoose.model('SupplierProduct', supplierProductSchema);
