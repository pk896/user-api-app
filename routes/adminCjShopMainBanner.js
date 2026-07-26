// routes/adminCjShopMainBanner.js
'use strict';

const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const requireAdmin =
  require('../middleware/requireAdmin');

const requireAdminRole =
  require('../middleware/requireAdminRole');

const requireAdminPermission =
  require('../middleware/requireAdminPermission');

const {
  logAdminAction,
} = require('../utils/logAdminAction');

const CjShopMainBanner =
  require('../models/CjShopMainBanner');

const CjProduct =
  require('../models/CjProduct');

const router = express.Router();

const AWS_REGION =
  process.env.AWS_REGION ||
  'us-east-1';

const BUCKET =
  process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn(
    '⚠️ AWS_BUCKET_NAME missing — CJ Shop Main Banner uploads will fail.',
  );
}

const s3 = new S3Client({
  region: AWS_REGION,

  credentials: {
    accessKeyId:
      process.env.AWS_ACCESS_KEY_ID,

    secretAccessKey:
      process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage:
    multer.memoryStorage(),

  limits: {
    fileSize:
      8 * 1024 * 1024,
  },

  fileFilter:
    (_req, file, callback) => {
      const isAllowed =
        /^image\/(png|jpe?g|webp|gif|bmp)$/
          .test(
            String(
              file?.mimetype || '',
            ),
          );

      if (!isAllowed) {
        return callback(
          new Error(
            'Only PNG, JPG, WEBP, GIF or BMP images are allowed.',
          ),
        );
      }

      return callback(
        null,
        true,
      );
    },
});

function safeString(
  value,
  maxLength = 500,
) {
  return String(value || '')
    .trim()
    .slice(0, maxLength);
}

function escapeRegex(value) {
  return String(value || '')
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );
}

function themeCssFromSession(req) {
  const theme =
    req.session?.theme ||
    'light';

  return theme === 'dark'
    ? '/css/dark.css'
    : '/css/light.css';
}

function normalizePayload(
  body = {},
) {
  return {
    cjProductId:
      safeString(
        body.cjProductId,
        300,
      ),

    title:
      safeString(
        body.title,
        80,
      ) || 'SALE',

    subtitle:
      safeString(
        body.subtitle,
        160,
      ) ||
      'Get Up To 50% Off',

    buttonText:
      safeString(
        body.buttonText,
        40,
      ) ||
      'Shop Now',

    active:
      String(
        body.active || '',
      ) === 'on',
  };
}

function bannerSnapshot(banner) {
  if (!banner) {
    return null;
  }

  return {
    singletonKey:
      banner.singletonKey ||
      'main',

    cjProductId:
      banner.cjProductId ||
      '',

    title:
      banner.title ||
      '',

    subtitle:
      banner.subtitle ||
      '',

    buttonText:
      banner.buttonText ||
      '',

    image:
      banner.image ||
      '',

    active:
      banner.active === true,
  };
}

function extensionFromFilename(
  filename,
) {
  const safeFilename =
    String(filename || '');

  const dotIndex =
    safeFilename.lastIndexOf('.');

  if (dotIndex === -1) {
    return 'bin';
  }

  return safeFilename
    .slice(dotIndex + 1)
    .toLowerCase();
}

function randomKey(
  folder,
  extension,
) {
  return (
    folder +
    '/' +
    uuidv4() +
    '.' +
    extension
  );
}

function buildImageUrl(key) {
  return (
    'https://' +
    BUCKET +
    '.s3.' +
    AWS_REGION +
    '.amazonaws.com/' +
    key
  );
}

async function uploadImageToS3(
  file,
) {
  if (!BUCKET) {
    throw new Error(
      'AWS_BUCKET_NAME is not configured.',
    );
  }

  const extension =
    extensionFromFilename(
      file.originalname,
    );

  const key =
    randomKey(
      'cj-shop-main-banner',
      extension,
    );

  await s3.send(
    new PutObjectCommand({
      Bucket:
        BUCKET,

      Key:
        key,

      Body:
        file.buffer,

      ContentType:
        file.mimetype,
    }),
  );

  return buildImageUrl(key);
}

