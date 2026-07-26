// routes/adminCjShopSidebarBanner.js
'use strict';

const express = require('express');
const router = express.Router();

const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const requireAdmin = require('../middleware/requireAdmin');
const requireAdminRole = require('../middleware/requireAdminRole');
const requireAdminPermission = require('../middleware/requireAdminPermission');

const { logAdminAction } = require('../utils/logAdminAction');

/*
 * Separate CJ Shop Sidebar Banner model.
 *
 * This route must never import or query:
 *
 * - ShopSidebarBanner
 * - Product
 * - Product.customId
 */
const CjShopSidebarBanner = require('../models/CjShopSidebarBanner');
const CjProduct = require('../models/CjProduct');

const AWS_REGION =
  String(process.env.AWS_REGION || 'us-east-1').trim();

const BUCKET =
  String(process.env.AWS_BUCKET_NAME || '').trim();

if (!BUCKET) {
  console.warn(
    '⚠️ AWS_BUCKET_NAME missing — CJ shop sidebar banner uploads will fail.',
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

  fileFilter: (
    _req,
    file,
    callback,
  ) => {
    const isAllowedImage =
      /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(
        String(file?.mimetype || ''),
      );

    if (!isAllowedImage) {
      return callback(
        new Error(
          'Only PNG, JPG, JPEG, WEBP, GIF or BMP images are allowed.',
        ),
      );
    }

    return callback(
      null,
      true,
    );
  },
});

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

function extFromFilename(filename) {
  const safeFilename =
    String(filename || '').trim();

  const dotIndex =
    safeFilename.lastIndexOf('.');

  if (
    dotIndex < 0 ||
    dotIndex === safeFilename.length - 1
  ) {
    return 'bin';
  }

  return safeFilename
    .slice(dotIndex + 1)
    .toLowerCase();
}

function randomKey(folder, extension) {
  return (
    String(folder || '').replace(/\/+$/, '') +
    '/' +
    uuidv4() +
    '.' +
    extension
  );
}

function themeCssFromSession(req) {
  const theme =
    String(
      req.session?.theme ||
      'light',
    ).trim().toLowerCase();

  return theme === 'dark'
    ? '/css/dark.css'
    : '/css/light.css';
}

function normalizePayload(body) {
  return {
    cjProductId:
      String(
        body?.cjProductId ||
        '',
      ).trim(),

    title:
      String(
        body?.title ||
        '',
      ).trim(),

    subtitle:
      String(
        body?.subtitle ||
        '',
      ).trim(),

    buttonText:
      String(
        body?.buttonText ||
        '',
      ).trim() ||
      'Shop Now',

    active:
      String(
        body?.active ||
        '',
      ) === 'on',
  };
}

