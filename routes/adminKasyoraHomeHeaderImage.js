// routes/adminKasyoraHomeHeaderImage.js
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

const KasyoraHomeHeaderImage = require('../models/KasyoraHomeHeaderImage');

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';

const BUCKET = process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn('⚠️ AWS_BUCKET_NAME missing — Kasyora Home header image uploads will fail.');
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

function homeHeaderImageSnapshot(headerImage) {
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
     * Delete only objects that belong to Kasyora's
     * configured S3 bucket.
     *
     * Never derive a deletion key from an arbitrary URL.
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
    console.warn('⚠️ Failed to delete Kasyora Home header image from S3:', err.message);
  }
}

/*
 * =========================================
 * INDEX
 * =========================================
 */
router.get(
  '/kasyora-home-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await KasyoraHomeHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/kasyora-home-header-image/index', {
        title: 'Kasyora Home Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ admin Kasyora Home header image index error:', err);

      req.flash('error', 'Could not load the Kasyora Home header image.');

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
  '/kasyora-home-header-image/edit',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await KasyoraHomeHeaderImage.findOne({
        singletonKey: 'main',
      }).lean();

      return res.render('admin/kasyora-home-header-image/edit', {
        title: 'Edit Kasyora Home Header Image',

        themeCss: themeCssFromSession(req),

        nonce: res.locals.nonce,

        headerImage,

        success: req.flash('success'),

        error: req.flash('error'),

        info: req.flash('info'),

        warning: req.flash('warning'),
      });
    } catch (err) {
      console.error('❌ Kasyora Home header image edit page error:', err);

      req.flash('error', 'Could not load the Kasyora Home header image.');

      return res.redirect('/admin/kasyora-home-header-image');
    }
  },
);

/*
 * =========================================
 * SAVE
 * =========================================
 */
router.post(
  '/kasyora-home-header-image',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  upload.single('imageFile'),

  async (req, res) => {
    try {
      let headerImage = await KasyoraHomeHeaderImage.findOne({
        singletonKey: 'main',
      });

      const before = homeHeaderImageSnapshot(headerImage);

      const isCreate = !headerImage;

      const hadImageUpload = !!req.file;

      if (!headerImage) {
        headerImage = new KasyoraHomeHeaderImage({
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
        uploadedNewImage = await uploadImageToS3(req.file, 'kasyora-home-header-image');

        headerImage.image = uploadedNewImage;
      }

      if (!headerImage.image) {
        req.flash('error', 'Home header image is required. Please upload an image.');

        return res.redirect('/admin/kasyora-home-header-image/edit');
      }

      /*
       * Save MongoDB before deleting the old
       * S3 object.
       */
      try {
        await headerImage.save();
      } catch (saveErr) {
        /*
         * MongoDB rejected the new value.
         *
         * Remove only the newly-uploaded
         * S3 object.
         *
         * The previous database URL and
         * previous S3 object remain intact.
         */
        if (uploadedNewImage && uploadedNewImage !== oldImage) {
          await deleteS3ImageByUrl(uploadedNewImage);
        }

        throw saveErr;
      }

      /*
       * MongoDB now safely references the
       * replacement.
       *
       * The previous S3 object may now
       * be removed.
       */
      if (uploadedNewImage && oldImage && oldImage !== uploadedNewImage) {
        await deleteS3ImageByUrl(oldImage);
      }

      await logAdminAction(req, {
        action: isCreate
          ? 'store.kasyora_home_header_image.create'
          : 'store.kasyora_home_header_image.update',

        entityType: 'kasyora_home_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: homeHeaderImageSnapshot(headerImage),

        meta: {
          section: 'kasyora_home_header_image',

          uploadedImage: hadImageUpload,
        },
      });

      req.flash('success', 'Kasyora Home header image saved successfully.');

      return res.redirect('/admin/kasyora-home-header-image');
    } catch (err) {
      console.error('❌ save Kasyora Home header image error:', err);

      req.flash('error', err.message || 'Failed to save the Kasyora Home header image.');

      return res.redirect('/admin/kasyora-home-header-image');
    }
  },
);

/*
 * =========================================
 * TOGGLE
 * =========================================
 *
 * This intentionally follows the existing
 * Kasyora admin content-management pattern.
 */
router.get(
  '/kasyora-home-header-image/toggle',

  requireAdmin,

  requireAdminRole(['super_admin', 'store_admin']),

  requireAdminPermission('store.content.manage'),

  async (req, res) => {
    try {
      const headerImage = await KasyoraHomeHeaderImage.findOne({
        singletonKey: 'main',
      });

      if (!headerImage) {
        req.flash('error', 'Kasyora Home header image not found.');

        return res.redirect('/admin/kasyora-home-header-image');
      }

      const before = homeHeaderImageSnapshot(headerImage);

      headerImage.active = !headerImage.active;

      await headerImage.save();

      await logAdminAction(req, {
        action: headerImage.active
          ? 'store.kasyora_home_header_image.activate'
          : 'store.kasyora_home_header_image.deactivate',

        entityType: 'kasyora_home_header_image',

        entityId: String(headerImage._id),

        status: 'success',

        before,

        after: homeHeaderImageSnapshot(headerImage),

        meta: {
          section: 'kasyora_home_header_image',
        },
      });

      req.flash(
        'success',
        `Kasyora Home header image ${
          headerImage.active ? 'activated' : 'deactivated'
        } successfully.`,
      );

      return res.redirect('/admin/kasyora-home-header-image');
    } catch (err) {
      console.error('❌ toggle Kasyora Home header image error:', err);

      req.flash('error', 'Failed to toggle the Kasyora Home header image.');

      return res.redirect('/admin/kasyora-home-header-image');
    }
  },
);

/*
 * =========================================
 * MULTER / ROUTE ERROR HANDLER
 * =========================================
 */
router.use((err, req, res, _next) => {
  console.error('❌ adminKasyoraHomeHeaderImage route error:', err.message);

  req.flash('error', err.message || 'Unexpected server error.');

  const back = req.get('referer');

  if (back) {
    return res.redirect(back);
  }

  return res.redirect('/admin/kasyora-home-header-image');
});

module.exports = router;
