// routes/wholesale.js
'use strict';

const express = require('express');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const Business = require('../models/Business');
const SupplierProduct = require('../models/SupplierProduct');
const SupplyRequest = require('../models/SupplyRequest');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

const router = express.Router();

/* ---------------------------------------------
 * ☁️ AWS S3 Setup for Supplier Wholesale Images
 * ------------------------------------------- */
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — supplier wholesale image uploads will fail.');
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/* ---------------------------------------------
 * 📸 Multer Memory Storage for S3 Upload
 * ------------------------------------------- */
const supplierProductUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG/JPG/WEBP/GIF/BMP images are allowed'));
    cb(null, true);
  },
});

function handleSupplierUpload(uploadMiddleware) {
  return function supplierUploadHandler(req, res, next) {
    uploadMiddleware(req, res, function (err) {
      if (!err) return next();

      console.error('❌ Supplier product upload error:', err);

      req.flash(
        'error',
        err.message || 'Image upload failed. Please use PNG, JPG, WEBP, GIF, or BMP under 8MB.',
      );

      const isEditPage = req.originalUrl.includes('/edit');

      if (isEditPage) {
        return res.redirect(req.originalUrl);
      }

      return res.redirect('/wholesale/supplier/products/new');
    });
  };
}

const buildSupplierProductImageUrl = (key) =>
  `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

function extFromFilename(name) {
  const dot = String(name || '').lastIndexOf('.');
  return dot === -1 ? 'bin' : String(name || '').substring(dot + 1);
}

function randomSupplierProductImageKey(ext) {
  return `supplier-products/${uuidv4()}.${ext}`;
}

function isOurS3Url(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!url) return false;

  const expectedBase = `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;
  return url.startsWith(expectedBase);
}

function getS3KeyFromUrl(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!url) return '';

  const parts = url.split('.com/');
  return parts[1] || '';
}

async function uploadSupplierProductImageToS3(file) {
  if (!file) return '';

  const ext = extFromFilename(file.originalname || '');
  const key = randomSupplierProductImageKey(ext);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }),
  );

  return buildSupplierProductImageUrl(key);
}

async function deleteSupplierProductImageFromS3(imageUrl) {
  try {
    if (!isOurS3Url(imageUrl)) return;

    const key = getS3KeyFromUrl(imageUrl);
    if (!key) return;

    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: key,
      }),
    );
  } catch (err) {
    console.warn('⚠️ Failed to delete supplier product image from S3:', err.message);
  }
}

function getBusiness(req) {
  return req.business || req.session?.business || null;
}

function requireRole(role) {
  return function roleGuard(req, res, next) {
    const business = getBusiness(req);

    if (!business || !business._id) {
      req.flash('error', 'Please log in first.');
      return res.redirect('/business/login');
    }

    if (business.role !== role) {
      req.flash('error', `Access denied. ${role} accounts only.`);
      return res.redirect('/business/login');
    }

    return next();
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function cleanString(value) {
  return String(value || '').trim();
}

function checkboxOn(v) {
  if (Array.isArray(v)) return v.includes('on') || v.includes('1') || v.includes(true);
  const s = String(v || '').toLowerCase();
  return s === 'on' || s === '1' || s === 'true' || s === 'yes';
}

function parseListField(value, options = {}) {
  const { lowercase = false } = options;

  const normalizeItem = (item) => {
    const cleaned = String(item || '').trim();
    if (!cleaned) return '';
    return lowercase ? cleaned.toLowerCase() : cleaned;
  };

  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeItem).filter(Boolean))];
  }

  if (!value || typeof value !== 'string') return [];

  return [...new Set(value.split(',').map(normalizeItem).filter(Boolean))];
}

function toArrayField(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function normalizeColorImageInputs(body) {
  const colorsRaw = body.colorImageColors;

  const colors = Array.isArray(colorsRaw) ? colorsRaw : colorsRaw !== undefined ? [colorsRaw] : [];

  return colors
    .map((color, index) => ({
      color: String(color || '').trim(),
      index,
    }))
    .filter((row) => row.color);
}

function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const raw = String(v).trim();
  if (!raw) return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return null;

  return n;
}

