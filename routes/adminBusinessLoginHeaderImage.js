// routes/adminBusinessLoginHeaderImage.js
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

const BusinessLoginHeaderImage = require('../models/BusinessLoginHeaderImage');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — Business Login header image uploads will fail.');
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
    const allowed = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(file.mimetype);

    if (!allowed) {
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

function businessLoginHeaderImageSnapshot(headerImage) {
  if (!headerImage) {
    return null;
  }

  return {
    image: headerImage.image || '',

    active: !!headerImage.active,
  };
}

async function uploadImageToS3(file, folder) {
  if (!BUCKET) {
    throw new Error('AWS_BUCKET_NAME is not configured.');
  }

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

    /*
     * Delete only objects belonging to Kasyora's
     * configured S3 bucket.
     */
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
    console.warn('⚠️ Failed to delete Business Login header image from S3:', err.message);
  }
}

/*
 * =========================================
 * INDEX
 * =========================================
 */
router.get(
  '/business-login-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessLoginHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/business-login-header-image/index', {
        title: 'Business Login Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Business Login header image index error:', err);

      req.flash('error', 'Could not load the Business Login header image.');

      return res.redirect('/admin/dashboard');
    }
  },
);

/*
 * =========================================
 * EDIT
 * =========================================
 */
router.get(
  '/business-login-header-image/edit',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessLoginHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/business-login-header-image/edit', {
        title: 'Edit Business Login Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Business Login header image edit error:', err);

      req.flash('error', 'Could not load the Business Login header image.');

      return res.redirect('/admin/business-login-header-image');
    }
  },
);

/*
 * =========================================
 * SAVE
 * =========================================
 */
router.post(
  '/business-login-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  upload.single('imageFile'),

  async (req, res) => {
    try {
      let headerImage = await BusinessLoginHeaderImage.findOne({
        singletonKey: 'main',
      });

      const before = businessLoginHeaderImageSnapshot(headerImage);

      const isCreate = !headerImage;

      const hadImageUpload = !!req.file;

      if (!headerImage) {
        headerImage = new BusinessLoginHeaderImage({
          singletonKey: 'main',

          image: '',

          active: String(req.body.active || '') === 'on',
        });
      } else {
        headerImage.active = String(req.body.active || '') === 'on';
      }

      const oldImage = headerImage.image || '';

      let uploadedNewImage = '';

      if (req.file) {
        uploadedNewImage = await uploadImageToS3(req.file, 'business-login-header-image');

        headerImage.image = uploadedNewImage;
      }

      if (!headerImage.image) {
        req.flash('error', 'Business Login Header Image is required. Please upload an image.');

        return res.redirect('/admin/business-login-header-image/edit');
      }

      /*
       * Persist the new MongoDB URL before
       * removing the previous S3 object.
       */
      try {
        await headerImage.save();
      } catch (saveErr) {
        /*
         * MongoDB rejected the new value.
         * Remove only the newly-uploaded object.
         */
        if (uploadedNewImage && uploadedNewImage !== oldImage) {
          await deleteS3ImageByUrl(uploadedNewImage);
        }

        throw saveErr;
      }

      /*
       * MongoDB now references the replacement,
       * so the old S3 object can be removed.
       */
      if (uploadedNewImage && oldImage && oldImage !== uploadedNewImage) {
        await deleteS3ImageByUrl(oldImage);
      }

      await logAdminAction(req, {
        action: isCreate
          ? 'store.business_login_header_image.create'
          : 'store.business_login_header_image.update',

        entityType: 'business_login_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: businessLoginHeaderImageSnapshot(headerImage),

        meta: {
          section: 'business_login_header_image',

          uploadedImage: hadImageUpload,
        },
      });

      req.flash('success', 'Business Login header image saved successfully.');

      return res.redirect('/admin/business-login-header-image');
    } catch (err) {
      console.error('❌ save Business Login header image error:', err);

      req.flash('error', err.message || 'Failed to save the Business Login header image.');

      return res.redirect('/admin/business-login-header-image');
    }
  },
);

/*
 * =========================================
 * TOGGLE
 * =========================================
 */
router.get(
  '/business-login-header-image/toggle',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await BusinessLoginHeaderImage.findOne({
        singletonKey: 'main',
      });

      if (!headerImage) {
        req.flash('error', 'Business Login header image not found.');

        return res.redirect('/admin/business-login-header-image');
      }

      const before = businessLoginHeaderImageSnapshot(headerImage);

      headerImage.active = !headerImage.active;

      await headerImage.save();

      await logAdminAction(req, {
        action: headerImage.active
          ? 'store.business_login_header_image.activate'
          : 'store.business_login_header_image.deactivate',

        entityType: 'business_login_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: businessLoginHeaderImageSnapshot(headerImage),

        meta: {
          section: 'business_login_header_image',
        },
      });

      req.flash(
        'success',
        `Business Login header image ${
          headerImage.active ? 'activated' : 'deactivated'
        } successfully.`,
      );

      return res.redirect('/admin/business-login-header-image');
    } catch (err) {
      console.error('❌ toggle Business Login header image error:', err);

      req.flash('error', 'Failed to toggle the Business Login header image.');

      return res.redirect('/admin/business-login-header-image');
    }
  },
);

/*
 * =========================================
 * MULTER / ROUTE ERROR HANDLER
 * =========================================
 */
router.use((err, req, res, _next) => {
  console.error('❌ adminBusinessLoginHeaderImage route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');

  if (back) {
    return res.redirect(back);
  }

  return res.redirect('/admin/business-login-header-image');
});

module.exports = router;
