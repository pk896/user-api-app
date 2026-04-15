// utils/productType.js
'use strict';

/**
 * Product Types (canonical)
 * - value: what you store in DB (safe: lowercase + hyphen)
 * - label: what user sees in dropdown
 *
 * Product type = the actual kind of item being sold.
 * Category = the top-level department it belongs to.
 *
 * Keep the list broad and practical for most e-commerce stores.
 */

const PRODUCT_TYPES = Object.freeze([
  // Fashion / variant-heavy
  { value: 'clothes', label: 'Clothes (variants: size + color)' },
  { value: 'shoes', label: 'Shoes (variants: size + color)' },

  // General / lifestyle
  { value: 'accessory', label: 'Accessory' },
  { value: 'bag', label: 'Bag' },
  { value: 'jewelry', label: 'Jewelry' },
  { value: 'luggage', label: 'Luggage / Travel Item' },

  // Electronics
  { value: 'phone', label: 'Phone' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'monitor', label: 'Monitor' },
  { value: 'tv', label: 'TV' },
  { value: 'speaker', label: 'Speaker' },
  { value: 'headphones', label: 'Headphones' },
  { value: 'smartwatch', label: 'Smartwatch / Wearable' },
  { value: 'camera', label: 'Camera' },
  { value: 'printer', label: 'Printer / Scanner' },
  { value: 'computer-accessory', label: 'Computer Accessory' },
  { value: 'mobile-accessory', label: 'Mobile Accessory' },
  { value: 'gaming-console', label: 'Gaming Console' },
  { value: 'gaming', label: 'Gaming Accessory' },
  { value: 'digital-product', label: 'Digital Product' },

  // Home / living
  { value: 'furniture', label: 'Furniture' },
  { value: 'kitchen', label: 'Kitchen Item' },
  { value: 'appliance', label: 'Appliance' },
  { value: 'decor', label: 'Decor' },
  { value: 'bedding', label: 'Bedding' },
  { value: 'bath', label: 'Bath' },
  { value: 'storage', label: 'Storage & Organization' },
  { value: 'cleaning', label: 'Cleaning Supply' },
  { value: 'tool', label: 'Tool' },
  { value: 'outdoor', label: 'Outdoor / Garden Item' },

  // Beauty / health
  { value: 'skincare', label: 'Skincare' },
  { value: 'haircare', label: 'Haircare' },
  { value: 'makeup', label: 'Makeup' },
  { value: 'medical-supply', label: 'Medical Supply' },
  { value: 'supplement', label: 'Supplement / Wellness' },

  // Family / lifestyle
  { value: 'toy', label: 'Toy' },
  { value: 'baby-product', label: 'Baby Product' },
  { value: 'pet-food', label: 'Pet Food' },
  { value: 'pet-accessory', label: 'Pet Accessory' },
  { value: 'sports-equipment', label: 'Sports Equipment' },
  { value: 'party-supply', label: 'Party Supply' },
  { value: 'seasonal-item', label: 'Seasonal Item' },

  // Food
  { value: 'beverage', label: 'Beverage / Drink' },
  { value: 'snack', label: 'Snack' },
  { value: 'food', label: 'Food / Grocery' },

  // Books / office / creative
  { value: 'book', label: 'Book' },
  { value: 'office-supply', label: 'Office Supply' },
  { value: 'art-supply', label: 'Art Supply' },
  { value: 'musical-instrument', label: 'Musical Instrument' },

  // Auto / business
  { value: 'auto-part', label: 'Auto Part / Accessory' },
  { value: 'industrial-tool', label: 'Industrial Tool / Supply' },

  // Second-hand
  { value: 'secondhand-item', label: 'Second-hand item (general)' },
]);

/**
 * Optional mapping: Category -> recommended type values
 * Useful if you want to auto-filter the type dropdown based on category.
 *
 * Notes:
 * - Keys must exactly match values from utils/category.js
 * - Values must exactly match type values from PRODUCT_TYPES
 */
