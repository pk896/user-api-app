// models/DeliveryOption.js
const { mongoose } = require('../db'); // <-- use the shared instance

/**
 * DeliveryOption
 * - Minimal schema aligned with your current views:
 *   name, deliveryDays, priceCents, active (+ optional description/region)
 * - Prices stored in cents to avoid floating point issues.
 */
const deliveryOptionSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
      index: true,
    },

    // Optional extras (won't break your current views)
    description: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: '',
    },
    region: {
      type: String,
      trim: true,
      maxlength: 120,
      default: '',
    },

    // e.g., 0 = same day, 1 = next day...
    deliveryDays: {
      type: Number,
      default: 0,
      min: 0,
      max: 60,
    },

    // Stored in cents (e.g., 499 = $4.99)
    priceCents: {
      type: Number,
      default: 0,
      min: 0,
    },

    active: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

/* -------- Virtuals (optional convenience) -------- */
// price (float) <-> priceCents (int)
deliveryOptionSchema
  .virtual('price')
  .get(function () {
    return typeof this.priceCents === 'number' ? Number((this.priceCents / 100).toFixed(2)) : 0;
  })
  .set(function (val) {
    const n = Number(val);
    this.priceCents = Number.isFinite(n) ? Math.round(n * 100) : 0;
  });

/* -------- Index helpers -------- */
deliveryOptionSchema.index({ active: 1, name: 1 });

/* -------- Clean JSON/object output -------- */
deliveryOptionSchema.set('toJSON', { virtuals: true });
deliveryOptionSchema.set('toObject', { virtuals: true });

module.exports =
  mongoose.models.DeliveryOption || mongoose.model('DeliveryOption', deliveryOptionSchema);

/*const { mongoose } = require('../db');

const deliveryOptionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    deliveryDays: { type: Number, required: true },
    priceCents: { type: Number, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliveryOption", deliveryOptionSchema);
*/
