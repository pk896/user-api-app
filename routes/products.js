// routes/products.js
'use strict';
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');
const requireOfficialNumberVerified = require('../middleware/requireOfficialNumberVerified');
const requireAdmin = require('../middleware/requireAdmin');
const Business = require('../models/Business');

const router = express.Router();

/* ---------------------------------------------
 * 🪵 Logger for every request
 * ------------------------------------------- */
router.use((req, _res, next) => {
  console.log(`[products] ${req.method} ${req.originalUrl}`);
  next();
});

/* ---------------------------------------------
 * ☁️ AWS S3 Setup
 * ------------------------------------------- */
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — uploads will fail.');
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/* ---------------------------------------------
 * 📸 Multer Memory Storage (for S3 upload)
 * ------------------------------------------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (_req, file, cb) => {
    // ✅ safer: no svg
    const ok = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG/JPG/WEBP/GIF/BMP images are allowed'));
    cb(null, true);
  },
});

const buildImageUrl = (key) => `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

function getS3KeyFromUrl(imageUrl) {
  const url = String(imageUrl || '').trim();
  if (!url) return '';

  const parts = url.split('.com/');
  return parts[1] || '';
}

function extFromFilename(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? 'bin' : name.substring(dot + 1);
}

function randomKey(ext) {
  return `products/${uuidv4()}.${ext}`;
}

function parseListField(value, options = {}) {
  const { lowercase = false } = options;

  const normalizeItem = (item) => {
    const cleaned = String(item || '').trim();
    if (!cleaned) return '';
    return lowercase ? cleaned.toLowerCase() : cleaned;
  };

  if (Array.isArray(value)) {
    return [...new Set(
      value
        .map(normalizeItem)
        .filter(Boolean)
    )];
  }

  if (!value || typeof value !== 'string') return [];

  return [...new Set(
    value
      .split(',')
      .map(normalizeItem)
      .filter(Boolean)
  )];
}

function normalizeColorImageInputs(body) {
  const colorsRaw = body.colorImageColors;
  const urlsRaw = body.colorImageUrls;

  const colors = Array.isArray(colorsRaw)
    ? colorsRaw
    : colorsRaw !== undefined
      ? [colorsRaw]
      : [];

  const urls = Array.isArray(urlsRaw)
    ? urlsRaw
    : urlsRaw !== undefined
      ? [urlsRaw]
      : [];

  const maxLen = Math.max(colors.length, urls.length);
  const rows = [];

  for (let i = 0; i < maxLen; i += 1) {
    rows.push({
      color: String(colors[i] || '').trim(),
      imageUrl: String(urls[i] || '').trim(),
      index: i,
    });
  }

  return rows.filter((row) => row.color || row.imageUrl);
}

async function uploadSingleFileToS3(file) {
  if (!file) return '';

  const ext = extFromFilename(file.originalname || '');
  const key = randomKey(ext);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }),
  );

  return buildImageUrl(key);
}

async function buildColorImagesFromRequest(req) {
  const rows = normalizeColorImageInputs(req.body);
  const uploadedFiles = Array.isArray(req.files?.colorImageFiles) ? req.files.colorImageFiles : [];

  const result = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const uploadedFile = uploadedFiles[i];

    let finalImageUrl = row.imageUrl;

    if (uploadedFile) {
      finalImageUrl = await uploadSingleFileToS3(uploadedFile);
    }

    if (!row.color || !finalImageUrl) continue;

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

/* ---------------------------------------------
 * 📦 Shipping parsing helpers
 * ------------------------------------------- */
function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const raw = String(v).trim();
  if (!raw) return null;

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;

  // ✅ hard reject 0 and negatives
  if (n <= 0) return null;

  return n;
}

