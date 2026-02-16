// utils/category.js
'use strict';

/**
 * Categories (canonical)
 * - value: what you store in DB (safe: lowercase + hyphen)
 * - label: what user sees in dropdown
 *
 * Keep these as TOP-LEVEL departments (not too granular).
 */

const CATEGORIES = Object.freeze([
  // Core
  { value: 'electronics', label: 'Electronics' },
  { value: 'computers', label: 'Computers & Office Electronics' },
  { value: 'phones', label: 'Phones & Accessories' },
  { value: 'gaming', label: 'Gaming' },

  // Home / living
  { value: 'home-kitchen', label: 'Home & Kitchen' },
  { value: 'furniture', label: 'Furniture' },
  { value: 'appliances', label: 'Appliances' },
  { value: 'garden-outdoor', label: 'Garden & Outdoor' },
  { value: 'tools-hardware', label: 'Tools & Hardware' },
  { value: 'household', label: 'Household & Cleaning' },

  // Beauty / health
  { value: 'beauty-personal-care', label: 'Beauty & Personal Care' },
  { value: 'health-wellness', label: 'Health & Wellness' },

  // Fashion
  { value: 'fashion', label: 'Fashion (General)' },
  { value: 'clothes', label: 'Clothes' },
  { value: 'shoes', label: 'Shoes' },
  { value: 'jewelry-watches', label: 'Jewelry & Watches' },

  // Family / lifestyle
  { value: 'baby-kids', label: 'Baby & Kids' },
  { value: 'toys-games', label: 'Toys & Games' },
  { value: 'sports-outdoors', label: 'Sports & Outdoors' },
  { value: 'pets', label: 'Pet Supplies' },

  // Food
  { value: 'groceries', label: 'Groceries' },

  // Books / office / creative
  { value: 'books', label: 'Books' },
  { value: 'stationery', label: 'Stationery & Office Supplies' },
  { value: 'arts-crafts', label: 'Arts & Crafts' },
  { value: 'music', label: 'Music & Instruments' },

  // Auto / business
  { value: 'automotive', label: 'Automotive' },
  { value: 'industrial', label: 'Industrial & Business Supplies' },

  // Optional / fallback
  { value: 'other', label: 'Other / Misc' },

  // ✅ SECOND-HAND (KEEP THESE EXACT VALUES for your cart rule)
  { value: 'second-hand-clothes', label: 'Second Hand Clothing' },
  { value: 'uncategorized-second-hand-things', label: 'Uncategorized Second Hand Things' },
]);

function isValidCategory(v) {
  const s = String(v || '').trim().toLowerCase();
  return CATEGORIES.some(c => c.value === s);
}

module.exports = {
  CATEGORIES,
  isValidCategory,
};
