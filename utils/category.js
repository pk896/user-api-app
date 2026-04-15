// utils/category.js
'use strict';

/**
 * Categories (canonical)
 * - value: what you store in DB (safe: lowercase + hyphen)
 * - label: what user sees in dropdown
 *
 * Keep these as TOP-LEVEL departments (not too granular).
 * These should represent where a product belongs in the store,
 * not the exact item kind.
 */

const CATEGORIES = Object.freeze([
  // Core electronics
  { value: 'electronics', label: 'Electronics' },
  { value: 'computers', label: 'Computers & Office Electronics' },
  { value: 'phones', label: 'Phones & Accessories' },
  { value: 'gaming', label: 'Gaming' },
  { value: 'wearables', label: 'Wearables' },
  { value: 'camera-photo', label: 'Camera & Photography' },
  { value: 'printing-scanning', label: 'Printing & Scanning' },
  { value: 'smart-home-security', label: 'Smart Home & Security' },
  { value: 'software-digital', label: 'Software & Digital Products' },

  // Home / living
  { value: 'home-kitchen', label: 'Home & Kitchen' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'appliances', label: 'Appliances' },
  { value: 'bedding-bath', label: 'Bedding & Bath' },
  { value: 'storage-organization', label: 'Storage & Organization' },
  { value: 'garden-outdoor', label: 'Garden & Outdoor' },
  { value: 'tools-hardware', label: 'Tools & Hardware' },
  { value: 'household', label: 'Household & Cleaning' },

  // Beauty / health
  { value: 'beauty-personal-care', label: 'Beauty & Personal Care' },
  { value: 'health-wellness', label: 'Health & Wellness' },
  { value: 'pharmacy', label: 'Pharmacy & Medical Supplies' },

  // Fashion
  { value: 'fashion', label: 'Fashion (General)' },
  { value: 'clothes', label: 'Clothes' },
  { value: 'shoes', label: 'Shoes' },
  { value: 'jewelry-watches', label: 'Jewelry & Watches' },
  { value: 'travel-luggage', label: 'Travel & Luggage' },

  // Family / lifestyle
  { value: 'baby-kids', label: 'Baby & Kids' },
  { value: 'toys-games', label: 'Toys & Games' },
  { value: 'sports-outdoors', label: 'Sports & Outdoors' },
  { value: 'pets', label: 'Pet Supplies' },
  { value: 'party-events', label: 'Party & Events' },
  { value: 'seasonal', label: 'Seasonal & Holiday' },

  // Food
  { value: 'groceries', label: 'Groceries' },

  // Books / office / creative
  { value: 'books', label: 'Books' },
  { value: 'stationery', label: 'Stationery & Office Supplies' },
  { value: 'office', label: 'Office Equipment' },
  { value: 'arts-crafts', label: 'Arts & Crafts' },
  { value: 'music', label: 'Music & Instruments' },

  // Auto / business
  { value: 'automotive', label: 'Automotive' },
  { value: 'industrial', label: 'Industrial & Business Supplies' },

  // Optional / fallback
  { value: 'other', label: 'Other / Misc' },
]);

function normalizeCategory(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidCategory(value) {
  const normalized = normalizeCategory(value);
  return CATEGORIES.some(category => category.value === normalized);
}

module.exports = {
  CATEGORIES,
  isValidCategory,
};