const PRODUCT_TYPES_BY_CATEGORY = Object.freeze({
  // Core electronics
  electronics: [
    'phone',
    'tablet',
    'laptop',
    'monitor',
    'tv',
    'speaker',
    'headphones',
    'camera',
    'smartwatch',
    'computer-accessory',
    'mobile-accessory',
  ],
  computers: [
    'laptop',
    'monitor',
    'printer',
    'computer-accessory',
    'digital-product',
  ],
  phones: [
    'phone',
    'tablet',
    'headphones',
    'smartwatch',
    'mobile-accessory',
  ],
  gaming: [
    'gaming-console',
    'gaming',
    'headphones',
    'speaker',
    'accessory',
  ],
  wearables: ['smartwatch', 'accessory'],
  'camera-photo': ['camera', 'accessory', 'bag'],
  'printing-scanning': ['printer', 'computer-accessory'],
  'smart-home-security': ['camera', 'accessory'],
  'software-digital': ['digital-product'],

  // Home / living
  'home-kitchen': ['kitchen', 'appliance', 'decor', 'storage', 'cleaning'],
  furniture: ['furniture', 'decor', 'storage'],
  appliances: ['appliance'],
  'bedding-bath': ['bedding', 'bath'],
  'storage-organization': ['storage'],
  'garden-outdoor': ['outdoor', 'decor', 'tool', 'accessory'],
  'tools-hardware': ['tool', 'accessory'],
  household: ['cleaning', 'decor', 'storage'],

  // Beauty / health
  'beauty-personal-care': ['skincare', 'haircare', 'makeup'],
  'health-wellness': ['supplement', 'medical-supply', 'skincare'],
  pharmacy: ['medical-supply', 'supplement'],

  // Fashion
  fashion: ['clothes', 'shoes', 'accessory', 'bag', 'jewelry'],
  clothes: ['clothes'],
  shoes: ['shoes'],
  'jewelry-watches': ['jewelry', 'accessory'],
  'travel-luggage': ['luggage', 'bag', 'accessory'],

  // Family / lifestyle
  'baby-kids': ['clothes', 'shoes', 'baby-product', 'toy', 'accessory'],
  'toys-games': ['toy', 'gaming', 'accessory'],
  'sports-outdoors': ['sports-equipment', 'bag', 'accessory', 'outdoor'],
  pets: ['pet-food', 'pet-accessory'],
  'party-events': ['party-supply', 'decor', 'accessory'],
  seasonal: ['seasonal-item', 'decor', 'accessory'],

  // Food
  groceries: ['beverage', 'snack', 'food'],

  // Books / office / creative
  books: ['book'],
  stationery: ['office-supply', 'accessory'],
  office: ['office-supply', 'printer', 'computer-accessory'],
  'arts-crafts': ['art-supply', 'accessory'],
  music: ['musical-instrument', 'accessory'],

  // Auto / business
  automotive: ['auto-part', 'accessory'],
  industrial: ['industrial-tool', 'tool', 'accessory'],

  // Fallback
  other: [
    'accessory',
    'bag',
    'digital-product',
    'secondhand-item',
  ],

  // Existing second-hand mappings kept for compatibility
  'second-hand-clothes': ['clothes', 'shoes', 'accessory', 'bag'],
  'uncategorized-second-hand-things': [
    'secondhand-item',
    'phone',
    'tablet',
    'laptop',
    'monitor',
    'tv',
    'speaker',
    'headphones',
    'smartwatch',
    'camera',
    'printer',
    'gaming-console',
    'gaming',
    'computer-accessory',
    'mobile-accessory',
    'accessory',
    'bag',
    'furniture',
    'appliance',
    'decor',
    'tool',
    'book',
    'office-supply',
    'auto-part',
    'digital-product',
  ],
});

function normalizeType(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidProductType(value) {
  const normalized = normalizeType(value);
  return PRODUCT_TYPES.some(type => type.value === normalized);
}

// Helper: get full objects from a list of values
function pickTypes(values = []) {
  const set = new Set(values.map(normalizeType));
  return PRODUCT_TYPES.filter(type => set.has(type.value));
}

module.exports = {
  PRODUCT_TYPES,
  PRODUCT_TYPES_BY_CATEGORY,
  pickTypes,
  isValidProductType,
};