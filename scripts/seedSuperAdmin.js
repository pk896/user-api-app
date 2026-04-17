// scripts/seedSuperAdmin.js
'use strict';

require('dotenv').config();

const bcrypt = require('bcrypt');
const connectDB = require('../config/db');
const Admin = require('../models/Admin');
const { getPermissionsForRole } = require('../utils/adminRoles');

async function run() {
  await connectDB();

  const fullName = String(process.env.SUPER_ADMIN_FULL_NAME || '').trim();
  const email = String(process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const username = String(process.env.SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
  const password = String(process.env.SUPER_ADMIN_PASSWORD || '').trim();

  if (!fullName || !email || !username || !password) {
    throw new Error(
      'Missing SUPER_ADMIN_FULL_NAME, SUPER_ADMIN_EMAIL, SUPER_ADMIN_USERNAME, or SUPER_ADMIN_PASSWORD in .env'
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await Admin.findOne({
    $or: [{ email }, { username }],
  });

  if (existing) {
    existing.fullName = fullName;
    existing.email = email;
    existing.username = username;
    existing.passwordHash = passwordHash;
    existing.role = 'super_admin';
    existing.permissions = getPermissionsForRole('super_admin');
    existing.isActive = true;
    existing.mustChangePassword = false;
    await existing.save();

    console.log('✅ Super admin updated:', existing.email);
    return;
  }

  const admin = await Admin.create({
    fullName,
    email,
    username,
    passwordHash,
    role: 'super_admin',
    permissions: getPermissionsForRole('super_admin'),
    isActive: true,
    mustChangePassword: false,
  });

  console.log('✅ Super admin created:', admin.email);
  return;
}

(async () => {
  try {
    await run();
    console.log('✅ Seed script completed successfully.');
  } catch (err) {
    console.error('❌ Failed to seed super admin:', err);
  }
})();