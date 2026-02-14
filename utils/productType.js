// utils/productType.js
'use strict';

/**
 * Product Types (canonical)
 * - value: what you store in DB (safe: lowercase + hyphen)
 * - label: what user sees in dropdown
 *
 * Keep this list SHORT and useful.
 * You can add more later anytime.
 */

const PRODUCT_TYPES = Object.freeze([
  // Special behaviour types (variants)
  { value: 'clothes', label: 'Clothes (variants: size + color)' },
  { value: 'shoes', label: 'Shoes (variants: size + color)' },

  // General/common
  { value: 'accessory', label: 'Accessory' },
  { value: 'bag', label: 'Bag' },
  { value: 'jewelry', label: 'Jewelry' },

  // Electronics (kept simple)
  { value: 'phone', label: 'Phone' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'tv', label: 'TV' },
  { value: 'speaker', label: 'Speaker' },
  { value: 'headphones', label: 'Headphones' },
  { value: 'gaming', label: 'Gaming' },

  // Home (kept simple)
  { value: 'furniture', label: 'Furniture' },
  { value: 'kitchen', label: 'Kitchen' },
  { value: 'appliance', label: 'Appliance' },
  { value: 'decor', label: 'Decor' },

  // Beauty
  { value: 'skincare', label: 'Skincare' },
  { value: 'haircare', label: 'Haircare' },
  { value: 'makeup', label: 'Makeup' },

  // Groceries
  { value: 'beverage', label: 'Beverage / Drink' },
  { value: 'snack', label: 'Snack' },
  { value: 'food', label: 'Food / Grocery' },

  // Second-hand (generic)
  { value: 'secondhand-item', label: 'Second-hand item (general)' },
]);

/**
 * Optional mapping: Category -> recommended type values
 * (Useful later if you want to auto-filter dropdown based on category)
 */
const PRODUCT_TYPES_BY_CATEGORY = Object.freeze({
  electronics: ['phone', 'laptop', 'tv', 'speaker', 'headphones', 'gaming'],
  fashion: ['clothes', 'shoes', 'accessory', 'bag', 'jewelry'],
  home: ['furniture', 'kitchen', 'appliance', 'decor'],
  beauty: ['skincare', 'haircare', 'makeup'],
  groceries: ['beverage', 'snack', 'food'],
  clothes: ['clothes'],
  'second-hand-clothes': ['clothes', 'shoes'],
  'uncategorized-second-hand-things': ['secondhand-item', 'phone', 'laptop', 'tv', 'accessory', 'bag', 'furniture', 'appliance'],
});

// Helper: get full objects from a list of values
function pickTypes(values = []) {
  const set = new Set(values.map(v => String(v || '').trim().toLowerCase()));
  return PRODUCT_TYPES.filter(t => set.has(t.value));
}

module.exports = {
  PRODUCT_TYPES,
  PRODUCT_TYPES_BY_CATEGORY,
  pickTypes,
};
