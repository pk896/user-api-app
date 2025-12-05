// models/Product.js
//const { mongoose } = require('../db');
const mongoose = require('mongoose');

const productSchema = new mongoose.Schema(
  {
    // Human-friendly id separate from _id
    customId: {
      type: String,
      required: true,
      unique: true,           // uniqueness at schema level
      index: true,            // explicit index for speed
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
      enum: ['general', 'clothes', 'electronics', 'home', 'beauty', 'groceries'],
      default: 'general',
      index: true,
    },

    // For clothing products: array of available sizes
    sizes: { 
      type: [String], // Array of strings like ["S", "M", "L", "XL"]
      default: [],
      validate: {
        validator: function(v) {
          // Only require sizes if product is clothing
          if (this.role === 'clothes') {
            return v && v.length > 0;
          }
          return true;
        },
        message: 'Clothing products must have at least one size option'
      }
    },

    // For clothing products: array of available colors
    colors: { 
      type: [String], // Array of strings like ["Red", "Blue", "Black"]
      default: [],
      validate: {
        validator: function(v) {
          // Only require colors if product is clothing
          if (this.role === 'clothes') {
            return v && v.length > 0;
          }
          return true;
        },
        message: 'Clothing products must have at least one color option'
      }
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
      index: true 
    },
    quality: { 
      type: String, 
      trim: true 
    },
    made: { 
      type: String, 
      trim: true 
    },
    manufacturer: { 
      type: String, 
      trim: true 
    },

    // Matching type
    type: { 
      type: String, 
      trim: true, 
      index: true 
    },

    // Product status flags (for filtering/sorting)
    isNew: {
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
      default: 0 
    },  // total quantity sold
    soldOrders: { 
      type: Number, 
      default: 0 
    }, // distinct orders count

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
    toObject: { virtuals: true }
  },
);

// Virtual for checking if product is in stock
productSchema.virtual('inStock').get(function() {
  return this.stock > 0;
});

// Virtual for product type based on role
productSchema.virtual('productType').get(function() {
  return this.role.charAt(0).toUpperCase() + this.role.slice(1);
});

// Middleware to ensure size/color arrays are valid
productSchema.pre('save', function(next) {
  // If role is clothes and arrays are empty but single fields exist, convert
  if (this.role === 'clothes') {
    if (this.color && this.colors.length === 0) {
      this.colors = [this.color];
    }
    if (this.size && this.sizes.length === 0) {
      this.sizes = [this.size];
    }
    
    // Ensure arrays are unique
    if (this.colors && this.colors.length > 0) {
      this.colors = [...new Set(this.colors.map(c => c.trim()))];
    }
    if (this.sizes && this.sizes.length > 0) {
      this.sizes = [...new Set(this.sizes.map(s => s.trim()))];
    }
  }
  next();
});

// Helper method to check if a specific variant is available
productSchema.methods.isVariantAvailable = function(size, color) {
  if (this.role !== 'clothes') return true;
  
  let available = true;
  
  if (size && this.sizes && this.sizes.length > 0) {
    available = available && this.sizes.includes(size);
  }
  
  if (color && this.colors && this.colors.length > 0) {
    available = available && this.colors.includes(color);
  }
  
  return available && this.stock > 0;
};

// Static method to find clothing products
productSchema.statics.findClothing = function() {
  return this.find({ role: 'clothes' });
};

// Static method to find products with variants
productSchema.statics.findWithVariants = function() {
  return this.find({
    $or: [
      { role: 'clothes' },
      { $and: [
        { sizes: { $exists: true, $ne: [] } },
        { colors: { $exists: true, $ne: [] } }
      ]}
    ]
  });
};

// Helpful compound indexes for common queries
productSchema.index({ business: 1, role: 1 });
productSchema.index({ category: 1, role: 1 });
productSchema.index({ isNew: 1, isOnSale: 1, isPopular: 1 });

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
    inStock: this.inStock,
    role: this.role,
    sizes: this.sizes,
    colors: this.colors,
    category: this.category,
    type: this.type,
    isNew: this.isNew,
    isOnSale: this.isOnSale,
    isPopular: this.isPopular,
    soldCount: this.soldCount,
    // Include single fields for backward compatibility
    color: this.color,
    size: this.size,
    // Timestamps if needed
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);