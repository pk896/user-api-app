// routes/adminShopSidebarBanner.js
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const ShopSidebarBanner = require('../models/ShopSidebarBanner');
const Product = require('../models/Product');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — shop sidebar banner uploads will fail.');
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

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';
  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function normalizePayload(body) {
  return {
    productCustomId: String(body.productCustomId || '').trim(),
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    buttonText: String(body.buttonText || '').trim() || 'Shop Now',
    active: String(body.active || '') === 'on',
  };
}

/* INDEX */
router.get('/shop-sidebar-banner', requireAdmin, async (req, res) => {
  try {
    const bannerRaw = await ShopSidebarBanner.findOne({}).sort({ updatedAt: -1 }).lean();

    const products = await Product.find({ stock: { $gt: 0 } })
      .select('customId name imageUrl category type price stock')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    let banner = bannerRaw;

    if (bannerRaw && bannerRaw.productCustomId) {
      const product = await Product.findOne({ customId: bannerRaw.productCustomId })
        .select('customId name imageUrl category type price stock')
        .lean();

      banner = {
        ...bannerRaw,
        product: product || null,
      };
    }

    return res.render('admin/shop-sidebar-banner/index', {
      title: 'Shop Sidebar Banner',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      banner,
      products,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ admin shop sidebar banner index error:', err);
    req.flash('error', 'Could not load shop sidebar banner.');
    return res.redirect('/admin/dashboard');
  }
});

/* EDIT */
router.get('/shop-sidebar-banner/edit', requireAdmin, async (req, res) => {
  try {
    const bannerRaw = await ShopSidebarBanner.findOne({}).sort({ updatedAt: -1 }).lean();

    const products = await Product.find({ stock: { $gt: 0 } })
      .select('customId name imageUrl category type price stock')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    let banner = bannerRaw;

    if (bannerRaw && bannerRaw.productCustomId) {
      const product = await Product.findOne({ customId: bannerRaw.productCustomId })
        .select('customId name imageUrl category type price stock')
        .lean();

      banner = {
        ...bannerRaw,
        product: product || null,
      };
    }

    return res.render('admin/shop-sidebar-banner/edit', {
      title: 'Edit Shop Sidebar Banner',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      banner,
      products,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ shop sidebar banner edit page error:', err);
    req.flash('error', 'Could not load shop sidebar banner.');
    return res.redirect('/admin/shop-sidebar-banner');
  }
});

/* SAVE */
router.post(
  '/shop-sidebar-banner',
  requireAdmin,
  upload.single('imageFile'),
  async (req, res) => {
    try {
      const payload = normalizePayload(req.body);

      if (!payload.productCustomId) {
        req.flash('error', 'Please select a product.');
        return res.redirect('/admin/shop-sidebar-banner/edit');
      }

      const product = await Product.findOne({
        customId: payload.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!product) {
        req.flash('error', 'Selected product was not found or is out of stock.');
        return res.redirect('/admin/shop-sidebar-banner/edit');
      }

      let banner = await ShopSidebarBanner.findOne({});

      if (!banner) {
        banner = new ShopSidebarBanner({
          ...payload,
          image: '',
        });
      } else {
        banner.productCustomId = payload.productCustomId;
        banner.title = payload.title;
        banner.subtitle = payload.subtitle;
        banner.buttonText = payload.buttonText;
        banner.active = payload.active;
      }

      if (req.file) {
        const newImage = await uploadImageToS3(req.file, 'shop-sidebar-banner');

        if (banner.image) {
          await deleteS3ImageByUrl(banner.image);
        }

        banner.image = newImage;
      }

      if (!banner.image) {
        req.flash('error', 'Banner image is required. Please upload an image.');
        return res.redirect('/admin/shop-sidebar-banner/edit');
      }

      await banner.save();

      req.flash('success', 'Shop sidebar banner saved successfully.');
      return res.redirect('/admin/shop-sidebar-banner');
    } catch (err) {
      console.error('❌ save shop sidebar banner error:', err);
      req.flash('error', err.message || 'Failed to save shop sidebar banner.');
      return res.redirect('/admin/shop-sidebar-banner');
    }
  }
);

/* TOGGLE */
router.get('/shop-sidebar-banner/toggle', requireAdmin, async (req, res) => {
  try {
    const banner = await ShopSidebarBanner.findOne({});

    if (!banner) {
      req.flash('error', 'Shop sidebar banner not found.');
      return res.redirect('/admin/shop-sidebar-banner');
    }

    banner.active = !banner.active;
    await banner.save();

    req.flash(
      'success',
      `Shop sidebar banner ${banner.active ? 'activated' : 'deactivated'} successfully.`
    );

    return res.redirect('/admin/shop-sidebar-banner');
  } catch (err) {
    console.error('❌ toggle shop sidebar banner error:', err);
    req.flash('error', 'Failed to toggle shop sidebar banner.');
    return res.redirect('/admin/shop-sidebar-banner');
  }
});

/* MULTER ERROR HANDLER */
router.use((err, req, res, _next) => {
  console.error('❌ adminShopSidebarBanner route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');
  if (back) return res.redirect(back);

  return res.redirect('/admin/shop-sidebar-banner');
});

module.exports = router;
