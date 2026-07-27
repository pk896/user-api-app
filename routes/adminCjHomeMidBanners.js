// routes/adminCjHomeMidBanners.js
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

const CjHomeMidBanner = require('../models/CjHomeMidBanner');
const CjProduct = require('../models/CjProduct');

const AWS_REGION =
  process.env.AWS_REGION ||
  'us-east-1';

const BUCKET =
  process.env.AWS_BUCKET_NAME;

if (!BUCKET) {
  console.warn(
    '⚠️ AWS_BUCKET_NAME missing — CJ home mid banner uploads will fail.',
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
    cb,
  ) => {
    const allowed =
      /^image\/(png|jpe?g|webp|gif|bmp)$/.test(
        file.mimetype,
      );

    if (!allowed) {
      return cb(
        new Error(
          'Only PNG/JPG/WEBP/GIF/BMP images are allowed',
        ),
      );
    }

    return cb(
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
  const filename =
    String(name || '');

  const dot =
    filename.lastIndexOf('.');

  return dot === -1
    ? 'bin'
    : filename.substring(
        dot + 1,
      );
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

function themeCssFromSession(req) {
  const theme =
    req.session?.theme ||
    'light';

  return theme === 'dark'
    ? '/css/dark.css'
    : '/css/light.css';
}

function normalizePayload(body) {
  return {
    cjProductId:
      String(
        body.cjProductId || '',
      ).trim(),

    title:
      String(
        body.title || '',
      ).trim(),

    subtitle:
      String(
        body.subtitle || '',
      ).trim(),

    priceText:
      String(
        body.priceText || '',
      ).trim(),

    buttonText:
      String(
        body.buttonText || '',
      ).trim() ||
      'Shop Now',

    active:
      String(
        body.active || '',
      ) === 'on',

    sortOrder:
      Number(
        body.sortOrder || 0,
      ),
  };
}

function cjMidBannerSnapshot(
  banner,
) {
  if (!banner) {
    return null;
  }

  return {
    slot:
      String(
        banner.slot || '',
      ).trim(),

    cjProductId:
      String(
        banner.cjProductId || '',
      ).trim(),

    title:
      String(
        banner.title || '',
      ).trim(),

    subtitle:
      String(
        banner.subtitle || '',
      ).trim(),

    priceText:
      String(
        banner.priceText || '',
      ).trim(),

    buttonText:
      String(
        banner.buttonText || '',
      ).trim(),

    image:
      String(
        banner.image || '',
      ).trim(),

    active:
      banner.active === true,

    sortOrder:
      Number(
        banner.sortOrder || 0,
      ),
  };
}

async function uploadImageToS3(
  file,
  folder,
) {
  const {
    originalname,
    buffer,
    mimetype,
  } = file;

  const extension =
    extFromFilename(
      originalname,
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
        buffer,

      ContentType:
        mimetype,
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
    const safeUrl =
      String(
        imageUrl || '',
      ).trim();

    if (
      !safeUrl ||
      !safeUrl.includes('.com/')
    ) {
      return;
    }

    const oldKey =
      safeUrl.split(
        '.com/',
      )[1];

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
      '⚠️ Failed to delete old CJ mid banner S3 image:',
      error.message,
    );
  }
}

/*
 * Validate that a CJ product is still publicly usable.
 *
 * The product must:
 *
 * - be active
 * - match cjProductId
 * - have at least one enabled variant
 * - have a CJ variant ID
 * - have a CJ variant SKU
 * - have a valid selling price excluding VAT
 */
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

  return CjProduct.findOne({
    status:
      'active',

    cjProductId:
      safeCjProductId,

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
  })
    .select(
      [
        'cjProductId',
        'productSku',
        'name',
        'mainImageUrl',
        'category',
        'productType',
        'status',
        'variants',
        'pricing',
      ].join(' '),
    )
    .lean();
}

/*
 * ADMIN DASHBOARD
 */
router.get(
  '/cj-home-mid-banners',

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
      const banners =
        await CjHomeMidBanner.find({})
          .sort({
            sortOrder:
              1,

            createdAt:
              1,
          })
          .lean();

      const bannersWithProducts =
        await Promise.all(
          banners.map(
            async (
              banner,
            ) => {
              const product =
                banner.cjProductId
                  ? await findEligibleCjProduct(
                      banner.cjProductId,
                    )
                  : null;

              return {
                ...banner,

                product,
              };
            },
          ),
        );

      return res.render(
        'admin/cj-home-mid-banners/index',
        {
          title:
            'CJ Homepage Mid Banners',

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
        '❌ admin CJ home mid banners index error:',
        error,
      );

      req.flash(
        'error',
        'Could not load CJ homepage mid banners.',
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
  '/cj-home-mid-banners/:slot/edit',

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
        ].includes(
          slot,
        )
      ) {
        req.flash(
          'error',
          'Invalid CJ banner slot.',
        );

        return res.redirect(
          '/admin/cj-home-mid-banners',
        );
      }

      const bannerRaw =
        await CjHomeMidBanner.findOne({
          slot,
        }).lean();

      let selectedProduct =
        null;

      let banner =
        bannerRaw;

      if (
        bannerRaw?.cjProductId
      ) {
        selectedProduct =
          await findEligibleCjProduct(
            bannerRaw.cjProductId,
          );

        banner = {
          ...bannerRaw,

          product:
            selectedProduct ||
            null,
        };
      }

      return res.render(
        'admin/cj-home-mid-banners/edit',
        {
          title:
            'Edit ' +
            (
              slot === 'left'
                ? 'Left'
                : 'Right'
            ) +
            ' CJ Mid Banner',

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
        '❌ CJ home mid banner edit page error:',
        error,
      );

      req.flash(
        'error',
        'Could not load the CJ home mid banner.',
      );

      return res.redirect(
        '/admin/cj-home-mid-banners',
      );
    }
  },
);