async function deleteS3ImageByUrl(
  imageUrl,
) {
  try {
    const safeUrl =
      String(imageUrl || '')
        .trim();

    if (
      !safeUrl ||
      !safeUrl.includes('.com/')
    ) {
      return;
    }

    const key =
      safeUrl.split('.com/')[1];

    if (!key) {
      return;
    }

    await s3.send(
      new DeleteObjectCommand({
        Bucket:
          BUCKET,

        Key:
          key,
      }),
    );
  } catch (error) {
    console.warn(
      '⚠️ Failed to delete old CJ Shop Main Banner image:',
      error?.message || error,
    );
  }
}

function getEligibleVariants(
  product,
) {
  return Array.isArray(
    product?.variants,
  )
    ? product.variants.filter(
        (variant) => {
          const price =
            Number(
              variant
                ?.sellingPriceExVat
                ?.value,
            );

          return (
            variant?.isEnabled === true &&
            safeString(
              variant?.cjVariantId,
              300,
            ) &&
            safeString(
              variant?.variantSku,
              300,
            ) &&
            Number.isFinite(price) &&
            price >= 0
          );
        },
      )
    : [];
}

function buildEligibleCjProductQuery(
  extraQuery = {},
) {
  return {
    status:
      'active',

    variants: {
      $elemMatch: {
        isEnabled:
          true,

        cjVariantId: {
          $exists:
            true,

          $ne:
            '',
        },

        variantSku: {
          $exists:
            true,

          $ne:
            '',
        },

        'sellingPriceExVat.value': {
          $gte:
            0,
        },
      },
    },

    ...extraQuery,
  };
}

function getProductPreview(
  product,
) {
  if (!product) {
    return null;
  }

  const variants =
    getEligibleVariants(product);

  if (variants.length < 1) {
    return null;
  }

  const firstVariant =
    variants[0];

  const prices =
    variants
      .map((variant) =>
        Number(
          variant
            ?.sellingPriceExVat
            ?.value,
        ),
      )
      .filter(
        (price) =>
          Number.isFinite(price) &&
          price >= 0,
      );

  const lowestPrice =
    prices.length > 0
      ? Math.min(...prices)
      : 0;

  const category =
    safeString(
      product?.category?.name ||
        product?.category
          ?.secondName ||
        product?.category
          ?.firstName ||
        product?.productType ||
        'CJ Product',
      500,
    );

  return {
    cjProductId:
      safeString(
        product.cjProductId,
        300,
      ),

    productSku:
      safeString(
        product.productSku,
        300,
      ),

    name:
      safeString(
        product.name ||
          'CJ Product',
        500,
      ),

    imageUrl:
      safeString(
        firstVariant?.imageUrl ||
          product.mainImageUrl ||
          '',
        2000,
      ),

    category,

    price:
      Number(
        lowestPrice.toFixed(2),
      ),

    enabledVariantCount:
      variants.length,

    status:
      safeString(
        product.status,
        30,
      ),
  };
}

/* =====================================================
 * CJ SHOP MAIN BANNER DASHBOARD
 * =================================================== */

router.get(
  '/cj-shop-main-banner',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const bannerRaw =
        await CjShopMainBanner
          .findOne({
            singletonKey:
              'main',
          })
          .sort({
            updatedAt:
              -1,
          })
          .lean();

      let banner =
        bannerRaw;

      if (bannerRaw?.cjProductId) {
        const product =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                bannerRaw
                  .cjProductId,
            }),
          ).lean();

        banner = {
          ...bannerRaw,

          product:
            getProductPreview(
              product,
            ),
        };
      }

      return res.render(
        'admin/cj-shop-main-banner/index',
        {
          title:
            'CJ Shop Main Banner',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          banner,

          success:
            req.flash(
              'success',
            ),

          error:
            req.flash(
              'error',
            ),

          info:
            req.flash(
              'info',
            ),

          warning:
            req.flash(
              'warning',
            ),
        },
      );
    } catch (error) {
      console.error(
        '❌ CJ Shop Main Banner dashboard error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ Shop Main Banner.',
      );

      return res.redirect(
        '/admin/shop-main-banner',
      );
    }
  },
);

/* =====================================================
 * EDIT CJ SHOP MAIN BANNER
 * =================================================== */