function cjShopSidebarBannerSnapshot(
  banner,
) {
  if (!banner) {
    return null;
  }

  return {
    cjProductId:
      String(
        banner.cjProductId ||
        '',
      ).trim(),

    title:
      String(
        banner.title ||
        '',
      ).trim(),

    subtitle:
      String(
        banner.subtitle ||
        '',
      ).trim(),

    buttonText:
      String(
        banner.buttonText ||
        '',
      ).trim(),

    image:
      String(
        banner.image ||
        '',
      ).trim(),

    active:
      banner.active === true,
  };
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

function getEnabledCjVariants(product) {
  return Array.isArray(
    product?.variants,
  )
    ? product.variants.filter(
        (variant) =>
          variant?.isEnabled === true &&
          String(
            variant?.cjVariantId ||
            '',
          ).trim() &&
          String(
            variant?.variantSku ||
            '',
          ).trim() &&
          Number.isFinite(
            Number(
              variant?.sellingPriceExVat
                ?.value,
            ),
          ) &&
          Number(
            variant?.sellingPriceExVat
              ?.value,
          ) >= 0,
      )
    : [];
}

function mapAdminCjProduct(product) {
  const enabledVariants =
    getEnabledCjVariants(
      product,
    );

  const prices =
    enabledVariants
      .map((variant) =>
        Number(
          variant?.sellingPriceExVat
            ?.value,
        ),
      )
      .filter(
        (value) =>
          Number.isFinite(value) &&
          value >= 0,
      );

  const minimumPrice =
    prices.length > 0
      ? Math.min(...prices)
      : 0;

  const firstVariant =
    enabledVariants[0] ||
    null;

  const category =
    String(
      product?.category?.name ||
      product?.category?.secondName ||
      product?.category?.firstName ||
      product?.productType ||
      'CJ Product',
    ).trim();

  return {
    cjProductId:
      String(
        product?.cjProductId ||
        '',
      ).trim(),

    productSku:
      String(
        product?.productSku ||
        '',
      ).trim(),

    name:
      String(
        product?.name ||
        'CJ Product',
      ).trim(),

    imageUrl:
      String(
        firstVariant?.imageUrl ||
        product?.mainImageUrl ||
        '',
      ).trim(),

    category,

    price:
      Number(
        minimumPrice.toFixed(2),
      ),

    enabledVariantCount:
      enabledVariants.length,

    cjListedNumber:
      Math.max(
        0,
        Number(
          product?.cjListedNumber ||
          0,
        ),
      ),

    avgRating:
      Math.max(
        0,
        Math.min(
          5,
          Number(
            product?.avgRating ||
            0,
          ),
        ),
      ),

    ratingsCount:
      Math.max(
        0,
        Math.floor(
          Number(
            product?.ratingsCount ||
            0,
          ),
        ),
      ),
  };
}

async function uploadImageToS3(
  file,
  folder,
) {
  if (!BUCKET) {
    throw new Error(
      'AWS bucket is not configured.',
    );
  }

  const extension =
    extFromFilename(
      file?.originalname,
    );

  const key =
    randomKey(
      folder,
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

  return buildImageUrl(
    key,
  );
}

async function deleteS3ImageByUrl(
  imageUrl,
) {
  try {
    const safeImageUrl =
      String(
        imageUrl ||
        '',
      ).trim();

    if (
      !safeImageUrl ||
      !safeImageUrl.includes(
        '.com/',
      )
    ) {
      return;
    }

    const oldKey =
      safeImageUrl
        .split('.com/')
        .slice(1)
        .join('.com/')
        .trim();

    if (!oldKey) {
      return;
    }

    await s3.send(
      new DeleteObjectCommand({
        Bucket:
          BUCKET,

        Key:
          oldKey,
      }),
    );
  } catch (error) {
    console.warn(
      '⚠️ Failed to delete old CJ shop sidebar banner image:',
      error?.message ||
      error,
    );
  }
}

/*
 * INDEX
 *
 * Display the current separate CJ Shop Sidebar Banner.
 */
router.get(
  '/cj-shop-sidebar-banner',

  requireAdmin,

  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),

  requireAdminPermission(
    'store.content.manage',
  ),

  async (
    req,
    res,
  ) => {
    try {
      const bannerRaw =
        await CjShopSidebarBanner.findOne({})
          .sort({
            updatedAt:
              -1,
          })
          .lean();

      let banner =
        bannerRaw;

      if (
        bannerRaw?.cjProductId
      ) {
        const productRaw =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                String(
                  bannerRaw.cjProductId,
                ).trim(),
            }),
          )
            .select(
              [
                'cjProductId',
                'productSku',
                'name',
                'mainImageUrl',
                'category',
                'productType',
                'variants',
                'cjListedNumber',
                'avgRating',
                'ratingsCount',
              ].join(' '),
            )
            .lean();

        banner = {
          ...bannerRaw,

          product:
            productRaw
              ? mapAdminCjProduct(
                  productRaw,
                )
              : null,
        };
      }

      return res.render(
        'admin/cj-shop-sidebar-banner/index',
        {
          title:
            'CJ Shop Sidebar Banner',

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
        '❌ admin CJ shop sidebar banner index error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ shop sidebar banner.',
      );

      return res.redirect(
        '/admin/dashboard',
      );
    }
  },
);

/*
 * EDIT PAGE
 */
