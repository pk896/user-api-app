// routes/adminHomeBanners.js
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const HeroSlide = require('../models/HeroSlide');
const FeaturedBanner = require('../models/FeaturedBanner');
const Product = require('../models/Product');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — hero slide uploads will fail.');
}

const s3 = new S3Client({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);
    if (!ok) return cb(new Error('Only PNG/JPG/WEBP/GIF/BMP images are allowed'));
    cb(null, true);
  },
});

const buildImageUrl = (key) => `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;

function extFromFilename(name) {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? 'bin' : name.substring(dot + 1);
}

function randomKey(folder, ext) {
  return `${folder}/${uuidv4()}.${ext}`;
}

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function normalizeSlidePayload(body) {
  return {
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    description: String(body.description || '').trim(),
    buttonText: String(body.buttonText || '').trim() || 'Shop Now',
    buttonUrl: String(body.buttonUrl || '').trim() || '/store/shop',
    active: String(body.active || '') === 'on',
    sortOrder: Number(body.sortOrder || 0),
  };
}

async function uploadImageToS3(file, folder) {
  const { originalname, buffer, mimetype } = file;
  const ext = extFromFilename(originalname);
  const key = randomKey(folder, ext);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: mimetype,
    })
  );

  return buildImageUrl(key);
}

async function deleteS3ImageByUrl(imageUrl) {
  try {
    if (!imageUrl || !imageUrl.includes('.com/')) return;
    const oldKey = imageUrl.split('.com/')[1];
    if (!oldKey) return;

    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: oldKey }));
  } catch (err) {
    console.warn('⚠️ Failed to delete old S3 image:', err.message);
  }
}

/* HOME BANNERS DASHBOARD */
router.get('/home-banners', requireAdmin, async (req, res) => {
  try {
    const slides = await HeroSlide.find({}).sort({ sortOrder: 1, createdAt: 1 }).lean();
    const featuredBanner = await FeaturedBanner.findOne({}).sort({ updatedAt: -1 }).lean();

    let featuredProduct = null;
    if (featuredBanner?.productCustomId) {
      featuredProduct = await Product.findOne({ customId: featuredBanner.productCustomId }).lean();
    }

    return res.render('admin/home-banners/index', {
      title: 'Homepage Banners',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      slides,
      featuredBanner,
      featuredProduct,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ admin home banners index error:', err);
    req.flash('error', 'Could not load homepage banners.');
    return res.redirect('/admin/dashboard');
  }
});

/* ADD HERO SLIDE PAGE */
router.get('/home-banners/slides/new', requireAdmin, (req, res) => {
  return res.render('admin/home-banners/add-slide', {
    title: 'Add Hero Slide',
    themeCss: themeCssFromSession(req),
    nonce: res.locals.nonce,
    success: req.flash('success'),
    error: req.flash('error'),
    info: req.flash('info'),
    warning: req.flash('warning'),
  });
});

/* CREATE HERO SLIDE */
router.post(
  '/home-banners/slides',
  requireAdmin,
  upload.single('imageFile'),
  async (req, res) => {
    try {
      const payload = normalizeSlidePayload(req.body);

      if (!payload.title) {
        req.flash('error', 'Title is required.');
        return res.redirect('/admin/home-banners/slides/new');
      }

      if (!req.file) {
        req.flash('error', 'Hero slide image is required.');
        return res.redirect('/admin/home-banners/slides/new');
      }

      const image = await uploadImageToS3(req.file, 'homepage-banners/hero-slides');

      await HeroSlide.create({
        ...payload,
        image,
      });

      req.flash('success', 'Hero slide created successfully.');
      return res.redirect('/admin/home-banners');
    } catch (err) {
      console.error('❌ create hero slide error:', err);
      req.flash('error', err.message || 'Failed to create hero slide.');
      return res.redirect('/admin/home-banners/slides/new');
    }
  }
);

/* EDIT HERO SLIDE PAGE */
router.get('/home-banners/slides/:id/edit', requireAdmin, async (req, res) => {
  try {
    const slide = await HeroSlide.findById(req.params.id).lean();

    if (!slide) {
      req.flash('error', 'Hero slide not found.');
      return res.redirect('/admin/home-banners');
    }

    return res.render('admin/home-banners/edit-slide', {
      title: 'Edit Hero Slide',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      slide,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ edit hero slide page error:', err);
    req.flash('error', 'Could not load hero slide.');
    return res.redirect('/admin/home-banners');
  }
});

/* UPDATE HERO SLIDE */
router.post(
  '/home-banners/slides/:id',
  requireAdmin,
  upload.single('imageFile'),
  async (req, res) => {
    try {
      const payload = normalizeSlidePayload(req.body);

      if (!payload.title) {
        req.flash('error', 'Title is required.');
        return res.redirect(`/admin/home-banners/slides/${req.params.id}/edit`);
      }

      const slide = await HeroSlide.findById(req.params.id);
      if (!slide) {
        req.flash('error', 'Hero slide not found.');
        return res.redirect('/admin/home-banners');
      }

      slide.title = payload.title;
      slide.subtitle = payload.subtitle;
      slide.description = payload.description;
      slide.buttonText = payload.buttonText;
      slide.buttonUrl = payload.buttonUrl;
      slide.active = payload.active;
      slide.sortOrder = payload.sortOrder;

      if (req.file) {
        const newImage = await uploadImageToS3(req.file, 'homepage-banners/hero-slides');
        await deleteS3ImageByUrl(slide.image);
        slide.image = newImage;
      }

      await slide.save();

      req.flash('success', 'Hero slide updated successfully.');
      return res.redirect('/admin/home-banners');
    } catch (err) {
      console.error('❌ update hero slide error:', err);
      req.flash('error', err.message || 'Failed to update hero slide.');
      return res.redirect(`/admin/home-banners/slides/${req.params.id}/edit`);
    }
  }
);

/* DELETE HERO SLIDE */
router.get('/home-banners/slides/:id/delete', requireAdmin, async (req, res) => {
  try {
    const slide = await HeroSlide.findByIdAndDelete(req.params.id);

    if (slide?.image) {
      await deleteS3ImageByUrl(slide.image);
    }

    req.flash('success', 'Hero slide deleted successfully.');
    return res.redirect('/admin/home-banners');
  } catch (err) {
    console.error('❌ delete hero slide error:', err);
    req.flash('error', 'Failed to delete hero slide.');
    return res.redirect('/admin/home-banners');
  }
});

/* TOGGLE HERO SLIDE */
router.get('/home-banners/slides/:id/toggle', requireAdmin, async (req, res) => {
  try {
    const slide = await HeroSlide.findById(req.params.id);

    if (!slide) {
      req.flash('error', 'Hero slide not found.');
      return res.redirect('/admin/home-banners');
    }

    slide.active = !slide.active;
    await slide.save();

    req.flash('success', `Hero slide ${slide.active ? 'activated' : 'deactivated'} successfully.`);
    return res.redirect('/admin/home-banners');
  } catch (err) {
    console.error('❌ toggle hero slide error:', err);
    req.flash('error', 'Failed to update hero slide status.');
    return res.redirect('/admin/home-banners');
  }
});

/* FEATURED BANNER PAGE */
router.get('/home-banners/featured-banner', requireAdmin, async (req, res) => {
  try {
    const banner = await FeaturedBanner.findOne({}).sort({ updatedAt: -1 }).lean();

    let selectedProduct = null;

    if (banner?.productCustomId) {
      selectedProduct = await Product.findOne({ customId: banner.productCustomId })
        .select('customId name category type price imageUrl isOnSale')
        .lean();
    }

    return res.render('admin/home-banners/featured-banner', {
      title: 'Featured Banner',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      banner,
      selectedProduct,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ featured banner page error:', err);
    req.flash('error', 'Could not load featured banner settings.');
    return res.redirect('/admin/home-banners');
  }
});

/* SEARCH PRODUCTS FOR FEATURED BANNER */
router.get('/home-banners/products/search', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();

    if (!q) {
      return res.json({ success: true, products: [] });
    }

    const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const products = await Product.find({
      stock: { $gt: 0 },
      $or: [
        { customId: { $regex: safeQ, $options: 'i' } },
        { name: { $regex: safeQ, $options: 'i' } },
      ],
    })
      .select('customId name category type price imageUrl isOnSale')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({ success: true, products });
  } catch (err) {
    console.error('❌ featured banner product search error:', err);
    return res.status(500).json({
      success: false,
      products: [],
      message: 'Failed to search products.',
    });
  }
});

/* SAVE FEATURED BANNER */
router.post('/home-banners/featured-banner', requireAdmin, async (req, res) => {
  try {
    const productCustomId = String(req.body.productCustomId || '').trim();
    const badgeText = String(req.body.badgeText || '').trim();
    const offerText = String(req.body.offerText || '').trim();
    const active = String(req.body.active || '') === 'on';

    if (!productCustomId) {
      req.flash('error', 'Please select a product for the featured banner.');
      return res.redirect('/admin/home-banners/featured-banner');
    }

    const product = await Product.findOne({ customId: productCustomId }).lean();
    if (!product) {
      req.flash('error', 'Selected product was not found.');
      return res.redirect('/admin/home-banners/featured-banner');
    }

    let banner = await FeaturedBanner.findOne({});
    if (!banner) {
      banner = new FeaturedBanner({
        productCustomId,
        badgeText,
        offerText,
        active,
      });
    } else {
      banner.productCustomId = productCustomId;
      banner.badgeText = badgeText;
      banner.offerText = offerText;
      banner.active = active;
    }

    await banner.save();

    req.flash('success', 'Featured banner updated successfully.');
    return res.redirect('/admin/home-banners');
  } catch (err) {
    console.error('❌ save featured banner error:', err);
    req.flash('error', 'Failed to save featured banner.');
    return res.redirect('/admin/home-banners/featured-banner');
  }
});

/* MULTER ERROR HANDLER */
router.use((err, req, res, _next) => {
  console.error('❌ adminHomeBanners route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');
  if (back) return res.redirect(back);

  return res.redirect('/admin/home-banners');
});

module.exports = router;