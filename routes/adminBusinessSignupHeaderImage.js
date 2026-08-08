// routes/adminBusinessSignupHeaderImage.js
'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');
const { logAdminAction } = require('../utils/logAdminAction');

const BusinessSignupHeaderImage = require('../models/BusinessSignupHeaderImage');

const router = express.Router();

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — business signup header image uploads will fail.');
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

  limits: {
    fileSize: 8 * 1024 * 1024,
  },

  fileFilter: (_req, file, cb) => {
    const ok = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);

    if (!ok) {
      return cb(new Error('Only PNG/JPG/WEBP/GIF/BMP images are allowed'));
    }

    return cb(null, true);
  },
});

function buildImageUrl(key) {
  return `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
}

function extFromFilename(name) {
  const filename = String(name || '').trim();

  const dot = filename.lastIndexOf('.');

  if (dot === -1) {
    return 'bin';
  }

  return filename.substring(dot + 1).toLowerCase();
}

function randomKey(folder, ext) {
  return `${folder}/${uuidv4()}.${ext}`;
}

function themeCssFromSession(req) {
  const theme = req.session?.theme || 'light';

  return theme === 'dark' ? '/css/dark.css' : '/css/light.css';
}

function businessSignupHeaderImageSnapshot(headerImage) {
  if (!headerImage) {
    return null;
  }

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
    }),
  );

  return buildImageUrl(key);
}

async function deleteS3ImageByUrl(imageUrl) {
  try {
    if (!imageUrl || !BUCKET) {
      return;
    }

    const expectedPrefix = `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/`;

    if (!String(imageUrl).startsWith(expectedPrefix)) {
      return;
    }

    const oldKey = String(imageUrl).slice(expectedPrefix.length);

    if (!oldKey) {
      return;
    }

    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: oldKey,
      }),
    );
  } catch (err) {
    console.warn('⚠️ Failed to delete old business signup header image:', err.message);
  }
}

/* =========================================================
 * INDEX
 * ======================================================= */
router.get(
  '/business-signup-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessSignupHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/business-signup-header-image/index', {
        title: 'Business Signup Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ admin business signup header image index error:', err);

      req.flash('error', 'Could not load the Business Signup Header Image.');

      return res.redirect('/admin/dashboard');
    }
  },
);

/* =========================================================
 * EDIT
 * ======================================================= */
router.get(
  '/business-signup-header-image/edit',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessSignupHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/business-signup-header-image/edit', {
        title: 'Edit Business Signup Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ business signup header image edit page error:', err);

      req.flash('error', 'Could not load the Business Signup Header Image.');

      return res.redirect('/admin/business-signup-header-image');
    }
  },
);

/* =========================================================
 * SAVE
 * ======================================================= */
router.post(
  '/business-signup-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  upload.single('imageFile'),

  async (req, res) => {
    try {
      let headerImage = await BusinessSignupHeaderImage.findOne({
        singletonKey: 'main',
      });

      const before = businessSignupHeaderImageSnapshot(headerImage);

      const isCreate = !headerImage;

      const hadImageUpload = !!req.file;

      if (!headerImage) {
        headerImage = new BusinessSignupHeaderImage({
          singletonKey: 'main',

          image: '',

          active: String(req.body.active || '') === 'on',
        });
      } else {
        headerImage.active = String(req.body.active || '') === 'on';
      }

      let oldImageToDelete = '';

      if (req.file) {
        oldImageToDelete = headerImage.image || '';

        const newImage = await uploadImageToS3(req.file, 'business-signup-header-image');

        headerImage.image = newImage;
      }

      if (!headerImage.image) {
        req.flash('error', 'Business Signup Header Image is required. Please upload an image.');

        return res.redirect('/admin/business-signup-header-image/edit');
      }

      /*
       * Save MongoDB first.
       *
       * Only after the new image URL has been persisted successfully
       * may the previous S3 object be removed.
       *
       * This prevents MongoDB from being left pointing to an S3
       * object that was already deleted if the database save fails.
       */
      await headerImage.save();

      if (oldImageToDelete && oldImageToDelete !== headerImage.image) {
        await deleteS3ImageByUrl(oldImageToDelete);
      }

      await logAdminAction(req, {
        action: isCreate
          ? 'business.signup_header_image.create'
          : 'business.signup_header_image.update',

        entityType: 'business_signup_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: businessSignupHeaderImageSnapshot(headerImage),

        meta: {
          section: 'business_signup_header_image',

          uploadedImage: hadImageUpload,
        },
      });

      req.flash('success', 'Business Signup Header Image saved successfully.');

      return res.redirect('/admin/business-signup-header-image');
    } catch (err) {
      console.error('❌ save business signup header image error:', err);

      req.flash('error', err.message || 'Failed to save the Business Signup Header Image.');

      return res.redirect('/admin/business-signup-header-image/edit');
    }
  },
);

/* =========================================================
 * TOGGLE
 * ======================================================= */
router.get(
  '/business-signup-header-image/toggle',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessSignupHeaderImage.findOne({
        singletonKey: 'main',
      });

      if (!headerImage) {
        req.flash('error', 'Business Signup Header Image has not been configured yet.');

        return res.redirect('/admin/business-signup-header-image');
      }

      const before = businessSignupHeaderImageSnapshot(headerImage);

      headerImage.active = !headerImage.active;

      await headerImage.save();

      await logAdminAction(req, {
        action: headerImage.active
          ? 'business.signup_header_image.activate'
          : 'business.signup_header_image.deactivate',

        entityType: 'business_signup_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: businessSignupHeaderImageSnapshot(headerImage),

        meta: {
          section: 'business_signup_header_image',
        },
      });

      req.flash(
        'success',
        `Business Signup Header Image ${
          headerImage.active ? 'activated' : 'deactivated'
        } successfully.`,
      );

      return res.redirect('/admin/business-signup-header-image');
    } catch (err) {
      console.error('❌ toggle business signup header image error:', err);

      req.flash('error', 'Failed to toggle the Business Signup Header Image.');

      return res.redirect('/admin/business-signup-header-image');
    }
  },
);

/* =========================================================
 * MULTER / UPLOAD ERROR HANDLER
 * ======================================================= */
router.use((err, req, res, _next) => {
  console.error('❌ adminBusinessSignupHeaderImage route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  return res.redirect('/admin/business-signup-header-image/edit');
});

module.exports = router;
