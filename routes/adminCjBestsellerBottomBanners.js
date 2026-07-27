// routes/adminCjBestsellerBottomBanners.js
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

const CjBestsellerBottomBanner = require(
  '../models/CjBestsellerBottomBanner',
);
const CjProduct = require('../models/CjProduct');

const AWS_REGION =
  process.env.AWS_REGION ||
  'us-east-1';

const BUCKET =
  process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn(
    '⚠️ AWS_BUCKET_NAME missing — CJ bestseller bottom banner uploads will fail.',
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
      const allowed =
        /^image\/(png|jpe?g|webp|gif|bmp)$/i.test(
          String(
            file?.mimetype || '',
          ),
        );

      if (!allowed) {
        return callback(
          new Error(
            'Only PNG/JPG/WEBP/GIF/BMP images are allowed.',
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

function extFromFilename(name) {
  const safeName =
    String(
      name || '',
    ).trim();

  const dot =
    safeName.lastIndexOf('.');

  if (dot === -1) {
    return 'bin';
  }

  return safeName
    .substring(dot + 1)
    .toLowerCase();
}

function randomKey(folder, extension) {
  return (
    folder +
    '/' +
    uuidv4() +
    '.' +
    extension
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

function normalizePayload(body) {
  const numericSortOrder =
    Number(
      body?.sortOrder || 0,
    );

  return {
    cjProductId:
      String(
        body?.cjProductId || '',
      ).trim(),

    title:
      String(
        body?.title || '',
      ).trim(),

    subtitle:
      String(
        body?.subtitle || '',
      ).trim(),

    priceText:
      String(
        body?.priceText || '',
      ).trim(),

    buttonText:
      String(
        body?.buttonText || '',
      ).trim() ||
      'Shop Now',

    overlayStyle:
      String(
        body?.overlayStyle || '',
      ).trim(),

    active:
      String(
        body?.active || '',
      ) === 'on',

    sortOrder:
      Number.isFinite(
        numericSortOrder,
      )
        ? numericSortOrder
        : 0,
  };
}

function cjBestsellerBottomBannerSnapshot(
  banner,
) {
  if (!banner) {
    return null;
  }

  return {
    slot:
      String(
        banner.slot || '',
      ),

    cjProductId:
      String(
        banner.cjProductId || '',
      ),

    title:
      String(
        banner.title || '',
      ),

    subtitle:
      String(
        banner.subtitle || '',
      ),

    priceText:
      String(
        banner.priceText || '',
      ),

    buttonText:
      String(
        banner.buttonText || '',
      ),

    overlayStyle:
      String(
        banner.overlayStyle || '',
      ),

    image:
      String(
        banner.image || '',
      ),

    active:
      banner.active === true,

    sortOrder:
      Number(
        banner.sortOrder || 0,
      ),
  };
}

/*
 * A CJ product is eligible only when:
 *
 * - status is active
 * - it has at least one enabled variant
 * - that variant has a CJ variant ID
 * - that variant has a variant SKU
 * - that variant has a valid selling price excluding VAT
 */
function eligibleCjProductQuery(
  extraQuery = {},
) {
  return {
    status: 'active',

    variants: {
      $elemMatch: {
        isEnabled: true,

        cjVariantId: {
          $exists: true,
          $ne: '',
        },

        variantSku: {
          $exists: true,
          $ne: '',
        },

        'sellingPriceExVat.value': {
          $gte: 0,
        },
      },
    },

    ...extraQuery,
  };
}

function getEnabledValidVariants(
  product,
) {
  if (
    !Array.isArray(
      product?.variants,
    )
  ) {
    return [];
  }

  return product.variants.filter(
    (variant) => {
      if (
        variant?.isEnabled !== true
      ) {
        return false;
      }

      const cjVariantId =
        String(
          variant?.cjVariantId || '',
        ).trim();

      const variantSku =
        String(
          variant?.variantSku || '',
        ).trim();

      const price =
        Number(
          variant?.sellingPriceExVat
            ?.value,
        );

      return (
        cjVariantId &&
        variantSku &&
        Number.isFinite(price) &&
        price >= 0
      );
    },
  );
}

function mapAdminCjProduct(product) {
  if (!product) {
    return null;
  }

  const validVariants =
    getEnabledValidVariants(
      product,
    );

  if (
    validVariants.length < 1
  ) {
    return null;
  }

  const firstVariant =
    validVariants[0];

  const prices =
    validVariants
      .map((variant) =>
        Number(
          variant?.sellingPriceExVat
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
        product.cjProductId || '',
      ).trim(),

    productSku:
      String(
        product.productSku || '',
      ).trim(),

    name:
      String(
        product.name ||
        'CJ Product',
      ).trim(),

    imageUrl:
      String(
        firstVariant?.imageUrl ||
        product.mainImageUrl ||
        '',
      ).trim(),

    category,

    productType:
      String(
        product.productType || '',
      ).trim(),

    price:
      Number(
        lowestPrice.toFixed(2),
      ),

    enabledVariantCount:
      validVariants.length,
  };
}

async function findEligibleCjProduct(
  cjProductId,
) {
  const safeCjProductId =
    String(
      cjProductId || '',
    ).trim();

  if (!safeCjProductId) {
    return null;
  }

  const product =
    await CjProduct.findOne(
      eligibleCjProductQuery({
        cjProductId:
          safeCjProductId,
      }),
    ).lean();

  if (!product) {
    return null;
  }

  return product;
}

async function uploadImageToS3(
  file,
  folder,
) {
  if (!BUCKET) {
    throw new Error(
      'AWS_BUCKET_NAME is not configured.',
    );
  }

  const originalName =
    String(
      file?.originalname || '',
    );

  const extension =
    extFromFilename(
      originalName,
    );

  const key =
    randomKey(
      folder,
      extension,
    );

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,

      Key: key,

      Body: file.buffer,

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
        imageUrl || '',
      ).trim();

    if (
      !safeImageUrl ||
      !safeImageUrl.includes('.com/')
    ) {
      return;
    }

    const oldKey =
      safeImageUrl
        .split('.com/')[1];

    if (!oldKey) {
      return;
    }

    await s3.send(
      new DeleteObjectCommand({
        Bucket: BUCKET,

        Key: oldKey,
      }),
    );
  } catch (error) {
    console.warn(
      '⚠️ Failed to delete old CJ bestseller bottom banner image:',
      error?.message ||
      error,
    );
  }
}

/*
 * =====================================================
 * INDEX
 * =====================================================
 */
router.get(
  '/cj-bestseller-bottom-banners',

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
      const banners =
        await CjBestsellerBottomBanner
          .find({})
          .sort({
            sortOrder: 1,
            createdAt: 1,
          })
          .lean();

      const bannersWithProducts =
        await Promise.all(
          banners.map(
            async (banner) => {
              let product = null;

              if (
                banner?.cjProductId
              ) {
                const rawProduct =
                  await findEligibleCjProduct(
                    banner.cjProductId,
                  );

                product =
                  mapAdminCjProduct(
                    rawProduct,
                  );
              }

              return {
                ...banner,
                product,
              };
            },
          ),
        );

      return res.render(
        'admin/cj-bestseller-bottom-banners/index',
        {
          title:
            'CJ Bestseller Bottom Banners',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          banners:
            bannersWithProducts,

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
        '❌ admin CJ bestseller bottom banners index error:',
        error,
      );

      req.flash(
        'error',
        'Could not load CJ bestseller bottom banners.',
      );

      return res.redirect(
        '/admin/dashboard',
      );
    }
  },
);

/*
 * =====================================================
 * EDIT
 * =====================================================
 */
router.get(
  '/cj-bestseller-bottom-banners/:slot/edit',

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
      const slot =
        String(
          req.params.slot || '',
        )
          .trim()
          .toLowerCase();

      if (
        ![
          'left',
          'right',
        ].includes(slot)
      ) {
        req.flash(
          'error',
          'Invalid CJ bestseller bottom banner slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-bottom-banners',
        );
      }

      const bannerRaw =
        await CjBestsellerBottomBanner
          .findOne({
            slot,
          })
          .lean();

      let selectedProduct = null;

      if (
        bannerRaw?.cjProductId
      ) {
        const rawProduct =
          await findEligibleCjProduct(
            bannerRaw.cjProductId,
          );

        selectedProduct =
          mapAdminCjProduct(
            rawProduct,
          );
      }

      const banner =
        bannerRaw
          ? {
              ...bannerRaw,

              product:
                selectedProduct,
            }
          : null;

      return res.render(
        'admin/cj-bestseller-bottom-banners/edit',
        {
          title:
            'Edit ' +
            (
              slot === 'left'
                ? 'Left'
                : 'Right'
            ) +
            ' CJ Bestseller Bottom Banner',

          themeCss:
            themeCssFromSession(
              req,
            ),

          nonce:
            res.locals.nonce,

          slot,

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
        '❌ CJ bestseller bottom banner edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ bestseller bottom banner.',
      );

      return res.redirect(
        '/admin/cj-bestseller-bottom-banners',
      );
    }
  },
);

/*
 * =====================================================
 * SEARCH ELIGIBLE CJ PRODUCTS
 * =====================================================
 */
router.get(
  '/cj-bestseller-bottom-banners/products/search',

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
      const queryText =
        String(
          req.query.q || '',
        ).trim();

      if (!queryText) {
        return res.json({
          success: true,
          products: [],
        });
      }

      const safeQuery =
        queryText.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );

      const queryRegex =
        new RegExp(
          safeQuery,
          'i',
        );

      const products =
        await CjProduct.find(
          eligibleCjProductQuery({
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

              {
                'variants.variantName':
                  queryRegex,
              },
            ],
          }),
        )
          .sort({
            updatedAt: -1,
            importedAt: -1,
            _id: -1,
          })
          .limit(20)
          .lean();

      const mappedProducts =
        products
          .map(
            mapAdminCjProduct,
          )
          .filter(
            (product) =>
              product &&
              product.cjProductId &&
              product.enabledVariantCount >
                0,
          );

      return res.json({
        success: true,
        products:
          mappedProducts,
      });
    } catch (error) {
      console.error(
        '❌ CJ bestseller bottom banner product search error:',
        error,
      );

      return res.status(500).json({
        success: false,
        products: [],
        message:
          'Failed to search eligible CJ products.',
      });
    }
  },
);