function pickEnum(v, allowed, fallback) {
  const s = String(v || '')
    .trim()
    .toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function requireShippingFieldsOrThrow({ shipWeightValue, shipLen, shipWid, shipHei }) {
  const bad = [];

  if (shipWeightValue === null) bad.push('weight (> 0)');
  if (shipLen === null) bad.push('length (> 0)');
  if (shipWid === null) bad.push('width (> 0)');
  if (shipHei === null) bad.push('height (> 0)');

  if (bad.length) {
    const err = new Error(
      `Shipping is required. Fix: ${bad.join(', ')}. Please enter per-item weight and dimensions.`,
    );
    err.code = 'SUPPLIER_PRODUCT_SHIPPING_MISSING';
    throw err;
  }
}

function getSupplierProductImageUrls(product) {
  const urls = [];

  if (product && product.imageUrl) {
    urls.push(String(product.imageUrl).trim());
  }

  const colorImages = Array.isArray(product?.colorImages) ? product.colorImages : [];
  colorImages.forEach((entry) => {
    if (entry && entry.imageUrl) {
      urls.push(String(entry.imageUrl).trim());
    }
  });

  return [...new Set(urls.filter(Boolean))];
}

async function cleanupUploadedSupplierAssets({ mainImageUrl = '', colorImages = [] } = {}) {
  if (mainImageUrl) {
    await deleteSupplierProductImageFromS3(mainImageUrl);
  }

  for (const entry of colorImages) {
    await deleteSupplierProductImageFromS3(entry?.imageUrl || '');
  }
}

async function deleteSupplierProductImagesFromS3(product) {
  const urls = getSupplierProductImageUrls(product);

  for (const url of urls) {
    await deleteSupplierProductImageFromS3(url);
  }
}

async function deleteS3UrlsNotStillUsed(oldUrls, keptUrls) {
  const kept = new Set((keptUrls || []).map((url) => String(url || '').trim()).filter(Boolean));

  for (const oldUrl of [...new Set(oldUrls || [])]) {
    const cleanUrl = String(oldUrl || '').trim();
    if (cleanUrl && !kept.has(cleanUrl)) {
      await deleteSupplierProductImageFromS3(cleanUrl);
    }
  }
}

async function buildSupplierColorImagesFromRequest(req) {
  const rows = normalizeColorImageInputs(req.body);
  const uploadedFiles = Array.isArray(req.files?.colorImageFiles) ? req.files.colorImageFiles : [];

  const result = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const uploadedFile = uploadedFiles[i];

    if (!row.color || !uploadedFile) continue;

    const finalImageUrl = await uploadSupplierProductImageToS3(uploadedFile);

    result.push({
      color: row.color,
      imageUrl: finalImageUrl,
    });
  }

  const seen = new Set();

  return result.filter((entry) => {
    const key = entry.color.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function buildEditedSupplierColorImagesFromRequest(req, currentColorImages = []) {
  const colors = toArrayField(req.body.colorImageColors);
  const existingUrls = toArrayField(req.body.colorImageExistingUrls);
  const rowIndexes = toArrayField(req.body.colorImageRowIndexes);

  const files = Array.isArray(req.files) ? req.files : [];
  const currentByColor = new Map();

  (Array.isArray(currentColorImages) ? currentColorImages : []).forEach((entry) => {
    const colorKey = String(entry && entry.color ? entry.color : '')
      .trim()
      .toLowerCase();
    if (colorKey && entry.imageUrl) {
      currentByColor.set(colorKey, entry.imageUrl);
    }
  });

  const result = [];

  for (let i = 0; i < colors.length; i += 1) {
    const color = String(colors[i] || '').trim();
    if (!color) continue;

    const rowIndex = String(rowIndexes[i] !== undefined ? rowIndexes[i] : i).trim();
    const uploadedFile = files.find((file) => file.fieldname === `colorImageFile_${rowIndex}`);

    let imageUrl = String(existingUrls[i] || '').trim();

    if (uploadedFile) {
      imageUrl = await uploadSupplierProductImageToS3(uploadedFile);
    }

    if (!imageUrl) {
      imageUrl = currentByColor.get(color.toLowerCase()) || '';
    }

    if (!imageUrl) continue;

    result.push({ color, imageUrl });
  }

  const seen = new Set();

  return result.filter((entry) => {
    const key = entry.color.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* =========================================================
 * SUPPLIER: Wholesale product list
 * GET /wholesale/supplier/products
 * ======================================================= */
router.get(
  '/supplier/products',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const business = getBusiness(req);

      const products = await SupplierProduct.find({ supplier: business._id })
        .sort({ updatedAt: -1, createdAt: -1 })
        .lean();

      return res.render('supplier-products/index', {
        title: 'My Wholesale Products',
        active: 'supplier-products',
        business,
        products,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Supplier wholesale products error:', err);
      req.flash('error', 'Failed to load wholesale products.');
      return res.redirect('/business/dashboards/supplier-dashboard');
    }
  },
);

/* =========================================================
 * SUPPLIER: Add wholesale product form
 * GET /wholesale/supplier/products/new
 * ======================================================= */
router.get(
  '/supplier/products/new',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    const business = getBusiness(req);

    return res.render('supplier-products/new', {
      title: 'Add Wholesale Product',
      active: 'supplier-products',
      business,
      form: {},
      errors: [],
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  },
);

/* =========================================================
 * SUPPLIER: Create wholesale product
 * POST /wholesale/supplier/products
 * ======================================================= */
router.post(
  '/supplier/products',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  handleSupplierUpload(
    supplierProductUpload.fields([
      { name: 'imageFile', maxCount: 1 },
      { name: 'colorImageFiles', maxCount: 7 },
    ]),
  ),
  [
    body('name').trim().notEmpty().withMessage('Product name is required.'),
    body('wholesalePrice')
      .isFloat({ min: 0 })
      .withMessage('Wholesale price must be a valid number.'),
    body('minimumOrderQuantity')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('Minimum order quantity must be at least 1.'),
    body('availableQuantity')
      .optional({ checkFalsy: true })
      .isInt({ min: 0 })
      .withMessage('Available quantity cannot be negative.'),
    body('leadTimeDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0 })
      .withMessage('Lead time cannot be negative.'),
    body('status')
      .optional({ checkFalsy: true })
      .isIn(['draft', 'active', 'paused'])
      .withMessage('Invalid product status.'),
  ],
  async (req, res) => {
    const business = getBusiness(req);
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      return res.status(400).render('supplier-products/new', {
        title: 'Add Wholesale Product',
        active: 'supplier-products',
        business,
        form: req.body,
        errors: errors.array(),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }

    let uploadedImageUrl = '';
    let uploadedColorImages = [];

    try {
      const mainImageFile = Array.isArray(req.files?.imageFile) ? req.files.imageFile[0] : null;

      if (!mainImageFile) {
        return res.status(400).render('supplier-products/new', {
          title: 'Add Wholesale Product',
          active: 'supplier-products',
          business,
          form: req.body,
          errors: [{ msg: 'Product image is required.' }],
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      const shipWeightValue = numOrNull(req.body.shipWeightValue);
      const shipWeightUnit = pickEnum(req.body.shipWeightUnit, ['kg', 'g', 'lb', 'oz'], 'kg');

      const shipLen = numOrNull(req.body.shipLength);
      const shipWid = numOrNull(req.body.shipWidth);
      const shipHei = numOrNull(req.body.shipHeight);
      const shipDimUnit = pickEnum(req.body.shipDimUnit, ['cm', 'in'], 'cm');

      requireShippingFieldsOrThrow({ shipWeightValue, shipLen, shipWid, shipHei });

      const parsedSizes = parseListField(req.body.sizes);
      const parsedColors = parseListField(req.body.colors);
      const parsedKeywords = parseListField(req.body.keywords, { lowercase: true });

      const colorRows = normalizeColorImageInputs(req.body);
      const colorImageFiles = Array.isArray(req.files?.colorImageFiles)
        ? req.files.colorImageFiles
        : [];

      if (colorRows.length > 7 || colorImageFiles.length > 7) {
        return res.status(400).render('supplier-products/new', {
          title: 'Add Wholesale Product',
          active: 'supplier-products',
          business,
          form: req.body,
          errors: [{ msg: 'You can upload a maximum of 7 color images.' }],
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      uploadedImageUrl = await uploadSupplierProductImageToS3(mainImageFile);
      uploadedColorImages = await buildSupplierColorImagesFromRequest(req);

      if (uploadedColorImages.length > 0) {
        uploadedColorImages.forEach((entry) => {
          const exists = parsedColors.some((c) => c.toLowerCase() === entry.color.toLowerCase());
          if (!exists) parsedColors.push(entry.color);
        });
      }

      const fallbackColor =
        cleanString(req.body.color) || parsedColors[0] || uploadedColorImages[0]?.color || '';

      const fallbackSize = cleanString(req.body.size) || parsedSizes[0] || '';

      const customId =
        cleanString(req.body.customId) || `SUP-${uuidv4().slice(0, 12).toUpperCase()}`;

      await SupplierProduct.create({
        supplier: business._id,
        customId,

        name: cleanString(req.body.name),
        description: cleanString(req.body.description),

        imageUrl: uploadedImageUrl,
        colorImages: uploadedColorImages,

        wholesalePrice: safeNumber(req.body.wholesalePrice),
        minimumOrderQuantity: safeNumber(req.body.minimumOrderQuantity, 1),
        availableQuantity: safeNumber(req.body.availableQuantity, 0),
        unit: cleanString(req.body.unit) || 'units',

        role: cleanString(req.body.role) || 'general',
        type: cleanString(req.body.type),
        category: cleanString(req.body.category),
        quality: cleanString(req.body.quality),
        made: cleanString(req.body.made),
        madeCode: cleanString(req.body.madeCode).toLowerCase(),
        manufacturer: cleanString(req.body.manufacturer),
        keywords: parsedKeywords,

        color: fallbackColor,
        size: fallbackSize,
        sizes: parsedSizes,
        colors: parsedColors,

        countryOfOrigin: cleanString(req.body.made) || cleanString(req.body.countryOfOrigin),
        supplyLocation: {
          country: cleanString(req.body.supplyCountry),
          city: cleanString(req.body.supplyCity),
        },

        leadTimeDays: safeNumber(req.body.leadTimeDays, 3),
        acceptsBulkOrders: checkboxOn(req.body.acceptsBulkOrders),

        shipping: {
          weight: { value: shipWeightValue, unit: shipWeightUnit },
          dimensions: {
            length: shipLen,
            width: shipWid,
            height: shipHei,
            unit: shipDimUnit,
          },
          shipSeparately: checkboxOn(req.body.shipSeparately),
          fragile: checkboxOn(req.body.fragile),
          packagingHint: cleanString(req.body.packagingHint),
        },

        status: cleanString(req.body.status) || 'active',
      });

      req.flash('success', 'Wholesale product added successfully.');
      return res.redirect('/wholesale/supplier/products');
    } catch (err) {
      console.error('❌ Create wholesale product error:', err);

      await cleanupUploadedSupplierAssets({
        mainImageUrl: uploadedImageUrl,
        colorImages: uploadedColorImages,
      });

      req.flash('error', `Failed to add wholesale product: ${err.message}`);
      return res.redirect('/wholesale/supplier/products/new');
    }
  },
);

/* =========================================================
 * SUPPLIER: Edit wholesale product form
 * GET /wholesale/supplier/products/:id/edit
 * ======================================================= */
router.get(
  '/supplier/products/:id/edit',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const business = getBusiness(req);
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/wholesale/supplier/products');
      }

      const product = await SupplierProduct.findOne({
        _id: id,
        supplier: business._id,
      }).lean();

      if (!product) {
        req.flash('error', 'Wholesale product not found.');
        return res.redirect('/wholesale/supplier/products');
      }

      return res.render('supplier-products/edit', {
        title: 'Edit Wholesale Product',
        active: 'supplier-products',
        business,
        product,
        form: product,
        errors: [],
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Edit wholesale product form error:', err);
      req.flash('error', 'Failed to open edit page.');
      return res.redirect('/wholesale/supplier/products');
    }
  },
);

/* =========================================================
 * SUPPLIER: Update wholesale product
 * POST /wholesale/supplier/products/:id/edit
 * ======================================================= */
router.post(
  '/supplier/products/:id/edit',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  handleSupplierUpload(supplierProductUpload.any()),
  [
    body('name').trim().notEmpty().withMessage('Product name is required.'),
    body('wholesalePrice')
      .isFloat({ min: 0 })
      .withMessage('Wholesale price must be a valid number.'),
    body('minimumOrderQuantity')
      .optional({ checkFalsy: true })
      .isInt({ min: 1 })
      .withMessage('Minimum order quantity must be at least 1.'),
    body('availableQuantity')
      .optional({ checkFalsy: true })
      .isInt({ min: 0 })
      .withMessage('Available quantity cannot be negative.'),
    body('leadTimeDays')
      .optional({ checkFalsy: true })
      .isInt({ min: 0 })
      .withMessage('Lead time cannot be negative.'),
    body('status')
      .isIn(['draft', 'active', 'paused', 'archived'])
      .withMessage('Invalid product status.'),
  ],
  async (req, res) => {
    const business = getBusiness(req);
    const { id } = req.params;
    const errors = validationResult(req);

    if (!mongoose.isValidObjectId(id)) {
      req.flash('error', 'Invalid product.');
      return res.redirect('/wholesale/supplier/products');
    }

    if (!errors.isEmpty()) {
      const product = await SupplierProduct.findOne({
        _id: id,
        supplier: business._id,
      }).lean();

      return res.status(400).render('supplier-products/edit', {
        title: 'Edit Wholesale Product',
        active: 'supplier-products',
        business,
        product,
        form: req.body,
        errors: errors.array(),
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    }

    let newlyUploadedEditUrls = [];

    try {
      const existingProduct = await SupplierProduct.findOne({
        _id: id,
        supplier: business._id,
      });

      if (!existingProduct) {
        req.flash('error', 'Wholesale product not found.');
        return res.redirect('/wholesale/supplier/products');
      }

      const oldProductImageUrls = getSupplierProductImageUrls(existingProduct);

      existingProduct.name = cleanString(req.body.name);
      existingProduct.description = cleanString(req.body.description);

      existingProduct.wholesalePrice = safeNumber(req.body.wholesalePrice);
      existingProduct.minimumOrderQuantity = safeNumber(req.body.minimumOrderQuantity, 1);
      existingProduct.availableQuantity = safeNumber(req.body.availableQuantity, 0);
      existingProduct.unit = cleanString(req.body.unit) || 'units';

      existingProduct.role = cleanString(req.body.role) || 'general';
      existingProduct.type = cleanString(req.body.type);
      existingProduct.category = cleanString(req.body.category);
      existingProduct.quality = cleanString(req.body.quality);
      existingProduct.made = cleanString(req.body.made);
      existingProduct.madeCode = cleanString(req.body.madeCode).toLowerCase();
      existingProduct.manufacturer = cleanString(req.body.manufacturer);
      existingProduct.keywords = parseListField(req.body.keywords, { lowercase: true });

      existingProduct.sizes = parseListField(req.body.sizes);
      existingProduct.colors = parseListField(req.body.colors);

      existingProduct.color = cleanString(req.body.color) || existingProduct.colors[0] || '';
      existingProduct.size = cleanString(req.body.size) || existingProduct.sizes[0] || '';

      existingProduct.countryOfOrigin =
        cleanString(req.body.made) || cleanString(req.body.countryOfOrigin);

      existingProduct.supplyLocation = {
        country: cleanString(req.body.supplyCountry),
        city: cleanString(req.body.supplyCity),
      };

      existingProduct.leadTimeDays = safeNumber(req.body.leadTimeDays, 3);
      existingProduct.acceptsBulkOrders = checkboxOn(req.body.acceptsBulkOrders);
      existingProduct.status = cleanString(req.body.status) || 'active';

      const shippingFieldsWereSubmitted =
        req.body.shipWeightValue !== undefined ||
        req.body.shipWeightUnit !== undefined ||
        req.body.shipLength !== undefined ||
        req.body.shipWidth !== undefined ||
        req.body.shipHeight !== undefined ||
        req.body.shipDimUnit !== undefined ||
        req.body.shipSeparately !== undefined ||
        req.body.fragile !== undefined ||
        req.body.packagingHint !== undefined;

      if (shippingFieldsWereSubmitted) {
        const shipWeightValue = numOrNull(req.body.shipWeightValue);
        const shipWeightUnit = pickEnum(req.body.shipWeightUnit, ['kg', 'g', 'lb', 'oz'], 'kg');

        const shipLen = numOrNull(req.body.shipLength);
        const shipWid = numOrNull(req.body.shipWidth);
        const shipHei = numOrNull(req.body.shipHeight);
        const shipDimUnit = pickEnum(req.body.shipDimUnit, ['cm', 'in'], 'cm');

        requireShippingFieldsOrThrow({ shipWeightValue, shipLen, shipWid, shipHei });

        existingProduct.shipping = existingProduct.shipping || {};
        existingProduct.shipping.weight = { value: shipWeightValue, unit: shipWeightUnit };
        existingProduct.shipping.dimensions = {
          length: shipLen,
          width: shipWid,
          height: shipHei,
          unit: shipDimUnit,
        };
        existingProduct.shipping.shipSeparately = checkboxOn(req.body.shipSeparately);
        existingProduct.shipping.fragile = checkboxOn(req.body.fragile);
        existingProduct.shipping.packagingHint = cleanString(req.body.packagingHint);
      }

      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
      const mainImageFile = uploadedFiles.find((file) => file.fieldname === 'imageFile') || null;

      if (mainImageFile) {
        const newMainImageUrl = await uploadSupplierProductImageToS3(mainImageFile);
        newlyUploadedEditUrls.push(newMainImageUrl);
        existingProduct.imageUrl = newMainImageUrl;
      }

      const beforeColorImageUrls = getSupplierProductImageUrls(existingProduct);

      existingProduct.colorImages = await buildEditedSupplierColorImagesFromRequest(
        req,
        existingProduct.colorImages || [],
      );

      const afterBuildImageUrls = getSupplierProductImageUrls(existingProduct);
      newlyUploadedEditUrls = [
        ...new Set(
          newlyUploadedEditUrls.concat(
            afterBuildImageUrls.filter((url) => !beforeColorImageUrls.includes(url)),
          ),
        ),
      ];

      if (existingProduct.colorImages.length > 0) {
        existingProduct.colorImages.forEach((entry) => {
          const exists = existingProduct.colors.some(
            (c) => c.toLowerCase() === entry.color.toLowerCase(),
          );
          if (!exists) existingProduct.colors.push(entry.color);
        });
      }

      await existingProduct.save();

      const keptProductImageUrls = getSupplierProductImageUrls(existingProduct);
      await deleteS3UrlsNotStillUsed(oldProductImageUrls, keptProductImageUrls);

      req.flash('success', 'Wholesale product updated.');
      return res.redirect('/wholesale/supplier/products');
    } catch (err) {
      console.error('❌ Update wholesale product error:', err);

      if (Array.isArray(newlyUploadedEditUrls)) {
        for (const url of newlyUploadedEditUrls) {
          await deleteSupplierProductImageFromS3(url);
        }
      }

      req.flash('error', `Failed to update wholesale product: ${err.message}`);
      return res.redirect(`/wholesale/supplier/products/${id}/edit`);
    }
  },
);

/* =========================================================
 * SUPPLIER: Archive product
 * POST /wholesale/supplier/products/:id/delete
 * ======================================================= */
router.post(
  '/supplier/products/:id/delete',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const business = getBusiness(req);
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid product.');
        return res.redirect('/wholesale/supplier/products');
      }

      const deletedProduct = await SupplierProduct.findOneAndDelete({
        _id: id,
        supplier: business._id,
      });

      if (!deletedProduct) {
        req.flash('error', 'Wholesale product not found.');
        return res.redirect('/wholesale/supplier/products');
      }

      await deleteSupplierProductImagesFromS3(deletedProduct);

      req.flash('success', 'Wholesale product deleted successfully.');
      return res.redirect('/wholesale/supplier/products');
    } catch (err) {
      console.error('❌ Delete wholesale product error:', err);
      req.flash('error', 'Failed to delete product.');
      return res.redirect('/wholesale/supplier/products');
    }
  },
);

/* =========================================================
 * PUBLIC / SELLER: Wholesale marketplace
 * GET /wholesale
 * ======================================================= */
router.get('/', async (req, res) => {
  try {
    const q = cleanString(req.query.q);
    const category = cleanString(req.query.category);

    const filter = { status: 'active' };

    if (category) {
      filter.category = category;
    }

    if (q) {
      filter.$text = { $search: q };
    }

    const products = await SupplierProduct.find(filter)
      .populate('supplier', 'name logoUrl country city isVerified verification role')
      .sort(q ? { score: { $meta: 'textScore' } } : { createdAt: -1 })
      .limit(60)
      .lean();

    const categories = await SupplierProduct.distinct('category', {
      status: 'active',
      category: { $ne: '' },
    });

    return res.render('wholesale/index', {
      title: 'Wholesale Marketplace',
      active: 'wholesale',
      products,
      categories,
      q,
      category,
      business: getBusiness(req),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Wholesale marketplace error:', err);
    req.flash('error', 'Failed to load wholesale marketplace.');
    return res.redirect('/');
  }
});

/* =========================================================
 * PUBLIC / SELLER: Suppliers directory
 * GET /wholesale/suppliers
 * ======================================================= */
router.get('/suppliers', async (req, res) => {
  try {
    const q = cleanString(req.query.q);

    const filter = {
      role: 'supplier',
      isVerified: true,
    };

    if (q) {
      filter.$or = [
        { name: new RegExp(q, 'i') },
        { country: new RegExp(q, 'i') },
        { city: new RegExp(q, 'i') },
      ];
    }

    const suppliers = await Business.find(filter)
      .select('name logoUrl country city verification createdAt')
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    return res.render('wholesale/suppliers', {
      title: 'Suppliers',
      active: 'wholesale-suppliers',
      suppliers,
      q,
      business: getBusiness(req),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Suppliers directory error:', err);
    req.flash('error', 'Failed to load suppliers.');
    return res.redirect('/wholesale');
  }
});

/* =========================================================
 * PUBLIC / SELLER: Supplier profile
 * GET /wholesale/suppliers/:supplierId
 * ======================================================= */
router.get('/suppliers/:supplierId', async (req, res) => {
  try {
    const { supplierId } = req.params;

    if (!mongoose.isValidObjectId(supplierId)) {
      req.flash('error', 'Invalid supplier.');
      return res.redirect('/wholesale/suppliers');
    }

    const supplier = await Business.findOne({
      _id: supplierId,
      role: 'supplier',
      isVerified: true,
    })
      .select('name logoUrl country city phone verification createdAt')
      .lean();

    if (!supplier) {
      req.flash('error', 'Supplier not found.');
      return res.redirect('/wholesale/suppliers');
    }

    const products = await SupplierProduct.find({
      supplier: supplier._id,
      status: 'active',
    })
      .sort({ createdAt: -1 })
      .lean();

    return res.render('wholesale/supplier-profile', {
      title: supplier.name,
      active: 'wholesale-suppliers',
      supplier,
      products,
      business: getBusiness(req),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Supplier profile error:', err);
    req.flash('error', 'Failed to load supplier profile.');
    return res.redirect('/wholesale/suppliers');
  }
});

/* =========================================================
 * PUBLIC / SELLER: Wholesale product detail
 * GET /wholesale/products/:id
 * ======================================================= */
router.get('/products/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      req.flash('error', 'Invalid wholesale product.');
      return res.redirect('/wholesale');
    }

    const product = await SupplierProduct.findOne({
      _id: id,
      status: 'active',
    })
      .populate('supplier', 'name logoUrl country city isVerified verification role')
      .lean();

    if (!product) {
      req.flash('error', 'Wholesale product not found.');
      return res.redirect('/wholesale');
    }

    return res.render('wholesale/product', {
      title: product.name,
      active: 'wholesale',
      product,
      business: getBusiness(req),
      errors: [],
      form: {},
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Wholesale product detail error:', err);
    req.flash('error', 'Failed to load wholesale product.');
    return res.redirect('/wholesale');
  }
});

/* =========================================================
 * SELLER: Submit supply request
 * POST /wholesale/products/:id/request
 * ======================================================= */
router.post(
  '/products/:id/request',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('seller'),
  [
    body('requestedQuantity')
      .isInt({ min: 1 })
      .withMessage('Requested quantity must be at least 1.'),
    body('contactEmail')
      .optional({ checkFalsy: true })
      .isEmail()
      .withMessage('Contact email must be valid.'),
  ],
  async (req, res) => {
    const seller = getBusiness(req);
    const { id } = req.params;
    const errors = validationResult(req);

    if (!mongoose.isValidObjectId(id)) {
      req.flash('error', 'Invalid wholesale product.');
      return res.redirect('/wholesale');
    }

    try {
      const product = await SupplierProduct.findOne({
        _id: id,
        status: 'active',
      })
        .populate('supplier', 'name logoUrl country city isVerified verification role')
        .lean();

      if (!product) {
        req.flash('error', 'Wholesale product not found.');
        return res.redirect('/wholesale');
      }

      if (String(product.supplier?._id) === String(seller._id)) {
        req.flash('error', 'You cannot request supply from your own supplier account.');
        return res.redirect(`/wholesale/products/${id}`);
      }

      if (!errors.isEmpty()) {
        return res.status(400).render('wholesale/product', {
          title: product.name,
          active: 'wholesale',
          product,
          business: seller,
          errors: errors.array(),
          form: req.body,
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      const requestedQuantity = safeNumber(req.body.requestedQuantity, 1);

      if (requestedQuantity < Number(product.minimumOrderQuantity || 1)) {
        return res.status(400).render('wholesale/product', {
          title: product.name,
          active: 'wholesale',
          product,
          business: seller,
          errors: [
            {
              msg: `Minimum order quantity is ${product.minimumOrderQuantity}.`,
            },
          ],
          form: req.body,
          themeCss: res.locals.themeCss,
          nonce: res.locals.nonce,
        });
      }

      await SupplyRequest.create({
        seller: seller._id,
        supplier: product.supplier._id,
        supplierProduct: product._id,
        requestedQuantity,
        message: cleanString(req.body.message),
        contactName: cleanString(req.body.contactName) || seller.name,
        contactEmail: cleanString(req.body.contactEmail) || seller.email,
        contactPhone: cleanString(req.body.contactPhone),
        deliveryCountry: cleanString(req.body.deliveryCountry),
        deliveryCity: cleanString(req.body.deliveryCity),
        status: 'pending',
      });

      req.flash('success', 'Supply request sent to the supplier.');
      return res.redirect('/wholesale/my-requests');
    } catch (err) {
      console.error('❌ Submit supply request error:', err);
      req.flash('error', 'Failed to send supply request.');
      return res.redirect(`/wholesale/products/${id}`);
    }
  },
);

/* =========================================================
 * SELLER: My supply requests
 * GET /wholesale/my-requests
 * ======================================================= */
router.get(
  '/my-requests',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('seller'),
  async (req, res) => {
    try {
      const seller = getBusiness(req);

      const requests = await SupplyRequest.find({ seller: seller._id })
        .populate('supplier', 'name logoUrl country city email phone')
        .populate('supplierProduct', 'name imageUrl wholesalePrice minimumOrderQuantity unit')
        .sort({ createdAt: -1 })
        .lean();

      return res.render('supply-requests/seller-requests', {
        title: 'My Supply Requests',
        active: 'my-supply-requests',
        business: seller,
        requests,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Seller supply requests error:', err);
      req.flash('error', 'Failed to load your supply requests.');
      return res.redirect('/wholesale');
    }
  },
);

/* =========================================================
 * SUPPLIER: Incoming supply requests
 * GET /wholesale/supplier/requests
 * ======================================================= */
router.get(
  '/supplier/requests',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const supplier = getBusiness(req);

      const requests = await SupplyRequest.find({ supplier: supplier._id })
        .populate('seller', 'name logoUrl country city email phone')
        .populate('supplierProduct', 'name imageUrl wholesalePrice minimumOrderQuantity unit')
        .sort({ createdAt: -1 })
        .lean();

      return res.render('supply-requests/supplier-requests', {
        title: 'Supply Requests',
        active: 'supplier-requests',
        business: supplier,
        requests,
        themeCss: res.locals.themeCss,
        nonce: res.locals.nonce,
      });
    } catch (err) {
      console.error('❌ Supplier requests error:', err);
      req.flash('error', 'Failed to load supply requests.');
      return res.redirect('/business/dashboards/supplier-dashboard');
    }
  },
);

/* =========================================================
 * SUPPLIER: Approve request
 * POST /wholesale/supplier/requests/:id/approve
 * ======================================================= */
router.post(
  '/supplier/requests/:id/approve',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const supplier = getBusiness(req);
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid request.');
        return res.redirect('/wholesale/supplier/requests');
      }

      const updated = await SupplyRequest.findOneAndUpdate(
        {
          _id: id,
          supplier: supplier._id,
          status: 'pending',
        },
        {
          $set: {
            status: 'approved',
            supplierResponse: cleanString(req.body.supplierResponse),
            approvedAt: new Date(),
            rejectedAt: null,
          },
        },
        { new: true },
      );

      if (!updated) {
        req.flash('error', 'Pending request not found.');
        return res.redirect('/wholesale/supplier/requests');
      }

      req.flash('success', 'Supply request approved.');
      return res.redirect('/wholesale/supplier/requests');
    } catch (err) {
      console.error('❌ Approve request error:', err);
      req.flash('error', 'Failed to approve request.');
      return res.redirect('/wholesale/supplier/requests');
    }
  },
);

/* =========================================================
 * SUPPLIER: Reject request
 * POST /wholesale/supplier/requests/:id/reject
 * ======================================================= */
router.post(
  '/supplier/requests/:id/reject',
  requireBusiness,
  requireVerifiedBusiness,
  requireRole('supplier'),
  async (req, res) => {
    try {
      const supplier = getBusiness(req);
      const { id } = req.params;

      if (!mongoose.isValidObjectId(id)) {
        req.flash('error', 'Invalid request.');
        return res.redirect('/wholesale/supplier/requests');
      }

      const updated = await SupplyRequest.findOneAndUpdate(
        {
          _id: id,
          supplier: supplier._id,
          status: 'pending',
        },
        {
          $set: {
            status: 'rejected',
            supplierResponse: cleanString(req.body.supplierResponse),
            rejectedAt: new Date(),
            approvedAt: null,
          },
        },
        { new: true },
      );

      if (!updated) {
        req.flash('error', 'Pending request not found.');
        return res.redirect('/wholesale/supplier/requests');
      }

      req.flash('success', 'Supply request rejected.');
      return res.redirect('/wholesale/supplier/requests');
    } catch (err) {
      console.error('❌ Reject request error:', err);
      req.flash('error', 'Failed to reject request.');
      return res.redirect('/wholesale/supplier/requests');
    }
  },
);

module.exports = router;
