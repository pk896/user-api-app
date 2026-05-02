// seeders/seedSouthAfricaWarehouses.js
'use strict';

require('dotenv').config();

const connectDB = require('../config/db');
const Warehouse = require('../models/Warehouse');

const SHARED_PHONE = String(process.env.SHIPPO_FROM_PHONE || '').trim();
const SHARED_EMAIL = String(process.env.SHIPPO_FROM_EMAIL || '').trim();

const warehouses = [
  {
    code: 'ZA-EC',
    name: 'Eastern Cape Warehouse',
    province: 'Eastern Cape',
    provinceCode: 'EC',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Govan Mbeki Avenue',
      street2: '',
      city: 'Gqeberha',
      state: 'Eastern Cape',
      zip: '6001',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-FS',
    name: 'Free State Warehouse',
    province: 'Free State',
    provinceCode: 'FS',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Nelson Mandela Drive',
      street2: '',
      city: 'Bloemfontein',
      state: 'Free State',
      zip: '9301',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-GP',
    name: 'Gauteng Warehouse',
    province: 'Gauteng',
    provinceCode: 'GP',
    isDefault: true,
    priority: 10,
    address: {
      street1: '1 Commissioner Street',
      street2: '',
      city: 'Johannesburg',
      state: 'Gauteng',
      zip: '2001',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-KZN',
    name: 'KwaZulu-Natal Warehouse',
    province: 'KwaZulu-Natal',
    provinceCode: 'KZN',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Anton Lembede Street',
      street2: '',
      city: 'Durban',
      state: 'KwaZulu-Natal',
      zip: '4001',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-LP',
    name: 'Limpopo Warehouse',
    province: 'Limpopo',
    provinceCode: 'LP',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Landdros Mare Street',
      street2: '',
      city: 'Polokwane',
      state: 'Limpopo',
      zip: '0700',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-MP',
    name: 'Mpumalanga Warehouse',
    province: 'Mpumalanga',
    provinceCode: 'MP',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Samora Machel Drive',
      street2: '',
      city: 'Mbombela',
      state: 'Mpumalanga',
      zip: '1201',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-NC',
    name: 'Northern Cape Warehouse',
    province: 'Northern Cape',
    provinceCode: 'NC',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Du Toitspan Road',
      street2: '',
      city: 'Kimberley',
      state: 'Northern Cape',
      zip: '8301',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-NW',
    name: 'North West Warehouse',
    province: 'North West',
    provinceCode: 'NW',
    isDefault: false,
    priority: 20,
    address: {
      street1: '1 Nelson Mandela Drive',
      street2: '',
      city: 'Mahikeng',
      state: 'North West',
      zip: '2745',
      country: 'ZA',
    },
  },
  {
    code: 'ZA-WC',
    name: 'Western Cape Warehouse',
    province: 'Western Cape',
    provinceCode: 'WC',
    isDefault: false,
    priority: 20,
    address: {
      street1: 'Lubisi 4047',
      street2: '',
      city: 'De Doorns',
      state: 'Western Cape',
      zip: '6875',
      country: 'ZA',
    },
  },
];

function hasPlaceholder(value) {
  return String(value || '').includes('REPLACE_WITH_REAL_');
}

function validateWarehousesBeforeSeed() {
  const bad = [];

  for (const warehouse of warehouses) {
    if (hasPlaceholder(warehouse.address.street1)) {
      bad.push(`${warehouse.code}: address.street1`);
    }

    if (hasPlaceholder(warehouse.address.city)) {
      bad.push(`${warehouse.code}: address.city`);
    }

    if (hasPlaceholder(warehouse.address.zip)) {
      bad.push(`${warehouse.code}: address.zip`);
    }
  }

  if (bad.length) {
    throw new Error(
      [
        'Seeder stopped because real warehouse addresses are still missing.',
        'Replace these fields first:',
        ...bad.map((item) => `- ${item}`),
      ].join('\n')
    );
  }
}

async function seedWarehouse(warehouse) {
  const doc = {
    ...warehouse,
    country: 'ZA',
    phone: SHARED_PHONE,
    email: SHARED_EMAIL,
    isActive: true,
    supportedCountries: ['ZA'],
    supportedProvinces: [warehouse.province, warehouse.provinceCode],
  };

  await Warehouse.findOneAndUpdate(
    { code: warehouse.code },
    { $set: doc },
    { upsert: true, new: true, runValidators: true }
  );

  console.log(`✅ Seeded warehouse: ${warehouse.code} - ${warehouse.name}`);
}

async function run() {
  validateWarehousesBeforeSeed();

  await connectDB();

  for (const warehouse of warehouses) {
    await seedWarehouse(warehouse);
  }

  console.log('✅ South Africa warehouses seeded successfully.');
}

(async function main() {
  try {
    await run();
  } catch (err) {
    console.error('❌ Failed to seed South Africa warehouses:');
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    console.log('✅ Seeder finished. You can close this terminal if it stays open because your DB helper schedules reconnects.');
  }
})();