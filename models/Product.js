// models/Product.js
const { mongoose } = require('../db');

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

    // Classification / attributes
    category: { type: String, trim: true, index: true },
    color: { type: String, trim: true },
    size: { type: String, trim: true },
    quality: { type: String, trim: true },
    made: { type: String, trim: true },
    manufacturer: { type: String, trim: true },

    // Matching type
    type: { type: String, trim: true, index: true },

    // Sales counters
    soldCount: { type: Number, default: 0 },  // total quantity sold
    soldOrders: { type: Number, default: 0 }, // distinct orders count

    // Owner business
    business: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Business',
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

// Helpful compound for dashboards/queries
// productSchema.index({ business: 1, customId: 1 }); // if you often filter both

productSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  delete obj.__v;
  return obj;
};

module.exports = mongoose.models.Product || mongoose.model('Product', productSchema);