router.get(
  '/cj-shop-main-banner/edit',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const banner =
        await CjShopMainBanner
          .findOne({
            singletonKey:
              'main',
          })
          .sort({
            updatedAt:
              -1,
          })
          .lean();

      let selectedProduct =
        null;

      if (banner?.cjProductId) {
        const product =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                banner.cjProductId,
            }),
          ).lean();

        selectedProduct =
          getProductPreview(
            product,
          );
      }

      return res.render(
        'admin/cj-shop-main-banner/edit',
        {
          title:
            banner
              ? 'Edit CJ Shop Main Banner'
              : 'Create CJ Shop Main Banner',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          banner,
          selectedProduct,

          success:
            req.flash(
              'success',
            ),

          error:
            req.flash(
              'error',
            ),

          info:
            req.flash(
              'info',
            ),

          warning:
            req.flash(
              'warning',
            ),
        },
      );
    } catch (error) {
      console.error(
        '❌ CJ Shop Main Banner edit-page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ Shop Main Banner editor.',
      );

      return res.redirect(
        '/admin/cj-shop-main-banner',
      );
    }
  },
);

/* =====================================================
 * SEARCH ELIGIBLE IMPORTED CJ PRODUCTS
 * =================================================== */

router.get(
  '/cj-shop-main-banner/products/search',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const keyword =
        safeString(
          req.query.q,
          200,
        );

      if (!keyword) {
        return res.json({
          success:
            true,

          products:
            [],
        });
      }

      const keywordRegex =
        new RegExp(
          escapeRegex(
            keyword,
          ),
          'i',
        );

      const products =
        await CjProduct.find(
          buildEligibleCjProductQuery({
            $or: [
              {
                cjProductId:
                  keywordRegex,
              },

              {
                productSku:
                  keywordRegex,
              },

              {
                name:
                  keywordRegex,
              },

              {
                originalName:
                  keywordRegex,
              },

              {
                productType:
                  keywordRegex,
              },

              {
                'category.name':
                  keywordRegex,
              },

              {
                'category.firstName':
                  keywordRegex,
              },

              {
                'category.secondName':
                  keywordRegex,
              },

              {
                'variants.variantSku':
                  keywordRegex,
              },

              {
                'variants.variantName':
                  keywordRegex,
              },
            ],
          }),
        )
          .sort({
            updatedAt:
              -1,

            importedAt:
              -1,

            _id:
              -1,
          })
          .limit(20)
          .lean();

      const safeProducts =
        products
          .map(
            getProductPreview,
          )
          .filter(
            (product) =>
              product &&
              product.cjProductId &&
              product
                .enabledVariantCount >
                0,
          );

      return res.json({
        success:
          true,

        products:
          safeProducts,
      });
    } catch (error) {
      console.error(
        '❌ CJ Shop Main Banner product search error:',
        error,
      );

      return res.status(500).json({
        success:
          false,

        products:
          [],

        message:
          'Failed to search imported CJ products.',
      });
    }
  },
);

/* =====================================================
 * CREATE OR UPDATE CJ SHOP MAIN BANNER
 * =================================================== */

