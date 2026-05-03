// routes/adminShopHeaderImage.js
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const ShopHeaderImage = require('../models/ShopHeaderImage');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — shop header image uploads will fail.');
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

function shopHeaderImageSnapshot(headerImage) {
  if (!headerImage) return null;

  return {
    image: headerImage.image || '',
    active: !!headerImage.active,
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

/* INDEX */
router.get(
  '/shop-header-image',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
    try {
      const headerImage = await ShopHeaderImage.findOne({}).sort({ updatedAt: -1 }).lean();

      return res.render('admin/shop-header-image/index', {
        title: 'Shop Header Image',
        themeCss: themeCssFromSession(req),
        nonce: res.locals.nonce,
        headerImage,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ admin shop header image index error:', err);
      req.flash('error', 'Could not load shop header image.');
      return res.redirect('/admin/dashboard');
    }
  }
);

/* EDIT */
router.get(
  '/shop-header-image/edit',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
    try {
      const headerImage = await ShopHeaderImage.findOne({}).sort({ updatedAt: -1 }).lean();

      return res.render('admin/shop-header-image/edit', {
        title: 'Edit Shop Header Image',
        themeCss: themeCssFromSession(req),
        nonce: res.locals.nonce,
        headerImage,
        success: req.flash('success'),
        error: req.flash('error'),
        info: req.flash('info'),
        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ shop header image edit page error:', err);
      req.flash('error', 'Could not load shop header image.');
      return res.redirect('/admin/shop-header-image');
    }
  }
);

/* SAVE */
router.post(
  '/shop-header-image',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  upload.single('imageFile'),
  async (req, res) => {
    try {
      let headerImage = await ShopHeaderImage.findOne({});
      const before = shopHeaderImageSnapshot(headerImage);
      const isCreate = !headerImage;
      const hadImageUpload = !!req.file;

      if (!headerImage) {
        headerImage = new ShopHeaderImage({
          image: '',
          active: String(req.body.active || '') === 'on',
        });
      } else {
        headerImage.active = String(req.body.active || '') === 'on';
      }

      if (req.file) {
        const oldImage = headerImage.image;
        const newImage = await uploadImageToS3(req.file, 'shop-header-image');

        if (oldImage) {
          await deleteS3ImageByUrl(oldImage);
        }

        headerImage.image = newImage;
      }

      if (!headerImage.image) {
        req.flash('error', 'Header image is required. Please upload an image.');
        return res.redirect('/admin/shop-header-image/edit');
      }

      await headerImage.save();

      await logAdminAction(req, {
        action: isCreate ? 'store.shop_header_image.create' : 'store.shop_header_image.update',
        entityType: 'shop_header_image',
        entityId: String(headerImage._id),
        status: 'success',
        before,
        after: shopHeaderImageSnapshot(headerImage),
        meta: {
          section: 'shop_header_image',
          uploadedImage: hadImageUpload,
        },
      });

      req.flash('success', 'Shop header image saved successfully.');
      return res.redirect('/admin/shop-header-image');
    } catch (err) {
      console.error('❌ save shop header image error:', err);
      req.flash('error', err.message || 'Failed to save shop header image.');
      return res.redirect('/admin/shop-header-image');
    }
  }
);

/* TOGGLE */
router.get(
  '/shop-header-image/toggle',
  requireAdmin,
  requireAdminRole(['super_admin', 'store_admin']),
  requireAdminPermission('store.content.manage'),
  async (req, res) => {
    try {
      const headerImage = await ShopHeaderImage.findOne({});

      if (!headerImage) {
        req.flash('error', 'Shop header image not found.');
        return res.redirect('/admin/shop-header-image');
      }

      const before = shopHeaderImageSnapshot(headerImage);

      headerImage.active = !headerImage.active;
      await headerImage.save();

      await logAdminAction(req, {
        action: headerImage.active ? 'store.shop_header_image.activate' : 'store.shop_header_image.deactivate',
        entityType: 'shop_header_image',
        entityId: String(headerImage._id),
        status: 'success',
        before,
        after: shopHeaderImageSnapshot(headerImage),
        meta: {
          section: 'shop_header_image',
        },
      });

      req.flash(
        'success',
        `Shop header image ${headerImage.active ? 'activated' : 'deactivated'} successfully.`
      );

      return res.redirect('/admin/shop-header-image');
    } catch (err) {
      console.error('❌ toggle shop header image error:', err);
      req.flash('error', 'Failed to toggle shop header image.');
      return res.redirect('/admin/shop-header-image');
    }
  }
);

/* MULTER ERROR HANDLER */
router.use((err, req, res, _next) => {
  console.error('❌ adminShopHeaderImage route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');
  if (back) return res.redirect(back);

  return res.redirect('/admin/shop-header-image');
});

module.exports = router;