function pickEnum(v, allowed, fallback) {
  const s = String(v || '').trim().toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

function checkboxOn(v) {
  if (Array.isArray(v)) return v.includes('on') || v.includes('1') || v.includes(true);
  const s = String(v || '').toLowerCase();
  return s === 'on' || s === '1' || s === 'true' || s === 'yes';
}

function requireShippingFieldsOrThrow({ shipWeightValue, shipLen, shipWid, shipHei }) {
  const bad = [];

  if (shipWeightValue === null) bad.push('weight (> 0)');
  if (shipLen === null) bad.push('length (> 0)');
  if (shipWid === null) bad.push('width (> 0)');
  if (shipHei === null) bad.push('height (> 0)');

  if (bad.length) {
    const err = new Error(
      `Shipping is required. Fix: ${bad.join(', ')}. Please enter per-item weight and dimensions (no box).`
    );
    err.code = 'PRODUCT_SHIPPING_MISSING';
    throw err;
  }
}

function buildAddProductOldInput(body = {}) {
  return {
    id: String(body.id || '').trim(),
    name: String(body.name || '').trim(),
    price: String(body.price || '').trim(),
    stock: String(body.stock || '').trim(),
    category: String(body.category || '').trim(),
    color: String(body.color || '').trim(),
    keywords: String(body.keywords || '').trim(),

    size: String(body.size || '').trim(),
    quality: String(body.quality || '').trim(),
    made: String(body.made || '').trim(),
    madeCode: String(body.madeCode || '').trim(),
    manufacturer: String(body.manufacturer || '').trim(),
    type: String(body.type || '').trim(),
    description: String(body.description || '').trim(),

    role: String(body.role || '').trim() || 'general',
    sizes: String(body.sizes || '').trim(),
    colors: String(body.colors || '').trim(),

    shipWeightValue: String(body.shipWeightValue || '').trim(),
    shipWeightUnit: String(body.shipWeightUnit || '').trim() || 'kg',
    shipLength: String(body.shipLength || '').trim(),
    shipWidth: String(body.shipWidth || '').trim(),
    shipHeight: String(body.shipHeight || '').trim(),
    shipDimUnit: String(body.shipDimUnit || '').trim() || 'cm',
    packagingHint: String(body.packagingHint || '').trim(),

    shipSeparately: checkboxOn(body.shipSeparately),
    fragile: checkboxOn(body.fragile),

    isNew: checkboxOn(body.isNew),
    isOnSale: checkboxOn(body.isOnSale),
    isPopular: checkboxOn(body.isPopular),
  };
}

function stashAddProductFormState(req, oldInput = {}, fieldErrors = {}, flashMessage = '') {
  req.session.addProductOldInput = oldInput;
  req.session.addProductFieldErrors = fieldErrors;

  if (flashMessage) {
    req.flash('error', flashMessage);
  }
}

function consumeAddProductFormState(req) {
  const oldInput = req.session.addProductOldInput || {};
  const fieldErrors = req.session.addProductFieldErrors || {};

  delete req.session.addProductOldInput;
  delete req.session.addProductFieldErrors;

  return { oldInput, fieldErrors };
}

function normalizeMongooseFieldErrors(err) {
  const fieldErrors = {};

  if (!err || err.name !== 'ValidationError' || !err.errors) {
    return fieldErrors;
  }

  Object.keys(err.errors).forEach((key) => {
    const entry = err.errors[key];
    if (!entry) return;

    if (key === 'sizes') {
      fieldErrors.sizes = entry.message;
      return;
    }

    if (key === 'colors') {
      fieldErrors.colors = entry.message;
      return;
    }

    if (key === 'imageUrl') {
      fieldErrors.imageFile = entry.message;
      return;
    }

    if (key === 'name') {
      fieldErrors.name = entry.message;
      return;
    }

    if (key === 'price') {
      fieldErrors.price = entry.message;
      return;
    }

    fieldErrors[key] = entry.message;
  });

  return fieldErrors;
}

/* ---------------------------------------------
 * 🧾 GET /products/add — show Add Product form
 * ------------------------------------------- */
router.get(
  '/add',
  requireBusiness,
  requireVerifiedBusiness,
  requireOfficialNumberVerified,
  (req, res) => {
    const business = req.business || req.session.business;
    const { oldInput, fieldErrors } = consumeAddProductFormState(req);

    res.render('add-product', {
      title: 'Add Product',
      business,
      oldInput,
      fieldErrors,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  },
);

// GET: Public sales products page
router.get('/sales', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const cat = String(req.query.cat || '').trim();

    const salesQuery = {
      stock: { $gt: 0 },
    };

    if (cat) {
      salesQuery.category = cat;
    }

    if (q) {
      const escapedQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const qRegex = new RegExp(escapedQ, 'i');

      salesQuery.$or = [
        { name: qRegex },
        { category: qRegex },
        { type: qRegex },
        { manufacturer: qRegex },
        { description: qRegex },
        { keywords: qRegex },
      ];
    }

    const products = await Product.find(salesQuery)
      .sort({ createdAt: -1, _id: -1 })
      .lean();

    products.forEach((p) => {
      p.sale = !!p.isOnSale;
      p.popular = !!p.isPopular;
    });

    res.render('sales-products', {
      title: 'Shop Products',
      products,
      selectedQ: q,
      selectedCat: cat,
      themeCss: res.locals.themeCss,
      success: req.flash('success'),
      error: req.flash('error'),
      nonce: res.locals.nonce,
      vatRate: Number(process.env.VAT_RATE || 0.15),
    });
  } catch (err) {
    console.error('❌ Failed to load sales page:', err);
    req.flash('error', 'Could not load products.');
    res.redirect('/');
  }
});

router.get('/out-of-stock', requireBusiness, async (req, res) => {
  try {
    const business = req.business || req.session.business;
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    const products = await Product.find({
      business: business._id,
      stock: { $lte: 0 },
    })
      .sort({ updatedAt: -1 })
      .lean();

    res.render('products-out-of-stock', {
      title: 'Out of Stock',
      products,
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Out-of-stock page error:', err);
    req.flash('error', 'Could not load out-of-stock products.');
    res.redirect('/products/all');
  }
});

// LOW STOCK (<= 20, > 0)
router.get('/low-stock', requireBusiness, async (req, res) => {
  try {
    const business = req.business || req.session.business; // ✅ same as /out-of-stock
    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    const lowStockThreshold = 20;

    const products = await Product.find({
      business: business._id,
      stock: { $gt: 0, $lte: lowStockThreshold }, // 1–20 units
    })
      .sort({ stock: 1, name: 1 })
      .lean();

    return res.render('products-low-stock', {
      title: 'Low Stock Products',
      business,
      products,
      lowStockThreshold, // ✅ used in EJS
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss, // ✅ match your other pages
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Low-stock page error:', err);
    req.flash('error', 'Could not load low-stock products.');
    // ✅ redirect to a real route, not /products
    return res.redirect('/products/all');
  }
});

/* ---------------------------------------------
 * ➕ POST /products/add — create product
 * ------------------------------------------- */
router.post(
  '/add',
  requireBusiness,
  requireVerifiedBusiness,
  requireOfficialNumberVerified,
  upload.fields([
    { name: 'imageFile', maxCount: 1 },
    { name: 'colorImageFiles', maxCount: 20 },
  ]),
  async (req, res) => {
    console.log('🟢 POST /products/add reached');

    const oldInput = buildAddProductOldInput(req.body);

    try {
      const business = req.business || req.session.business;

      if (!business || !business._id) {
        req.flash('error', 'Unauthorized. Please log in as a business.');
        return res.redirect('/business/login');
      }

      const fieldErrors = {};

      const { name, price } = req.body;
      const mainImageFile = Array.isArray(req.files?.imageFile) ? req.files.imageFile[0] : null;

      const role = String(req.body.role || '').trim().toLowerCase();
      const type = String(req.body.type || '').trim().toLowerCase();
      const needsVariants =
        role === 'clothes' || role === 'shoes' || type === 'clothes' || type === 'shoes';

      const parsedSizes = parseListField(req.body.sizes);
      const parsedColors = parseListField(req.body.colors);

      const shipWeightValue = numOrNull(req.body.shipWeightValue);
      const shipWeightUnit = pickEnum(req.body.shipWeightUnit, ['kg', 'g', 'lb', 'oz'], 'kg');

      const shipLen = numOrNull(req.body.shipLength);
      const shipWid = numOrNull(req.body.shipWidth);
      const shipHei = numOrNull(req.body.shipHeight);
      const shipDimUnit = pickEnum(req.body.shipDimUnit, ['cm', 'in'], 'cm');

      const shipSeparately = checkboxOn(req.body.shipSeparately);
      const fragile = checkboxOn(req.body.fragile);
      const packagingHint = (req.body.packagingHint || '').toString().trim();

      if (!String(name || '').trim()) {
        fieldErrors.name = 'Product name is required.';
      }

      if (!String(price || '').trim()) {
        fieldErrors.price = 'Price is required.';
      } else {
        const numericPriceCheck = Number(price);
        if (Number.isNaN(numericPriceCheck) || numericPriceCheck <= 0) {
          fieldErrors.price = 'Price must be a valid positive number.';
        }
      }

      if (!mainImageFile) {
        fieldErrors.imageFile = 'Product image is required.';
      }

      if (!String(req.body.made || '').trim()) {
        fieldErrors.made = 'Please select the country in "Made In".';
      }

      if (!String(req.body.type || '').trim()) {
        fieldErrors.type = 'Please choose a matching type.';
      }

      if (shipWeightValue === null) {
        fieldErrors.shipWeightValue = 'Weight must be greater than 0.';
      }

      if (shipLen === null) {
        fieldErrors.shipLength = 'Length must be greater than 0.';
      }

      if (shipWid === null) {
        fieldErrors.shipWidth = 'Width must be greater than 0.';
      }

      if (shipHei === null) {
        fieldErrors.shipHeight = 'Height must be greater than 0.';
      }

      if (needsVariants && parsedSizes.length === 0) {
        fieldErrors.sizes = 'Add at least one size for clothes/shoes products.';
      }

      if (needsVariants && parsedColors.length === 0) {
        fieldErrors.colors = 'Add at least one color for clothes/shoes products.';
      }

      if (Object.keys(fieldErrors).length > 0) {
        stashAddProductFormState(
          req,
          oldInput,
          fieldErrors,
          'Please fill the highlighted fields and submit again.'
        );
        return res.redirect('/products/add');
      }

      const numericPrice = Number(price);

      // Upload main image to S3
      const imageUrl = await uploadSingleFileToS3(mainImageFile);
      console.log(`✅ Main product image upload successful -> ${imageUrl}`);

      const customId = req.body.id?.trim() || uuidv4();

      const parsedKeywords = parseListField(req.body.keywords, { lowercase: true });
      const parsedColorImages = await buildColorImagesFromRequest(req);

      const fallbackColor =
        String(req.body.color || '').trim() || (parsedColors[0] || '') || (parsedColorImages[0]?.color || '');

      const fallbackSize =
        String(req.body.size || '').trim() || (parsedSizes[0] || '');

      if (parsedColorImages.length > 0) {
        parsedColorImages.forEach((entry) => {
          const exists = parsedColors.some((c) => c.toLowerCase() === entry.color.toLowerCase());
          if (!exists) {
            parsedColors.push(entry.color);
          }
        });
      }

      const product = new Product({
        customId,
        name: name.trim(),
        price: numericPrice,
        description: req.body.description?.trim(),
        imageUrl,
        stock: Number.isFinite(Number(req.body.stock)) ? Number(req.body.stock) : 0,

        role: String(req.body.role || '').trim() || 'general',
        type: String(req.body.type || '').trim(),
        category: req.body.category?.trim(),

        color: fallbackColor,
        size: fallbackSize,
        sizes: parsedSizes,
        colors: parsedColors,
        colorImages: parsedColorImages,

        quality: req.body.quality?.trim(),
        made: req.body.made?.trim(),
        madeCode: (req.body.madeCode || '').trim(),
        manufacturer: req.body.manufacturer?.trim(),
        keywords: parsedKeywords,

        isNewItem: checkboxOn(req.body.isNew),
        isOnSale: checkboxOn(req.body.isOnSale),
        isPopular: checkboxOn(req.body.isPopular),

        shipping: {
          weight: { value: shipWeightValue, unit: shipWeightUnit },
          dimensions: {
            length: shipLen,
            width: shipWid,
            height: shipHei,
            unit: shipDimUnit,
          },
          shipSeparately,
          fragile,
          packagingHint,
        },

        business: business._id,
      });

      await product.save();
      console.log(`✅ MongoDB save successful -> ${product.customId}`);

      req.flash('success', '✅ Product added successfully!');
      return res.redirect('/products/all');
    } catch (err) {
      console.error('❌ Add product error:', err);

      if (err.code === 11000) {
        stashAddProductFormState(
          req,
          oldInput,
          { id: 'That Product ID already exists. Try another.' },
          'Please fix the highlighted field and submit again.'
        );
        return res.redirect('/products/add');
      }

      const mongooseFieldErrors = normalizeMongooseFieldErrors(err);

      if (Object.keys(mongooseFieldErrors).length > 0) {
        stashAddProductFormState(
          req,
          oldInput,
          mongooseFieldErrors,
          'Please fix the highlighted fields and submit again.'
        );
        return res.redirect('/products/add');
      }

      stashAddProductFormState(
        req,
        oldInput,
        {},
        `Failed to add product: ${err.message}`
      );
      return res.redirect('/products/add');
    }
  },
);

/* ===========================================================
 * 📦 GET: All Products (owned by this business)
 * =========================================================== */
router.get('/all', requireBusiness, async (req, res) => {
  try {
    const business = req.business || req.session.business;
    const products = await Product.find({ business: business._id }).sort({ createdAt: -1, _id: -1 }).lean();

    res.render('all-products', {
      title: 'My Products',
      products,
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Failed to load products:', err);
    req.flash('error', '❌ Could not load your products.');
    res.redirect('/business/dashboard');
  }
});

// Add near bottom of routes/products.js
router.get('/stats/summary', requireBusiness, async (req, res) => {
  try {
    const bizId = (req.business?._id) || (req.session.business?._id);
    const prods = await Product.find({ business: bizId })
      .select('name stock soldCount soldOrders')
      .lean();
    res.json({ ok: true, products: prods });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Failed to load' });
  }
});

router.get('/debug-created-order', requireAdmin, async (_req, res) => {
  try {
    const products = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .select('name customId createdAt updatedAt')
      .lean();

    return res.json({
      ok: true,
      count: products.length,
      products: products.map((p) => ({
        name: p.name,
        customId: p.customId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
    });
  } catch (err) {
    console.error('debug-created-order error:', err);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/admin/backfill-missing-createdat', requireAdmin, async (_req, res) => {
  try {
    const products = await Product.find({
      $or: [
        { createdAt: { $exists: false } },
        { createdAt: null }
      ]
    }).select('_id name customId createdAt updatedAt').lean();

    let fixed = 0;
    const rows = [];

    for (const product of products) {
      const fallbackCreatedAt =
        product.updatedAt ||
        new Date();

      await Product.collection.updateOne(
        { _id: product._id },
        { $set: { createdAt: fallbackCreatedAt } }
      );

      fixed += 1;
      rows.push({
        name: product.name,
        customId: product.customId,
        createdAtSetTo: fallbackCreatedAt
      });
    }

    return res.json({
      ok: true,
      fixed,
      products: rows
    });
  } catch (err) {
    console.error('backfill-missing-createdat error:', err);
    return res.status(500).json({
      ok: false,
      message: err.message
    });
  }
});

router.get('/admin/delete-by-customid/:id', requireAdmin, async (req, res) => {
  try {
    const customId = String(req.params.id || '').trim();

    if (!customId) {
      return res.status(400).send('Missing product customId.');
    }

    const product = await Product.findOneAndDelete({ customId });

    if (!product) {
      return res.status(404).send(`Product not found: ${customId}`);
    }

    try {
      const imageKey = getS3KeyFromUrl(product.imageUrl);
      if (imageKey) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: imageKey }));
      }
    } catch (err) {
      console.warn('⚠️ Could not delete image from S3:', err.message);
    }

    return res.send(`Deleted product: ${product.customId} - ${product.name}`);
  } catch (err) {
    console.error('❌ delete-by-customid error:', err);
    return res.status(500).send(err.message);
  }
});

router.get('/admin/delete-many', requireAdmin, async (req, res) => {
  try {
    const ids = String(req.query.ids || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (!ids.length) {
      return res.status(400).send('Use ?ids=ID1,ID2,ID3');
    }

    const products = await Product.find({
      customId: { $in: ids },
    }).select('_id customId name imageUrl').lean();

    if (!products.length) {
      return res.status(404).send('No matching products found.');
    }

    const productIds = products.map((p) => p._id);

    await Product.deleteMany({
      _id: { $in: productIds },
    });

    for (const product of products) {
      try {
        const imageKey = getS3KeyFromUrl(product.imageUrl);
        if (imageKey) {
          await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: imageKey }));
        }
      } catch (err) {
        console.warn('⚠️ Could not delete image from S3:', err.message);
      }
    }

    return res.json({
      ok: true,
      deletedCount: products.length,
      deleted: products.map((p) => ({
        customId: p.customId,
        name: p.name,
      })),
    });
  } catch (err) {
    console.error('❌ delete-many error:', err);
    return res.status(500).send(err.message);
  }
});

// routes/products.js

// --- PUBLIC: view a product by customId (no auth)
// PLACE THIS ABOVE the business-only "/:id" route
router.get('/view/:id', async (req, res) => {
  try {
    const customId = String(req.params.id || '').trim();
    if (!customId) {
      req.flash('error', '❌ Invalid product id.');
      return res.redirect('/products/sales');
    }

    const product = await Product.findOne({ customId }).lean();
    if (!product) {
      req.flash('error', '❌ Product not found.');
      return res.redirect('/products/sales');
    }

    // ✅ IMPORTANT: render without a leading slash
    return res.render('product-details', {
      title: product.name,
      product,
      business: req.session.business || null,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Public product details error:', err);
    req.flash('error', '❌ Could not load product.');
    return res.redirect('/products/sales');
  }
});

/* ===========================================================
 * ✏️ GET: Edit Product (only own)
 * =========================================================== */
router.get('/edit/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = req.business || req.session.business;
    const product = await Product.findOne({
      customId: req.params.id,
      business: business._id,
    }).lean();

    if (!product) {
      req.flash('error', '❌ Product not found or unauthorized.');
      return res.redirect('/products/all');
    }

    res.render('edit-product', {
      title: `Edit: ${product.name}`,
      product,
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Failed to load product for edit:', err);
    req.flash('error', '❌ Could not load product for editing.');
    res.redirect('/products/all');
  }
});

router.post(
  '/edit/:id',
  requireBusiness,
  requireVerifiedBusiness,
  upload.fields([
    { name: 'imageFile', maxCount: 1 },
    { name: 'colorImageFiles', maxCount: 20 },
  ]),
  async (req, res) => {
    try {
      const business = req.business || req.session.business;
      const product = await Product.findOne({
        customId: req.params.id,
        business: business._id,
      });

      if (!product) {
        req.flash('error', '❌ Product not found or unauthorized.');
        return res.redirect('/products/all');
      }

      const source = String(req.body.source || '').trim();

      // -----------------------------------
      // STOCK-ONLY update from low-stock / out-of-stock pages
      // -----------------------------------
      if (source === 'low-stock-page' || source === 'out-of-stock-page') {
        const numStock = Number(req.body.stock);

        if (!Number.isFinite(numStock) || numStock < 0) {
          req.flash('error', '❌ Stock must be a valid number 0 or greater.');
          return res.redirect(
            source === 'low-stock-page' ? '/products/low-stock' : '/products/out-of-stock'
          );
        }

        const nextStock = Math.floor(numStock);

        const result = await Product.updateOne(
          {
            customId: req.params.id,
            business: business._id,
          },
          {
            $set: { stock: nextStock },
          }
        );

        if (!result.matchedCount) {
          req.flash('error', '❌ Product not found or unauthorized.');
          return res.redirect('/products/all');
        }

        req.flash('success', `✅ Stock updated for "${product.name}".`);

        return res.redirect(
          source === 'low-stock-page' ? '/products/low-stock' : '/products/out-of-stock'
        );
      }

      // ---------- BASIC FIELDS ----------
      const baseFields = [
        'name',
        'category',
        'color',
        'size',
        'quality',
        'made',
        'madeCode',
        'manufacturer',
        'type',
        'role',
      ];

      baseFields.forEach((f) => {
        if (typeof req.body[f] === 'string') {
          product[f] = req.body[f].trim();
        }
      });

      // price & stock as numbers
      if (req.body.price !== undefined && req.body.price !== '') {
        const numPrice = Number(req.body.price);
        if (!Number.isNaN(numPrice)) {
          product.price = numPrice;
        }
      }

      if (req.body.stock !== undefined && req.body.stock !== '') {
        const numStock = Number(req.body.stock);
        if (!Number.isNaN(numStock) && numStock >= 0) {
          product.stock = Math.floor(numStock);
        }
      }

      // description
      if (typeof req.body.description === 'string') {
        product.description = req.body.description.trim();
      }

      // keywords
      product.keywords = parseListField(req.body.keywords, { lowercase: true });

      // ---------- VARIANT ARRAYS ----------
      if (req.body.sizes !== undefined) {
        product.sizes = parseListField(req.body.sizes);
      }

      if (req.body.colors !== undefined) {
        product.colors = parseListField(req.body.colors);
      }

      product.colorImages = await buildColorImagesFromRequest(req);

      if (!product.color && product.colors && product.colors.length > 0) {
        product.color = product.colors[0];
      }

      if (!product.color && product.colorImages && product.colorImages.length > 0) {
        product.color = product.colorImages[0].color;
      }

      if (!product.size && product.sizes && product.sizes.length > 0) {
        product.size = product.sizes[0];
      }

      if (req.body.colors !== undefined) {
        product.colors = parseListField(req.body.colors);
      }

      if (!product.color && product.colors && product.colors.length > 0) {
        product.color = product.colors[0];
      }
      if (!product.size && product.sizes && product.sizes.length > 0) {
        product.size = product.sizes[0];
      }

      // ---------- STATUS FLAGS ----------
      const isNewFlag = checkboxOn(req.body.isNew);
      product.isNewItem = isNewFlag;
      product.isOnSale = checkboxOn(req.body.isOnSale);
      product.isPopular = checkboxOn(req.body.isPopular);

      // ---------- SHIPPING ----------
      // Only validate shipping if the edit form actually submitted shipping fields
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

        requireShippingFieldsOrThrow({ shipWeightValue, shipLen, shipWid, shipHei });

        const shipDimUnit = pickEnum(req.body.shipDimUnit, ['cm', 'in'], 'cm');
        const shipSeparately = checkboxOn(req.body.shipSeparately);
        const fragile = checkboxOn(req.body.fragile);
        const packagingHint = (req.body.packagingHint || '').toString().trim();

        if (!product.shipping) product.shipping = {};
        if (!product.shipping.weight) product.shipping.weight = {};
        if (!product.shipping.dimensions) product.shipping.dimensions = {};

        product.shipping.weight.value = shipWeightValue;
        product.shipping.weight.unit = shipWeightUnit;
        product.shipping.dimensions.length = shipLen;
        product.shipping.dimensions.width = shipWid;
        product.shipping.dimensions.height = shipHei;
        product.shipping.dimensions.unit = shipDimUnit;
        product.shipping.shipSeparately = shipSeparately;
        product.shipping.fragile = fragile;
        product.shipping.packagingHint = packagingHint;
      }

      // ---------- OPTIONAL NEW IMAGE ----------
      const mainImageFile = Array.isArray(req.files?.imageFile) ? req.files.imageFile[0] : null;

      if (mainImageFile) {
        try {
          product.imageUrl = await uploadSingleFileToS3(mainImageFile);
        } catch (err) {
          throw new Error(err.message);
        }
      }

      await product.save();
      req.flash('success', '✅ Product updated successfully!');
      return res.redirect('/products/all');
    } catch (err) {
      console.error('❌ Error updating product:', err);
      req.flash('error', `❌ Failed to update: ${err.message}`);

      const source = String(req.body.source || '').trim();
      if (source === 'low-stock-page') return res.redirect('/products/low-stock');
      if (source === 'out-of-stock-page') return res.redirect('/products/out-of-stock');

      return res.redirect(`/products/edit/${req.params.id}`);
    }
  },
);

/* ===========================================================
 * 🗑️ GET: Delete Product (only own)
 * =========================================================== */
router.get('/delete/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = req.business || req.session.business;
    const product = await Product.findOneAndDelete({
      customId: req.params.id,
      business: business._id,
    });

    if (!product) {
      req.flash('error', '❌ Product not found or unauthorized.');
      return res.redirect('/products/all');
    }

    // Delete from S3
    try {
      const imageKey = product.imageUrl.split('.com/')[1];
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: imageKey }));
    } catch (err) {
      console.warn('⚠️ Could not delete image from S3:', err.message);
    }

    req.flash('success', '🗑️ Product deleted successfully!');
    res.redirect('/products/all');
  } catch (err) {
    console.error('❌ Delete product error:', err);
    req.flash('error', '❌ Could not delete product.');
    res.redirect('/products/all');
  }
});

// BUSINESS-ONLY: view a product you own by customId
router.get('/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const customId = String(req.params.id || '').trim();
    const business = req.business || req.session.business;

    if (!business || !business._id) {
      req.flash('error', '❌ Unauthorized. Please log in.');
      return res.redirect('/business/login');
    }

    const product = await Product.findOne({
      customId,
      business: business._id,
    }).lean();

    if (!product) {
      req.flash('error', '❌ Product not found or unauthorized.');
      return res.redirect('/products/all');
    }

    // Provide defaults so the view never breaks
    const shipmentStats = { inTransit: 0, delivered: 0 };

    return res.render('product-details', {
      title: product.name,
      product,
      shipmentStats, // ✅ consistent with public route
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Error loading product details:', err);
    req.flash('error', '❌ Could not load product details.');
    return res.redirect('/products/all');
  }
});

/* ===========================================================
 * ❗ Multer Error Handler
 * =========================================================== */
router.use((err, req, res, _next) => {
  console.error('❌ Route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  // Redirect back to the page the user was on (edit/add), without breaking other flows
  const back = req.get('referer');
  if (back) return res.redirect(back);

  // Fallbacks if no referer
  if (String(req.originalUrl || '').includes('/edit/')) {
    return res.redirect('/products/all');
  }
  return res.redirect('/products/add');
});

// TEMP: Cleanup orphan products (RUN ONCE)
router.get('/admin/cleanup-orphans', async (req, res) => {
  try {
    const businesses = await Business.find({}).select('_id').lean();
    const validIds = businesses.map(b => b._id);

    const result = await Product.deleteMany({
      business: { $nin: validIds }
    });

    return res.json({
      ok: true,
      deleted: result.deletedCount
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* ===========================================================
 * 🌍 PUBLIC STORE DATA HELPERS
 * =========================================================== */

// newest in-stock products
router.get('/api/public/featured', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 8, 50));

    const products = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const safe = products.map((p) => ({
      customId: p.customId,
      name: p.name,
      price: p.price,
      imageUrl: p.imageUrl,
      image: p.imageUrl,
      category: p.category || p.type || 'Product',
      role: p.role || 'general',
      type: p.type || '',
      color: p.color || '',
      size: p.size || '',
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      colors: Array.isArray(p.colors) ? p.colors : [],
      colorImages: Array.isArray(p.colorImages) ? p.colorImages : [],
      isNew: !!p.isNewItem,
      isOnSale: !!p.isOnSale,
      isPopular: !!p.isPopular,
      stock: p.stock || 0,
      oldPrice: p.isOnSale ? Number((p.price * 1.19).toFixed(2)) : null,
    }));

    return res.json({ ok: true, products: safe });
  } catch (err) {
    console.error('❌ public featured products error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load products' });
  }
});

router.get('/api/public/bestsellers', async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 8, 50));

    const products = await Product.find({ stock: { $gt: 0 } })
      .sort({ soldCount: -1, createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    const safe = products.map((p) => ({
      customId: p.customId,
      name: p.name,
      price: p.price,
      imageUrl: p.imageUrl,
      image: p.imageUrl,
      category: p.category || p.type || 'Product',
      role: p.role || 'general',
      type: p.type || '',
      color: p.color || '',
      size: p.size || '',
      sizes: Array.isArray(p.sizes) ? p.sizes : [],
      colors: Array.isArray(p.colors) ? p.colors : [],
      colorImages: Array.isArray(p.colorImages) ? p.colorImages : [],
      isNew: !!p.isNewItem,
      isOnSale: !!p.isOnSale,
      isPopular: !!p.isPopular,
      stock: p.stock || 0,
      oldPrice: p.isOnSale ? Number((p.price * 1.19).toFixed(2)) : null,
    }));

    return res.json({ ok: true, products: safe });
  } catch (err) {
    console.error('❌ public bestseller products error:', err);
    return res.status(500).json({ ok: false, message: 'Failed to load products' });
  }
});

module.exports = router;