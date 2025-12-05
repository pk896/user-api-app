// routes/products.js
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const Product = require('../models/Product');

const requireBusiness = require('../middleware/requireBusiness');
const requireVerifiedBusiness = require('../middleware/requireVerifiedBusiness');

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
    const ok = /^image\/(png|jpe?g|webp|gif|bmp|svg\+xml)$/.test(file.mimetype);
    if (!ok) {return cb(new Error('Only image uploads are allowed'));}
    cb(null, true);
  },
});

const buildImageUrl = (key) => `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

function extFromFilename(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? 'bin' : name.substring(dot + 1);
}

function randomKey(ext) {
  return `products/${uuidv4()}.${ext}`;
}

/*  router.get('/low-stock', requireBusiness, async (req, res) => {
  console.log('[DEBUG] /low-stock route hit');
  console.log('[DEBUG] req.session.business:', req.session.business);
  console.log('[DEBUG] req.business:', req.business);
  // ... rest of code
});*/

/* ---------------------------------------------
 * 🧾 GET /products/add — show Add Product form
 * ------------------------------------------- */
router.get('/add', requireBusiness, requireVerifiedBusiness, (req, res) => {
  const business = req.session.business; // ✅ Get from session
  res.render('add-product', {
    title: 'Add Product',
    business, // ✅ Pass it to EJS
    success: req.flash('success'),
    error: req.flash('error'),
    themeCss: res.locals.themeCss,
  });
});

// GET: Public sales products page
router.get('/sales', async (req, res) => {
  try {
    const products = await Product.find({ stock: { $gt: 0 } })
      .sort({ createdAt: -1 })
      .lean();

    res.render('sales-products', {
      title: 'Shop Products',
      products,
      themeCss: res.locals.themeCss,
      success: req.flash('success'),
      error: req.flash('error'),
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Failed to load sales page:', err);
    req.flash('error', 'Could not load products.');
    res.redirect('/');
  }
});

router.get('/out-of-stock', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
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

// LOW STOCK (<= 15, > 0)
router.get('/low-stock', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business; // ✅ same as /out-of-stock

    if (!business || !business._id) {
      req.flash('error', 'Session expired. Please log in again.');
      return res.redirect('/business/login');
    }

    const lowStockThreshold = 15;

    const products = await Product.find({
      business: business._id,
      stock: { $gt: 0, $lte: lowStockThreshold }, // 1–15 units
    })
      .sort({ stock: 1, name: 1 })
      .lean();

    return res.render('products-low-stock', {
      title: 'Low Stock Products',
      business,
      products,
      lowStockThreshold,          // ✅ used in EJS
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss, // ✅ match your other pages
      nonce: res.locals.nonce,
    });
  } catch (err) {
    console.error('❌ Low-stock page error:', err);
    req.flash('error', 'Could not load low-stock products.');
    // ✅ redirect to a real route, not /products
    return res.redirect('/products/mine');
  }
});

/* ---------------------------------------------
 * ➕ POST /products/add — create product
 * ------------------------------------------- */
router.post('/add', requireBusiness, requireVerifiedBusiness, upload.single('imageFile'), async (req, res) => {
  console.log('🟢 POST /products/add reached');
  try {
    const business = req.session.business;

    if (!business || !business._id) {
      req.flash('error', 'Unauthorized. Please log in as a business.');
      return res.redirect('/business/login');
    }

    // Validate name & price
    const { name, price } = req.body;
    if (!name || !price) {
      req.flash('error', 'Name and price are required.');
      return res.redirect('/products/add');
    }

    const numericPrice = Number(price);
    if (Number.isNaN(numericPrice) || numericPrice < 0) {
      req.flash('error', 'Price must be a valid positive number.');
      return res.redirect('/products/add');
    }

    // Validate image
    if (!req.file) {
      req.flash('error', 'Product image is required.');
      return res.redirect('/products/add');
    }

    // Upload image to S3
    const { originalname, buffer, mimetype } = req.file;
    const ext = extFromFilename(originalname);
    const key = randomKey(ext);

    console.log(`🟡 Uploading to S3: s3://${BUCKET}/${key}`);
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
      }),
    );
    const imageUrl = buildImageUrl(key);
    console.log(`✅ S3 upload successful -> ${imageUrl}`);

    // Prepare and save product
    const customId = req.body.id?.trim() || uuidv4();

    const product = new Product({
      customId,
      name: name.trim(),
      price: numericPrice,
      description: req.body.description?.trim(),
      imageUrl,
      stock: req.body.stock ? Number(req.body.stock) : 0,
      category: req.body.category?.trim(),
      color: req.body.color?.trim(),
      size: req.body.size?.trim(),
      quality: req.body.quality?.trim(),
      made: req.body.made?.trim(),
      manufacturer: req.body.manufacturer?.trim(),
      type: req.body.type?.trim(),
      business: business._id,
    });

    await product.save();
    console.log(`✅ MongoDB save successful -> ${product.customId}`);

    req.flash('success', '✅ Product added successfully!');
    return res.redirect('/products/all');
  } catch (err) {
    console.error('❌ Add product error:', err);

    if (err.code === 11000) {
      req.flash('error', 'That Product ID already exists. Try another.');
      return res.redirect('/products/add');
    }

    req.flash('error', `Failed to add product: ${err.message}`);
    return res.redirect('/products/add');
  }
});

