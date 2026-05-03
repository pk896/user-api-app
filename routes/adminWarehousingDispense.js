// routes/adminWarehousingDispense.js
'use strict';

const express = require('express');
const router = express.Router();

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const { logAdminAction } = require('../utils/logAdminAction');
const Warehouse = require('../models/Warehouse');

function normalizeCountryCode(value, fallback = 'ZA') {
  const code = String(value || fallback).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : fallback;
}

function clean(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function cleanUpper(value, max = 100) {
  return clean(value, max).toUpperCase();
}

function toBool(value) {
  return value === 'on' || value === 'true' || value === true || value === '1';
}

function toPriority(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 100;
  return Math.max(0, Math.min(9999, Math.round(n)));
}

function splitList(value, { upper = false } = {}) {
  const items = String(value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);

  return [...new Set(items.map((item) => (upper ? item.toUpperCase() : item)))];
}

const requireWarehouseSuperAdmin = [
  requireAdmin,
  requireAdminRole(['super_admin']),
];

function warehousePayloadFromBody(body) {
  const country = normalizeCountryCode(body.country, 'ZA');
  const addressCountry = normalizeCountryCode(body.addressCountry || body.country, country);

  return {
    name: clean(body.name, 120),
    code: cleanUpper(body.code, 40),
    country,
    province: clean(body.province, 120),
    provinceCode: cleanUpper(body.provinceCode, 20),

    address: {
      street1: clean(body.street1, 300),
      street2: clean(body.street2, 300),
      city: clean(body.city, 120),
      state: clean(body.state || body.province, 120),
      zip: clean(body.zip, 60),
      country: addressCountry,
    },

    phone: clean(body.phone, 40),
    email: clean(body.email, 140).toLowerCase(),

    isActive: toBool(body.isActive),
    isDefault: toBool(body.isDefault),
    priority: toPriority(body.priority),

    supportedCountries: splitList(body.supportedCountries, { upper: true }),
    supportedProvinces: splitList(body.supportedProvinces, { upper: false }),

    notes: clean(body.notes, 1000),
  };
}

function validatePayload(payload) {
  const missing = [];

  if (!payload.name) missing.push('Warehouse name');
  if (!payload.code) missing.push('Warehouse code');
  if (!payload.country) missing.push('Country');
  if (!payload.address.street1) missing.push('Street address');
  if (!payload.address.city) missing.push('City');
  if (!payload.address.state) missing.push('Province / state');
  if (!payload.address.zip) missing.push('Postal code');
  if (!payload.address.country) missing.push('Address country');

  if (payload.country !== payload.address.country) {
    missing.push('Country and address country must match');
  }

  if (missing.length) {
    const err = new Error(`Please complete these fields: ${missing.join(', ')}`);
    err.code = 'WAREHOUSE_FORM_INVALID';
    throw err;
  }
}

async function makeDefaultIfNeeded(payload, excludeId = null) {
  if (!payload.isDefault) return;

  const filter = {
    country: payload.country,
    isDefault: true,
  };

  if (excludeId) {
    filter._id = { $ne: excludeId };
  }

  await Warehouse.updateMany(filter, { $set: { isDefault: false } });
}

router.get('/warehouses', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouses = await Warehouse.find({})
      .sort({ country: 1, provinceCode: 1, priority: 1, name: 1 })
      .lean();

    return res.render('admin/warehousingDispense', {
      layout: 'layout',
      title: 'Warehouse Management',
      active: 'warehouses',
      mode: 'list',
      warehouses,
      warehouse: null,
      formAction: '/admin/warehouses',
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  } catch (err) {
    console.error('[warehouses] list error:', err);
    req.flash?.('error', 'Could not load warehouses.');
    return res.redirect('/admin/dashboard');
  }
});

router.get('/warehouses/new', requireWarehouseSuperAdmin, async (req, res) => {
  return res.render('admin/warehousingDispense', {
    layout: 'layout',
    title: 'Create Warehouse',
    active: 'warehouses',
    mode: 'new',
    warehouses: [],
    warehouse: null,
    formAction: '/admin/warehouses',
    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

router.post('/warehouses', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const payload = warehousePayloadFromBody(req.body);
    validatePayload(payload);

    const existing = await Warehouse.findOne({ code: payload.code }).lean();
    if (existing) {
      req.flash?.('error', `Warehouse code ${payload.code} already exists.`);
      return res.redirect('/admin/warehouses/new');
    }

    await makeDefaultIfNeeded(payload);

    const warehouseDoc = await Warehouse.create(payload);

    await logAdminAction(req, {
      action: 'warehouse.create',
      entityType: 'warehouse',
      entityId: String(warehouseDoc._id),
      status: 'success',
      after: {
        name: warehouseDoc.name,
        code: warehouseDoc.code,
        country: warehouseDoc.country,
        province: warehouseDoc.province,
        provinceCode: warehouseDoc.provinceCode,
        isActive: warehouseDoc.isActive,
        isDefault: warehouseDoc.isDefault,
        priority: warehouseDoc.priority,
      },
    });

    req.flash?.('success', 'Warehouse created successfully.');
    return res.redirect('/admin/warehouses');
  } catch (err) {
    console.error('[warehouses] create error:', err);
    req.flash?.('error', err.message || 'Could not create warehouse.');
    return res.redirect('/admin/warehouses/new');
  }
});

router.get('/warehouses/:id/edit', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id).lean();

    if (!warehouse) {
      req.flash?.('error', 'Warehouse not found.');
      return res.redirect('/admin/warehouses');
    }

    return res.render('admin/warehousingDispense', {
      layout: 'layout',
      title: 'Edit Warehouse',
      active: 'warehouses',
      mode: 'edit',
      warehouses: [],
      warehouse,
      formAction: `/admin/warehouses/${encodeURIComponent(String(warehouse._id))}/update`,
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  } catch (err) {
    console.error('[warehouses] edit load error:', err);
    req.flash?.('error', 'Could not load warehouse.');
    return res.redirect('/admin/warehouses');
  }
});

router.post('/warehouses/:id/update', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);

    if (!warehouse) {
      req.flash?.('error', 'Warehouse not found.');
      return res.redirect('/admin/warehouses');
    }

    const payload = warehousePayloadFromBody(req.body);
    validatePayload(payload);

    const duplicate = await Warehouse.findOne({
      _id: { $ne: warehouse._id },
      code: payload.code,
    }).lean();

    if (duplicate) {
      req.flash?.('error', `Warehouse code ${payload.code} already exists.`);
      return res.redirect(`/admin/warehouses/${encodeURIComponent(String(warehouse._id))}/edit`);
    }

    const before = {
      name: warehouse.name,
      code: warehouse.code,
      country: warehouse.country,
      province: warehouse.province,
      provinceCode: warehouse.provinceCode,
      address: warehouse.address,
      phone: warehouse.phone,
      email: warehouse.email,
      isActive: warehouse.isActive,
      isDefault: warehouse.isDefault,
      priority: warehouse.priority,
      supportedCountries: warehouse.supportedCountries,
      supportedProvinces: warehouse.supportedProvinces,
      notes: warehouse.notes,
    };

    await makeDefaultIfNeeded(payload, warehouse._id);

    warehouse.set(payload);
    await warehouse.save();

    await logAdminAction(req, {
      action: 'warehouse.update',
      entityType: 'warehouse',
      entityId: String(warehouse._id),
      status: 'success',
      before,
      after: {
        name: warehouse.name,
        code: warehouse.code,
        country: warehouse.country,
        province: warehouse.province,
        provinceCode: warehouse.provinceCode,
        address: warehouse.address,
        phone: warehouse.phone,
        email: warehouse.email,
        isActive: warehouse.isActive,
        isDefault: warehouse.isDefault,
        priority: warehouse.priority,
        supportedCountries: warehouse.supportedCountries,
        supportedProvinces: warehouse.supportedProvinces,
        notes: warehouse.notes,
      },
    });

    req.flash?.('success', 'Warehouse updated successfully.');
    return res.redirect('/admin/warehouses');
  } catch (err) {
    console.error('[warehouses] update error:', err);
    req.flash?.('error', err.message || 'Could not update warehouse.');
    return res.redirect(`/admin/warehouses/${encodeURIComponent(String(req.params.id))}/edit`);
  }
});

