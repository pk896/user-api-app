// models/Product.js
'use strict';

const mongoose = require('mongoose');

// ==========================
// 📦 Shipping / Physical data
// ==========================
const ProductShippingSchema = new mongoose.Schema(
  {
    weight: {
      value: {
        type: Number,
        required: [true, 'Shipping weight is required'],
        min: [0.001, 'Shipping weight must be greater than 0'],
      },
      unit: { type: String, enum: ['kg', 'g', 'lb', 'oz'], default: 'kg' },
    },

    dimensions: {
      length: {
        type: Number,
        required: [true, 'Shipping length is required'],
        min: [0.001, 'Shipping length must be greater than 0'],
      },
      width: {
        type: Number,
        required: [true, 'Shipping width is required'],
        min: [0.001, 'Shipping width must be greater than 0'],
      },
      height: {
        type: Number,
        required: [true, 'Shipping height is required'],
        min: [0.001, 'Shipping height must be greater than 0'],
      },
      unit: { type: String, enum: ['cm', 'in'], default: 'cm' },
    },

    // keep these for later; only fragile is used for splitting right now
    shipSeparately: { type: Boolean, default: false },
    fragile: { type: Boolean, default: false },
    packagingHint: { type: String, trim: true, default: '' },
  },
  { _id: false },
);