/* ===========================================================
 * 📦 GET: All Products (owned by this business)
 * =========================================================== */
router.get('/all', requireBusiness, async (req, res) => {
  try {
    const business = req.session.business;
    const products = await Product.find({ business: business._id }).sort({ createdAt: -1 }).lean();

    res.render('all-products', {
      title: 'My Products',
      products,
      business,
      success: req.flash('success'),
      error: req.flash('error'),
      themeCss: res.locals.themeCss,
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
    const bizId = req.session.business._id;
    const prods = await Product.find({ business: bizId })
      .select('name stock soldCount soldOrders')
      .lean();
    res.json({ ok: true, products: prods });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Failed to load' });
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

// BUSINESS-ONLY: view a product you own by customId
router.get('/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const customId = String(req.params.id || '').trim();
    const business = req.session.business;

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
 * ✏️ GET: Edit Product (only own)
 * =========================================================== */
router.get('/edit/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = req.session.business;
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
    });
  } catch (err) {
    console.error('❌ Failed to load product for edit:', err);
    req.flash('error', '❌ Could not load product for editing.');
    res.redirect('/products/all');
  }
});

/* ===========================================================
 * 💾 POST: Save Product Edits (only own)
 * =========================================================== */
router.post('/edit/:id', requireBusiness, requireVerifiedBusiness, upload.single('imageFile'), async (req, res) => {
  try {
    const business = req.session.business;
    const product = await Product.findOne({
      customId: req.params.id,
      business: business._id,
    });

    if (!product) {
      req.flash('error', '❌ Product not found or unauthorized.');
      return res.redirect('/products/all');
    }

    // Update fields
    const fields = [
      'name',
      'price',
      'stock',
      'category',
      'color',
      'size',
      'quality',
      'made',
      'manufacturer',
      'type',
      'description',
    ];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) {product[f] = req.body[f].trim();}
    });

    if (req.body.price) {product.price = Number(req.body.price);}
    if (req.body.stock) {product.stock = Number(req.body.stock);}

    // Optional new image
    if (req.file) {
      const { originalname, buffer, mimetype } = req.file;
      const ext = extFromFilename(originalname);
      const key = randomKey(ext);
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
        }),
      );

      // Delete old image
      try {
        const oldKey = product.imageUrl.split('.com/')[1];
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
      } catch (err) {
        console.warn('⚠️ Failed to delete old image:', err.message);
      }

      product.imageUrl = buildImageUrl(key);
    }

    await product.save();
    req.flash('success', '✅ Product updated successfully!');
    res.redirect('/products/all');
  } catch (err) {
    console.error('❌ Error updating product:', err);
    req.flash('error', `❌ Failed to update: ${err.message}`);
    res.redirect(`/products/edit/${req.params.id}`);
  }
});

/* ===========================================================
 * 🗑️ GET: Delete Product (only own)
 * =========================================================== */
router.get('/delete/:id', requireBusiness, requireVerifiedBusiness, async (req, res) => {
  try {
    const business = req.session.business;
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

/* ===========================================================
 * ❗ Multer Error Handler
 * =========================================================== */
router.use((err, req, res, _next) => {
  console.error('❌ Route error:', err.message);
  req.flash('error', err.message || 'Unexpected server error.');
  res.redirect('/products/add');
});

module.exports = router;