router.post('/warehouses/:id/enable', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);

    if (!warehouse) {
      req.flash?.('error', 'Warehouse not found.');
      return res.redirect('/admin/warehouses');
    }

    const before = {
      isActive: warehouse.isActive,
    };

    warehouse.isActive = true;
    await warehouse.save();

    await logAdminAction(req, {
      action: 'warehouse.enable',
      entityType: 'warehouse',
      entityId: String(warehouse._id),
      status: 'success',
      before,
      after: {
        isActive: warehouse.isActive,
      },
      meta: {
        code: warehouse.code,
        name: warehouse.name,
      },
    });

    req.flash?.('success', 'Warehouse enabled.');
  } catch (err) {
    console.error('[warehouses] enable error:', err);
    req.flash?.('error', 'Could not enable warehouse.');
  }

  return res.redirect('/admin/warehouses');
});

router.post('/warehouses/:id/disable', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);

    if (!warehouse) {
      req.flash?.('error', 'Warehouse not found.');
      return res.redirect('/admin/warehouses');
    }

    const before = {
      isActive: warehouse.isActive,
      isDefault: warehouse.isDefault,
    };

    warehouse.isActive = false;

    if (warehouse.isDefault) {
      warehouse.isDefault = false;
    }

    await warehouse.save();

    await logAdminAction(req, {
      action: 'warehouse.disable',
      entityType: 'warehouse',
      entityId: String(warehouse._id),
      status: 'success',
      before,
      after: {
        isActive: warehouse.isActive,
        isDefault: warehouse.isDefault,
      },
      meta: {
        code: warehouse.code,
        name: warehouse.name,
      },
    });

    req.flash?.('success', 'Warehouse disabled.');
  } catch (err) {
    console.error('[warehouses] disable error:', err);
    req.flash?.('error', 'Could not disable warehouse.');
  }

  return res.redirect('/admin/warehouses');
});