/*
 * =====================================================
 * SAVE
 * =====================================================
 */
router.post(
  '/cj-bestseller-bottom-banners/:slot',

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
      const slot =
        String(
          req.params.slot || '',
        )
          .trim()
          .toLowerCase();

      if (
        ![
          'left',
          'right',
        ].includes(slot)
      ) {
        req.flash(
          'error',
          'Invalid CJ bestseller bottom banner slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-bottom-banners',
        );
      }

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
          '/admin/cj-bestseller-bottom-banners/' +
          slot +
          '/edit',
        );
      }

      const rawProduct =
        await findEligibleCjProduct(
          payload.cjProductId,
        );

      const product =
        mapAdminCjProduct(
          rawProduct,
        );

      if (!product) {
        req.flash(
          'error',
          'The selected CJ product was not found, is inactive, or has no enabled checkout-ready variant.',
        );

        return res.redirect(
          '/admin/cj-bestseller-bottom-banners/' +
          slot +
          '/edit',
        );
      }

      let banner =
        await CjBestsellerBottomBanner
          .findOne({
            slot,
          });

      const before =
        cjBestsellerBottomBannerSnapshot(
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
          new CjBestsellerBottomBanner({
            slot,

            ...payload,

            image: '',
          });
      } else {
        banner.cjProductId =
          payload.cjProductId;

        banner.title =
          payload.title;

        banner.subtitle =
          payload.subtitle;

        banner.priceText =
          payload.priceText;

        banner.buttonText =
          payload.buttonText;

        banner.overlayStyle =
          payload.overlayStyle;

        banner.active =
          payload.active;

        banner.sortOrder =
          payload.sortOrder;
      }

      if (req.file) {
        const oldImage =
          String(
            banner.image || '',
          ).trim();

        const newImage =
          await uploadImageToS3(
            req.file,
            'bestseller-bottom-banners/cj',
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
          '/admin/cj-bestseller-bottom-banners/' +
          slot +
          '/edit',
        );
      }

      await banner.save();

      await logAdminAction(
        req,
        {
          action:
            isCreate
              ? 'store.cj_bestseller_bottom_banner.create'
              : 'store.cj_bestseller_bottom_banner.update',

          entityType:
            'cj_bestseller_bottom_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjBestsellerBottomBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_bestseller_bottom_banners',

            department:
              'CJ',

            slot,

            cjProductId:
              payload.cjProductId,

            productName:
              product.name || '',

            uploadedImage:
              hadImageUpload,
          },
        },
      );

      req.flash(
        'success',
        (
          slot === 'left'
            ? 'Left'
            : 'Right'
        ) +
          ' CJ bestseller bottom banner saved successfully.',
      );

      return res.redirect(
        '/admin/cj-bestseller-bottom-banners',
      );
    } catch (error) {
      console.error(
        '❌ save CJ bestseller bottom banner error:',
        error,
      );

      req.flash(
        'error',
        error?.message ||
          'Failed to save the CJ bestseller bottom banner.',
      );

      return res.redirect(
        '/admin/cj-bestseller-bottom-banners',
      );
    }
  },
);