/*
 * SEARCH CJ PRODUCTS
 */
router.get(
  '/cj-home-mid-banners/products/search',

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
          req.query.q || '',
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

      const products =
        await CjProduct.find({
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
        })
          .select(
            [
              'cjProductId',
              'productSku',
              'name',
              'mainImageUrl',
              'category',
              'productType',
              'status',
              'variants',
              'pricing',
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
          .limit(
            20,
          )
          .lean();

      const mappedProducts =
        products.map(
          (
            product,
          ) => {
            const enabledVariants =
              Array.isArray(
                product.variants,
              )
                ? product.variants.filter(
                    (
                      variant,
                    ) =>
                      variant?.isEnabled ===
                      true &&
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
                          variant
                            ?.sellingPriceExVat
                            ?.value,
                        ),
                      ),
                  )
                : [];

            const prices =
              enabledVariants
                .map(
                  (
                    variant,
                  ) =>
                    Number(
                      variant
                        ?.sellingPriceExVat
                        ?.value,
                    ),
                )
                .filter(
                  (
                    value,
                  ) =>
                    Number.isFinite(
                      value,
                    ) &&
                    value >= 0,
                );

            const lowestPrice =
              prices.length > 0
                ? Math.min(
                    ...prices,
                  )
                : 0;

            return {
              cjProductId:
                String(
                  product.cjProductId ||
                    '',
                ).trim(),

              productSku:
                String(
                  product.productSku ||
                    '',
                ).trim(),

              name:
                String(
                  product.name ||
                    'CJ Product',
                ).trim(),

              imageUrl:
                String(
                  enabledVariants[0]
                    ?.imageUrl ||
                    product.mainImageUrl ||
                    '',
                ).trim(),

              category:
                String(
                  product.category
                    ?.name ||
                    product.category
                      ?.secondName ||
                    product.category
                      ?.firstName ||
                    product.productType ||
                    'CJ Product',
                ).trim(),

              price:
                Number(
                  lowestPrice.toFixed(
                    2,
                  ),
                ),

              enabledVariantCount:
                enabledVariants.length,
            };
          },
        )
          .filter(
            (
              product,
            ) =>
              product.cjProductId &&
              product.enabledVariantCount >
                0,
          );

      return res.json({
        success:
          true,

        products:
          mappedProducts,
      });
    } catch (error) {
      console.error(
        '❌ CJ home mid banners product search error:',
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
 * SAVE LEFT OR RIGHT CJ BANNER
 */
router.post(
  '/cj-home-mid-banners/:slot',

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
    const slot =
      String(
        req.params.slot || '',
      )
        .trim()
        .toLowerCase();

    try {
      if (
        ![
          'left',
          'right',
        ].includes(
          slot,
        )
      ) {
        req.flash(
          'error',
          'Invalid CJ banner slot.',
        );

        return res.redirect(
          '/admin/cj-home-mid-banners',
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
          '/admin/cj-home-mid-banners/' +
            slot +
            '/edit',
        );
      }

      const product =
        await findEligibleCjProduct(
          payload.cjProductId,
        );

      if (!product) {
        req.flash(
          'error',
          'Selected CJ product was not found, is inactive, or has no usable variant.',
        );

        return res.redirect(
          '/admin/cj-home-mid-banners/' +
            slot +
            '/edit',
        );
      }

      let banner =
        await CjHomeMidBanner.findOne({
          slot,
        });

      const before =
        cjMidBannerSnapshot(
          banner,
        );

      const isCreate =
        !banner;

      const hadImageUpload =
        Boolean(
          req.file,
        );

      if (!banner) {
        if (!req.file) {
          req.flash(
            'error',
            'CJ banner image is required.',
          );

          return res.redirect(
            '/admin/cj-home-mid-banners/' +
              slot +
              '/edit',
          );
        }

        const image =
          await uploadImageToS3(
            req.file,
            'homepage-banners/cj-mid-banners',
          );

        banner =
          new CjHomeMidBanner({
            slot,

            ...payload,

            image,
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

        banner.active =
          payload.active;

        banner.sortOrder =
          payload.sortOrder;

        if (req.file) {
          const oldImage =
            banner.image;

          const newImage =
            await uploadImageToS3(
              req.file,
              'homepage-banners/cj-mid-banners',
            );

          await deleteS3ImageByUrl(
            oldImage,
          );

          banner.image =
            newImage;
        }
      }

      await banner.save();

      await logAdminAction(
        req,
        {
          action:
            isCreate
              ? 'store.cj_home_mid_banner.create'
              : 'store.cj_home_mid_banner.update',

          entityType:
            'cj_home_mid_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjMidBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_home_mid_banners',

            department:
              'CJ',

            slot,

            cjProductId:
              payload.cjProductId,

            productName:
              String(
                product.name || '',
              ).trim(),

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
          ' CJ mid banner saved successfully.',
      );

      return res.redirect(
        '/admin/cj-home-mid-banners',
      );
    } catch (error) {
      console.error(
        '❌ save CJ home mid banner error:',
        error,
      );

      req.flash(
        'error',
        error.message ||
          'Failed to save the CJ home mid banner.',
      );

      return res.redirect(
        '/admin/cj-home-mid-banners/' +
          (
            [
              'left',
              'right',
            ].includes(
              slot,
            )
              ? slot
              : 'left'
          ) +
          '/edit',
      );
    }
  },
);

/*
 * ACTIVATE OR DEACTIVATE A CJ BANNER
 */
router.get(
  '/cj-home-mid-banners/:slot/toggle',

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
        ].includes(
          slot,
        )
      ) {
        req.flash(
          'error',
          'Invalid CJ banner slot.',
        );

        return res.redirect(
          '/admin/cj-home-mid-banners',
        );
      }

      const banner =
        await CjHomeMidBanner.findOne({
          slot,
        });

      if (!banner) {
        req.flash(
          'error',
          'CJ banner was not found for that slot.',
        );

        return res.redirect(
          '/admin/cj-home-mid-banners',
        );
      }

      const before =
        cjMidBannerSnapshot(
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
              ? 'store.cj_home_mid_banner.activate'
              : 'store.cj_home_mid_banner.deactivate',

          entityType:
            'cj_home_mid_banner',

          entityId:
            String(
              banner._id,
            ),

          status:
            'success',

          before,

          after:
            cjMidBannerSnapshot(
              banner,
            ),

          meta: {
            section:
              'cj_home_mid_banners',

            department:
              'CJ',

            slot,
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
          ' CJ mid banner ' +
          (
            banner.active
              ? 'activated'
              : 'deactivated'
          ) +
          ' successfully.',
      );

      return res.redirect(
        '/admin/cj-home-mid-banners',
      );
    } catch (error) {
      console.error(
        '❌ toggle CJ home mid banner error:',
        error,
      );

      req.flash(
        'error',
        'Failed to update the CJ banner status.',
      );

      return res.redirect(
        '/admin/cj-home-mid-banners',
      );
    }
  },
);

/*
 * ROUTE ERROR HANDLER
 */
router.use(
  (
    error,
    req,
    res,
    _next,
  ) => {
    console.error(
      '❌ adminCjHomeMidBanners route error:',
      error.message,
    );

    req.flash(
      'error',
      error.message ||
        'Unexpected CJ home mid banner server error.',
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
      '/admin/cj-home-mid-banners',
    );
  },
);

module.exports =
  router;