router.post('/warehouses/:id/delete', requireWarehouseSuperAdmin, async (req, res) => {
  try {
    const warehouse = await Warehouse.findById(req.params.id);

    if (!warehouse) {
      req.flash?.('error', 'Warehouse not found.');
      return res.redirect('/admin/warehouses');
    }

    const before = {
      name: warehouse.name,
      code: warehouse.code,
      country: warehouse.country,
      province: warehouse.province,
      provinceCode: warehouse.provinceCode,
      address: warehouse.address,
      phone: warehouse.phone,
      email: warehouse.email,
      isActive: warehouse.isActive,
      isDefault: warehouse.isDefault,
      priority: warehouse.priority,
      supportedCountries: warehouse.supportedCountries,
      supportedProvinces: warehouse.supportedProvinces,
      notes: warehouse.notes,
      createdAt: warehouse.createdAt,
      updatedAt: warehouse.updatedAt,
    };

    await logAdminAction(req, {
      action: 'warehouse.delete',
      entityType: 'warehouse',
      entityId: String(warehouse._id),
      status: 'success',
      before,
      meta: {
        code: warehouse.code,
        name: warehouse.name,
      },
    });

    await Warehouse.deleteOne({ _id: warehouse._id });

    req.flash?.('success', 'Warehouse deleted.');
  } catch (err) {
    console.error('[warehouses] delete error:', err);
    req.flash?.('error', 'Could not delete warehouse.');
  }

  return res.redirect('/admin/warehouses');
});

module.exports = router;