router.get(
  '/cj-shop-sidebar-banner/edit',

  requireAdmin,

  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),

  requireAdminPermission(
    'store.content.manage',
  ),

  async (
    req,
    res,
  ) => {
    try {
      const bannerRaw =
        await CjShopSidebarBanner.findOne({})
          .sort({
            updatedAt:
              -1,
          })
          .lean();

      let selectedProduct =
        null;

      let banner =
        bannerRaw;

      if (
        bannerRaw?.cjProductId
      ) {
        const selectedProductRaw =
          await CjProduct.findOne(
            buildEligibleCjProductQuery({
              cjProductId:
                String(
                  bannerRaw.cjProductId,
                ).trim(),
            }),
          )
            .select(
              [
                'cjProductId',
                'productSku',
                'name',
                'mainImageUrl',
                'category',
                'productType',
                'variants',
                'cjListedNumber',
                'avgRating',
                'ratingsCount',
              ].join(' '),
            )
            .lean();

        if (
          selectedProductRaw
        ) {
          selectedProduct =
            mapAdminCjProduct(
              selectedProductRaw,
            );
        }

        banner = {
          ...bannerRaw,

          product:
            selectedProduct,
        };
      }

      return res.render(
        'admin/cj-shop-sidebar-banner/edit',
        {
          title:
            'Edit CJ Shop Sidebar Banner',

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
        '❌ CJ shop sidebar banner edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ shop sidebar banner.',
      );

      return res.redirect(
        '/admin/cj-shop-sidebar-banner',
      );
    }
  },
);

/*
 * SEARCH CJ PRODUCTS
 *
 * This endpoint queries only imported, active CjProduct records.
 */
router.get(
  '/cj-shop-sidebar-banner/products/search',

  requireAdmin,

  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),

  requireAdminPermission(
    'store.content.manage',
  ),

  async (
    req,
    res,
  ) => {
    try {
      const queryText =
        String(
          req.query?.q ||
          '',
        ).trim();

      if (!queryText) {
        return res.json({
          success:
            true,

          products:
            [],
        });
      }

      const safeQueryText =
        queryText.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );

      const queryRegex =
        new RegExp(
          safeQueryText,
          'i',
        );

      const productsRaw =
        await CjProduct.find(
          buildEligibleCjProductQuery({
            $or: [
              {
                cjProductId:
                  queryRegex,
              },

              {
                productSku:
                  queryRegex,
              },

              {
                name:
                  queryRegex,
              },

              {
                originalName:
                  queryRegex,
              },

              {
                'variants.variantSku':
                  queryRegex,
              },
            ],
          }),
        )
          .select(
            [
              'cjProductId',
              'productSku',
              'name',
              'mainImageUrl',
              'category',
              'productType',
              'variants',
              'cjListedNumber',
              'avgRating',
              'ratingsCount',
              'updatedAt',
              'importedAt',
            ].join(' '),
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

      const products =
        productsRaw
          .map(
            mapAdminCjProduct,
          )
          .filter(
            (product) =>
              product.cjProductId &&
              product
                .enabledVariantCount >
                0,
          );

      return res.json({
        success:
          true,

        products,
      });
    } catch (error) {
      console.error(
        '❌ CJ shop sidebar banner product search error:',
        error,
      );

      return res.status(
        500,
      ).json({
        success:
          false,

        products:
          [],

        message:
          'Failed to search CJ products.',
      });
    }
  },
);

/*
 * SAVE
 */