const productSchema = new mongoose.Schema(
  {
    // Human-friendly id separate from _id
    customId: {
      type: String,
      required: true,
      unique: true, // uniqueness at schema level
      index: true, // explicit index for speed
      trim: true,
    },

    name: {
      type: String,
      required: [true, 'Product name is required'],
      trim: true,
    },

    // Numeric price (estimates will use this; orders should snapshot unit price)
    price: {
      type: Number,
      required: [true, 'Price is required'],
      min: [0, 'Price must be a positive number'],
    },

    description: {
      type: String,
      trim: true,
      maxlength: 2000,
    },

    imageUrl: {
      type: String,
      required: [true, 'Product image is required'],
      validate: {
        validator: (v) => /^https?:\/\/.+/.test(v),
        message: (props) => `${props.value} is not a valid image URL!`,
      },
    },

    stock: {
      type: Number,
      default: 0,
      min: [0, 'Stock cannot be negative'],
    },

    // Product role/type - determines if it has variants like size/color
    role: {
      type: String,
      enum: ['general', 'clothes', 'shoes', 'electronics', 'home', 'beauty', 'groceries'],
      default: 'general',
      index: true,
    },

    // For clothing products: array of available sizes
    sizes: {
      type: [String], // Array of strings like ["S", "M", "L", "XL"]
      default: [],
      validate: {
        validator: function (v) {
          const role = (this.role || '').toLowerCase();
          const type = (this.type || '').toLowerCase();

          const needsVariants =
            role === 'clothes' || role === 'shoes' || type === 'clothes' || type === 'shoes';

          if (needsVariants) {
            return Array.isArray(v) && v.length > 0;
          }
          return true;
        },
        message: 'Clothing/shoes products must have at least one size option',
      },
    },

    // For clothing products: array of available colors
    colors: {
      type: [String], // Array of strings like ["Red", "Blue", "Black"]
      default: [],
      validate: {
        validator: function (v) {
          const role = (this.role || '').toLowerCase();
          const type = (this.type || '').toLowerCase();

          const needsVariants =
            role === 'clothes' || role === 'shoes' || type === 'clothes' || type === 'shoes';

          if (needsVariants) {
            return Array.isArray(v) && v.length > 0;
          }
          return true;
        },
        message: 'Clothing/shoes products must have at least one color option',
      },
    },

    // Original single color/size fields (for backward compatibility)
    color: {
      type: String,
      trim: true,
      // Only used for non-clothing products or as default
    },
    size: {
      type: String,
      trim: true,
      // Only used for non-clothing products or as default
    },

    // Classification / attributes
    category: {
      type: String,
      trim: true,
      index: true,
    },
    quality: {
      type: String,
      trim: true,
    },
    made: {
      type: String,
      trim: true,
    },
    manufacturer: {
      type: String,
      trim: true,
    },

    // Matching type
    type: {
      type: String,
      trim: true,
      index: true,
    },

    // Product status flags (for filtering/sorting)
    isNewItem: {
      type: Boolean,
      default: false,
      index: true,
    },
    isOnSale: {
      type: Boolean,
      default: false,
      index: true,
    },
    isPopular: {
      type: Boolean,
      default: false,
      index: true,
    },

    // Sales counters
    soldCount: {
      type: Number,
      default: 0,
    }, // total quantity sold
    soldOrders: {
      type: Number,
      default: 0,
    }, // distinct orders count

    // ==========================
    // 📦 Shipping measurements
    // ==========================
    shipping: {
      type: ProductShippingSchema,
      default: () => ({}),
    },

    // Owner business
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
  },
  {
    timestamps: true,
    // Add toJSON transformation to include virtuals if needed
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

/* ========= VIRTUALS ========= */

// Virtual for checking if product is in stock
productSchema.virtual('inStock').get(function () {
  return this.stock > 0;
});

// Virtual for product type based on role
productSchema.virtual('productType').get(function () {
  return this.role ? this.role.charAt(0).toUpperCase() + this.role.slice(1) : 'General';
});

// Virtuals for sale / popular (backwards compatibility with EJS that uses p.sale / p.popular)
productSchema
  .virtual('sale')
  .get(function () {
    return this.isOnSale;
  })
  .set(function (v) {
    this.isOnSale = !!v;
  });

productSchema
  .virtual('popular')
  .get(function () {
    return this.isPopular;
  })
  .set(function (v) {
    this.isPopular = !!v;
  });

/* ========= MIDDLEWARE ========= */
// Middleware to ensure size/color arrays are valid and in sync
productSchema.pre('save', function (next) {
  const role = (this.role || '').toLowerCase();
  const type = (this.type || '').toLowerCase();

  // We want variants for clothes + shoes (because your shop uses type to control size/color)
  const wantsVariants =
    role === 'clothes' || role === 'shoes' || type === 'clothes' || type === 'shoes';

  if (!wantsVariants) {
    return next();
  }

  // Make sure these fields are proper arrays
  if (!Array.isArray(this.colors)) {
    this.colors = this.colors ? [this.colors] : [];
  }
  if (!Array.isArray(this.sizes)) {
    this.sizes = this.sizes ? [this.sizes] : [];
  }

  // If arrays are still empty but single fields exist, seed them
  if (this.color && this.colors.length === 0) {
    this.colors.push(this.color);
  }
  if (this.size && this.sizes.length === 0) {
    this.sizes.push(this.size);
  }

  // Clean & dedupe
  if (this.colors && this.colors.length > 0) {
    this.colors = [...new Set(this.colors.map((c) => (c || '').toString().trim()).filter(Boolean))];
  }

  if (this.sizes && this.sizes.length > 0) {
    this.sizes = [...new Set(this.sizes.map((s) => (s || '').toString().trim()).filter(Boolean))];
  }

  next();
});

/* ========= INSTANCE METHODS ========= */

// Helper method to check if a specific variant is available
productSchema.methods.isVariantAvailable = function (size, color) {
  // Only enforce for clothes / shoes; for others, just return stock > 0
  const role = (this.role || '').toLowerCase();
  const type = (this.type || '').toLowerCase();

  const needsVariants =
    role === 'clothes' || role === 'shoes' || type === 'clothes' || type === 'shoes';

  if (!needsVariants) {
    return this.stock > 0;
  }

  let available = true;

  if (size && Array.isArray(this.sizes) && this.sizes.length > 0) {
    available = available && this.sizes.includes(size);
  }

  if (color && Array.isArray(this.colors) && this.colors.length > 0) {
    available = available && this.colors.includes(color);
  }

  return available && this.stock > 0;
};

productSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  // Optionally remove business details if not needed
  // delete obj.business;
  return obj;
};

// Method to get product details for frontend
productSchema.methods.toFrontendJSON = function () {
  return {
    customId: this.customId,
    name: this.name,
    price: this.price,
    description: this.description,
    imageUrl: this.imageUrl,
    stock: this.stock,
    
    // Shipping measurements (used for Shippo packing/rates)
    shipping: this.shipping || null,

    inStock: this.inStock,
    role: this.role,
    sizes: this.sizes,
    colors: this.colors,
    category: this.category,
    type: this.type,
    isNew: this.isNew,
    isOnSale: this.isOnSale,
    isPopular: this.isPopular,
    sale: this.isOnSale, // short flags for templates if needed
    popular: this.isPopular,
    soldCount: this.soldCount,
    // Include single fields for backward compatibility
    color: this.color,
    size: this.size,
    // Timestamps if needed
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
};

/* ========= STATICS ========= */

// Static method to find clothing-like products (clothes + shoes)
productSchema.statics.findClothing = function () {
  return this.find({ role: { $in: ['clothes', 'shoes'] } });
};

// Static method to find products with variants
productSchema.statics.findWithVariants = function () {
  return this.find({
    $or: [
      { role: 'clothes' },
      { role: 'shoes' },
      {
        $and: [{ sizes: { $exists: true, $ne: [] } }, { colors: { $exists: true, $ne: [] } }],
      },
    ],
  });
};

/* ========= INDEXES ========= */

// Helpful compound indexes for common queries
productSchema.index({ business: 1, role: 1 });
productSchema.index({ category: 1, role: 1 });
//productSchema.index({ isNew: 1, isOnSale: 1, isPopular: 1 });
// NEW
productSchema.index({ isNewItem: 1, isOnSale: 1, isPopular: 1 });

// Virtual for backwards compatibility with code/templates that use product.isNew
productSchema
  .virtual('isNew')
  .get(function () {
    return this.isNewItem;
  })
  .set(function (v) {
    this.isNewItem = !!v;
  });

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