router.post(
  '/cj-shop-main-banner',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  upload.single(
    'imageFile',
  ),
  async (req, res) => {
    try {
      const payload =
        normalizePayload(
          req.body,
        );

      if (!payload.cjProductId) {
        req.flash(
          'error',
          'Please search for and select an imported CJ product.',
        );

        return res.redirect(
          '/admin/cj-shop-main-banner/edit',
        );
      }

      const product =
        await CjProduct.findOne(
          buildEligibleCjProductQuery({
            cjProductId:
              payload.cjProductId,
          }),
        ).lean();

      const productPreview =
        getProductPreview(
          product,
        );

      if (
        !productPreview ||
        !productPreview
          .cjProductId ||
        productPreview
          .enabledVariantCount <
          1
      ) {
        req.flash(
          'error',
          'The selected CJ product is unavailable, inactive, or has no enabled variant with a valid selling price.',
        );

        return res.redirect(
          '/admin/cj-shop-main-banner/edit',
        );
      }

      let banner =
        await CjShopMainBanner
          .findOne({
            singletonKey:
              'main',
          });

      const before =
        bannerSnapshot(
          banner,
        );

      const isCreate =
        !banner;

      const uploadedImage =
        Boolean(req.file);

      if (!banner) {
        banner =
          new CjShopMainBanner({
            singletonKey:
              'main',

            cjProductId:
              payload.cjProductId,

            title:
              payload.title,

            subtitle:
              payload.subtitle,

            buttonText:
              payload.buttonText,

            active:
              payload.active,

            image:
              '',
          });
      } else {
        banner.cjProductId =
          payload.cjProductId;

        banner.title =
          payload.title;

        banner.subtitle =
          payload.subtitle;

        banner.buttonText =
          payload.buttonText;

        banner.active =
          payload.active;
      }

      if (req.file) {
        const oldImage =
          banner.image;

        const newImage =
          await uploadImageToS3(
            req.file,
          );

        banner.image =
          newImage;

        if (oldImage) {
          await deleteS3ImageByUrl(
            oldImage,
          );
        }
      }

      if (!banner.image) {
        req.flash(
          'error',
          'A CJ Shop Main Banner image is required.',
        );

        return res.redirect(
          '/admin/cj-shop-main-banner/edit',
        );
      }

      await banner.save();

      await logAdminAction(
        req,
        {
          action:
            isCreate
              ? 'cj.shop_main_banner.create'
              : 'cj.shop_main_banner.update',

          entityType:
            'CjShopMainBanner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            bannerSnapshot(
              banner,
            ),

          meta: {
            department:
              'cj',

            section:
              'cj_shop_main_banner',

            cjProductId:
              productPreview
                .cjProductId,

            productName:
              productPreview.name,

            productSku:
              productPreview
                .productSku,

            enabledVariantCount:
              productPreview
                .enabledVariantCount,

            uploadedImage,
          },
        },
      );

      req.flash(
        'success',
        `CJ Shop Main Banner ${
          isCreate
            ? 'created'
            : 'updated'
        } successfully.`,
      );

      return res.redirect(
        '/admin/cj-shop-main-banner',
      );
    } catch (error) {
      console.error(
        '❌ save CJ Shop Main Banner error:',
        error,
      );

      req.flash(
        'error',
        error?.message ||
          'Failed to save the CJ Shop Main Banner.',
      );

      return res.redirect(
        '/admin/cj-shop-main-banner/edit',
      );
    }
  },
);

/* =====================================================
 * ACTIVATE OR DEACTIVATE
 * =================================================== */

router.get(
  '/cj-shop-main-banner/toggle',
  requireAdmin,
  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),
  requireAdminPermission(
    'store.content.manage',
  ),
  async (req, res) => {
    try {
      const banner =
        await CjShopMainBanner
          .findOne({
            singletonKey:
              'main',
          });

      if (!banner) {
        req.flash(
          'error',
          'The CJ Shop Main Banner has not been configured yet.',
        );

        return res.redirect(
          '/admin/cj-shop-main-banner',
        );
      }

      const before =
        bannerSnapshot(
          banner,
        );

      banner.active =
        !banner.active;

      await banner.save();

      await logAdminAction(
        req,
        {
          action:
            banner.active
              ? 'cj.shop_main_banner.activate'
              : 'cj.shop_main_banner.deactivate',

          entityType:
            'CjShopMainBanner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            bannerSnapshot(
              banner,
            ),

          meta: {
            department:
              'cj',

            section:
              'cj_shop_main_banner',
          },
        },
      );

      req.flash(
        'success',
        `CJ Shop Main Banner ${
          banner.active
            ? 'activated'
            : 'deactivated'
        } successfully.`,
      );

      return res.redirect(
        '/admin/cj-shop-main-banner',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ Shop Main Banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to change the CJ Shop Main Banner status.',
      );

      return res.redirect(
        '/admin/cj-shop-main-banner',
      );
    }
  },
);

/* =====================================================
 * ROUTER ERROR HANDLER
 * =================================================== */

router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjShopMainBanner route error:',
      error?.message || error,
    );

    req.flash(
      'error',
      error?.message ||
        'Unexpected CJ Shop Main Banner error.',
    );

    const back =
      req.get('referer');

    if (back) {
      return res.redirect(
        back,
      );
    }

    return res.redirect(
      '/admin/cj-shop-main-banner',
    );
  },
);

module.exports = router;