router.post(
  '/cj-shop-sidebar-banner',

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

  async (
    req,
    res,
  ) => {
    try {
      const payload =
        normalizePayload(
          req.body,
        );

      if (
        !payload.cjProductId
      ) {
        req.flash(
          'error',
          'Please select a CJ product.',
        );

        return res.redirect(
          '/admin/cj-shop-sidebar-banner/edit',
        );
      }

      const productRaw =
        await CjProduct.findOne(
          buildEligibleCjProductQuery({
            cjProductId:
              payload.cjProductId,
          }),
        )
          .select(
            [
              'cjProductId',
              'productSku',
              'name',
              'mainImageUrl',
              'category',
              'productType',
              'variants',
              'cjListedNumber',
              'avgRating',
              'ratingsCount',
            ].join(' '),
          )
          .lean();

      if (!productRaw) {
        req.flash(
          'error',
          'Selected CJ product was not found, is inactive, or has no valid enabled variant.',
        );

        return res.redirect(
          '/admin/cj-shop-sidebar-banner/edit',
        );
      }

      const mappedProduct =
        mapAdminCjProduct(
          productRaw,
        );

      if (
        mappedProduct
          .enabledVariantCount < 1
      ) {
        req.flash(
          'error',
          'Selected CJ product does not have a valid enabled variant.',
        );

        return res.redirect(
          '/admin/cj-shop-sidebar-banner/edit',
        );
      }

      let banner =
        await CjShopSidebarBanner.findOne({});

      const before =
        cjShopSidebarBannerSnapshot(
          banner,
        );

      const isCreate =
        !banner;

      const hadImageUpload =
        Boolean(
          req.file,
        );

      if (!banner) {
        banner =
          new CjShopSidebarBanner({
            ...payload,

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
          String(
            banner.image ||
            '',
          ).trim();

        const newImage =
          await uploadImageToS3(
            req.file,
            'cj-shop-sidebar-banner',
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
          'CJ banner image is required. Please upload an image.',
        );

        return res.redirect(
          '/admin/cj-shop-sidebar-banner/edit',
        );
      }

      await banner.save();

      await logAdminAction(
        req,
        {
          action:
            isCreate
              ? 'cj.shop_sidebar_banner.create'
              : 'cj.shop_sidebar_banner.update',

          entityType:
            'cj_shop_sidebar_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjShopSidebarBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_shop_sidebar_banner',

            department:
              'CJ',

            cjProductId:
              payload.cjProductId,

            productName:
              mappedProduct.name,

            productSku:
              mappedProduct.productSku,

            uploadedImage:
              hadImageUpload,
          },
        },
      );

      req.flash(
        'success',
        'CJ shop sidebar banner saved successfully.',
      );

      return res.redirect(
        '/admin/cj-shop-sidebar-banner',
      );
    } catch (error) {
      console.error(
        '❌ save CJ shop sidebar banner error:',
        error,
      );

      req.flash(
        'error',
        error?.message ||
        'Failed to save the CJ shop sidebar banner.',
      );

      return res.redirect(
        '/admin/cj-shop-sidebar-banner/edit',
      );
    }
  },
);

/*
 * TOGGLE
 */
router.get(
  '/cj-shop-sidebar-banner/toggle',

  requireAdmin,

  requireAdminRole([
    'super_admin',
    'store_admin',
  ]),

  requireAdminPermission(
    'store.content.manage',
  ),

  async (
    req,
    res,
  ) => {
    try {
      const banner =
        await CjShopSidebarBanner.findOne({});

      if (!banner) {
        req.flash(
          'error',
          'CJ shop sidebar banner was not found.',
        );

        return res.redirect(
          '/admin/cj-shop-sidebar-banner',
        );
      }

      const before =
        cjShopSidebarBannerSnapshot(
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
              ? 'cj.shop_sidebar_banner.activate'
              : 'cj.shop_sidebar_banner.deactivate',

          entityType:
            'cj_shop_sidebar_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjShopSidebarBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_shop_sidebar_banner',

            department:
              'CJ',

            cjProductId:
              String(
                banner.cjProductId ||
                '',
              ).trim(),
          },
        },
      );

      req.flash(
        'success',
        'CJ shop sidebar banner ' +
          (
            banner.active
              ? 'activated'
              : 'deactivated'
          ) +
          ' successfully.',
      );

      return res.redirect(
        '/admin/cj-shop-sidebar-banner',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ shop sidebar banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to toggle the CJ shop sidebar banner.',
      );

      return res.redirect(
        '/admin/cj-shop-sidebar-banner',
      );
    }
  },
);

/*
 * MULTER AND ROUTE ERROR HANDLER
 */
router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjShopSidebarBanner route error:',
      error?.message ||
      error,
    );

    req.flash(
      'error',
      error?.message ||
      'Unexpected server error.',
    );

    const referer =
      req.get(
        'referer',
      );

    if (referer) {
      return res.redirect(
        referer,
      );
    }

    return res.redirect(
      '/admin/cj-shop-sidebar-banner',
    );
  },
);

module.exports = router;
