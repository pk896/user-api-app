// routes/adminHomeMidBanners.js
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const HomeMidBanner = require('../models/HomeMidBanner');
const Product = require('../models/Product');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — home mid banner uploads will fail.');
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

function normalizePayload(body) {
  return {
    productCustomId: String(body.productCustomId || '').trim(),
    title: String(body.title || '').trim(),
    subtitle: String(body.subtitle || '').trim(),
    priceText: String(body.priceText || '').trim(),
    buttonText: String(body.buttonText || '').trim() || 'Shop Now',
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

/* DASHBOARD */
router.get('/home-mid-banners', requireAdmin, async (req, res) => {
  try {
    const banners = await HomeMidBanner.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    const bannersWithProducts = await Promise.all(
      banners.map(async (banner) => {
        let product = null;

        if (banner.productCustomId) {
          product = await Product.findOne({ customId: banner.productCustomId })
            .select('customId name imageUrl category type price stock')
            .lean();
        }

        return {
          ...banner,
          product,
        };
      })
    );

    return res.render('admin/home-mid-banners/index', {
      title: 'Homepage Mid Banners',
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      banners: bannersWithProducts,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ admin home mid banners index error:', err);
    req.flash('error', 'Could not load homepage mid banners.');
    return res.redirect('/admin/dashboard');
  }
});

/* EDIT PAGE */
router.get('/home-mid-banners/:slot/edit', requireAdmin, async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid banner slot.');
      return res.redirect('/admin/home-mid-banners');
    }

    const bannerRaw = await HomeMidBanner.findOne({ slot }).lean();

    let selectedProduct = null;
    let banner = bannerRaw;

    if (bannerRaw?.productCustomId) {
      selectedProduct = await Product.findOne({ customId: bannerRaw.productCustomId })
        .select('customId name imageUrl category type price stock isOnSale')
        .lean();

      banner = {
        ...bannerRaw,
        product: selectedProduct || null,
      };
    }

    return res.render('admin/home-mid-banners/edit', {
      title: `Edit ${slot === 'left' ? 'Left' : 'Right'} Mid Banner`,
      themeCss: themeCssFromSession(req),
      nonce: res.locals.nonce,
      slot,
      banner,
      selectedProduct,
      success: req.flash('success'),
      error: req.flash('error'),
      info: req.flash('info'),
      warning: req.flash('warning'),
    });
  } catch (err) {
    console.error('❌ home mid banner edit page error:', err);
    req.flash('error', 'Could not load home mid banner.');
    return res.redirect('/admin/home-mid-banners');
  }
});

/* SEARCH PRODUCTS FOR HOME MID BANNERS */
router.get('/home-mid-banners/products/search', requireAdmin, async (req, res) => {
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
      .select('customId name imageUrl category type price stock isOnSale')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.json({ success: true, products });
  } catch (err) {
    console.error('❌ home mid banners product search error:', err);
    return res.status(500).json({
      success: false,
      products: [],
      message: 'Failed to search products.',
    });
  }
});

/* SAVE */
router.post(
  '/home-mid-banners/:slot',
  requireAdmin,
  upload.single('imageFile'),
  async (req, res) => {
    try {
      const slot = String(req.params.slot || '').trim().toLowerCase();

      if (!['left', 'right'].includes(slot)) {
        req.flash('error', 'Invalid banner slot.');
        return res.redirect('/admin/home-mid-banners');
      }

      const payload = normalizePayload(req.body);

      if (!payload.productCustomId) {
        req.flash('error', 'Please select a product.');
        return res.redirect(`/admin/home-mid-banners/${slot}/edit`);
      }

      const product = await Product.findOne({
        customId: payload.productCustomId,
        stock: { $gt: 0 },
      }).lean();

      if (!product) {
        req.flash('error', 'Selected product was not found or is out of stock.');
        return res.redirect(`/admin/home-mid-banners/${slot}/edit`);
      }

      let banner = await HomeMidBanner.findOne({ slot });

      if (!banner) {
        if (!req.file) {
          req.flash('error', 'Banner image is required.');
          return res.redirect(`/admin/home-mid-banners/${slot}/edit`);
        }

        const image = await uploadImageToS3(req.file, 'homepage-banners/mid-banners');

        banner = new HomeMidBanner({
          slot,
          ...payload,
          image,
        });
      } else {
        banner.productCustomId = payload.productCustomId;
        banner.title = payload.title;
        banner.subtitle = payload.subtitle;
        banner.priceText = payload.priceText;
        banner.buttonText = payload.buttonText;
        banner.active = payload.active;
        banner.sortOrder = payload.sortOrder;

        if (req.file) {
          const newImage = await uploadImageToS3(req.file, 'homepage-banners/mid-banners');
          await deleteS3ImageByUrl(banner.image);
          banner.image = newImage;
        }
      }

      await banner.save();

      req.flash('success', `${slot === 'left' ? 'Left' : 'Right'} mid banner saved successfully.`);
      return res.redirect('/admin/home-mid-banners');
    } catch (err) {
      console.error('❌ save home mid banner error:', err);
      req.flash('error', err.message || 'Failed to save home mid banner.');
      return res.redirect('/admin/home-mid-banners');
    }
  }
);

/* TOGGLE */
router.get('/home-mid-banners/:slot/toggle', requireAdmin, async (req, res) => {
  try {
    const slot = String(req.params.slot || '').trim().toLowerCase();

    if (!['left', 'right'].includes(slot)) {
      req.flash('error', 'Invalid banner slot.');
      return res.redirect('/admin/home-mid-banners');
    }

    const banner = await HomeMidBanner.findOne({ slot });

    if (!banner) {
      req.flash('error', 'Banner not found for that slot.');
      return res.redirect('/admin/home-mid-banners');
    }

    banner.active = !banner.active;
    await banner.save();

    req.flash(
      'success',
      `${slot === 'left' ? 'Left' : 'Right'} mid banner ${
        banner.active ? 'activated' : 'deactivated'
      } successfully.`
    );
    return res.redirect('/admin/home-mid-banners');
  } catch (err) {
    console.error('❌ toggle home mid banner error:', err);
    req.flash('error', 'Failed to update banner status.');
    return res.redirect('/admin/home-mid-banners');
  }
});

/* ERROR HANDLER */
router.use((err, req, res, _next) => {
  console.error('❌ adminHomeMidBanners route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');
  if (back) return res.redirect(back);

  return res.redirect('/admin/home-mid-banners');
});

module.exports = router;