/*
 * =====================================================
 * TOGGLE
 * =====================================================
 */
router.get(
  '/cj-bestseller-bottom-banners/:slot/toggle',

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
      const slot =
        String(
          req.params.slot || '',
        )
          .trim()
          .toLowerCase();

      if (
        ![
          'left',
          'right',
        ].includes(slot)
      ) {
        req.flash(
          'error',
          'Invalid CJ bestseller bottom banner slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-bottom-banners',
        );
      }

      const banner =
        await CjBestsellerBottomBanner
          .findOne({
            slot,
          });

      if (!banner) {
        req.flash(
          'error',
          'CJ bestseller bottom banner not found for that slot.',
        );

        return res.redirect(
          '/admin/cj-bestseller-bottom-banners',
        );
      }

      const before =
        cjBestsellerBottomBannerSnapshot(
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
              ? 'store.cj_bestseller_bottom_banner.activate'
              : 'store.cj_bestseller_bottom_banner.deactivate',

          entityType:
            'cj_bestseller_bottom_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjBestsellerBottomBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_bestseller_bottom_banners',

            department:
              'CJ',

            slot,

            cjProductId:
              String(
                banner.cjProductId || '',
              ),
          },
        },
      );

      req.flash(
        'success',
        (
          slot === 'left'
            ? 'Left'
            : 'Right'
        ) +
          ' CJ bestseller bottom banner ' +
          (
            banner.active
              ? 'activated'
              : 'deactivated'
          ) +
          ' successfully.',
      );

      return res.redirect(
        '/admin/cj-bestseller-bottom-banners',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ bestseller bottom banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to toggle the CJ bestseller bottom banner.',
      );

      return res.redirect(
        '/admin/cj-bestseller-bottom-banners',
      );
    }
  },
);

/*
 * =====================================================
 * MULTER / ROUTE ERROR HANDLER
 * =====================================================
 */
router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjBestsellerBottomBanners route error:',
      error?.message ||
      error,
    );

    req.flash(
      'error',
      error?.message ||
        'Unexpected CJ bestseller bottom banner server error.',
    );

    const back =
      req.get(
        'referer',
      );

    if (back) {
      return res.redirect(
        back,
      );
    }

    return res.redirect(
      '/admin/cj-bestseller-bottom-banners',
    );
  },
);

module.exports = router;