// utils/adminRoles.js
'use strict';

const ADMIN_ROLES = [
  'super_admin',
  'orders_admin',
  'shipping_admin',
  'store_admin',
  'payout_admin',
  'verification_admin',
  'inventory_admin',
  'support_admin',
];

const ROLE_PERMISSIONS = {
  super_admin: ['*'],

  orders_admin: [
    'orders.read',
    'orders.update',
    'orders.refund.read',
  ],

  shipping_admin: [
    'shipping.read',
    'shipping.update',
    'shipping.labels.manage',
    'delivery_options.manage',
  ],

  store_admin: [
    'store.read',
    'store.banners.manage',
    'store.promotions.manage',
    'store.content.manage',
  ],

  payout_admin: [
    'payouts.read',
    'payouts.approve',
    'payouts.reconcile',
  ],

  verification_admin: [
    'verification.read',
    'verification.review',
  ],

  inventory_admin: [
    'inventory.read',
    'inventory.update',
    'inventory.adjust',
  ],

  support_admin: [
    'support.read',
    'support.reply',
    'orders.read',
    'businesses.read',
    'users.read',
  ],
};

function getPermissionsForRole(role) {
  const key = String(role || '').trim();
  return Array.isArray(ROLE_PERMISSIONS[key]) ? [...ROLE_PERMISSIONS[key]] : [];
}

function hasPermission(adminLike, permission) {
  const perms = Array.isArray(adminLike?.permissions) ? adminLike.permissions : [];
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

module.exports = {
  ADMIN_ROLES,
  ROLE_PERMISSIONS,
  getPermissionsForRole,
  hasPermission,
};
