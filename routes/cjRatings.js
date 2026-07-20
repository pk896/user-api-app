// routes/cjRatings.js
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const {
  isValidObjectId,
} = require('mongoose');

const CjProduct = require('../models/CjProduct');
const CjRating = require('../models/CjRating');

const currentActor =
  require('../middleware/currentActor');

const {
  clampStars,
  stripHtml,
} = require('../utils/sanitize');

const {
  recalcCjProductRating,
} = require('../utils/cj/cjRatingUtils');

const router = express.Router();

/*
 * =====================================================
 * HELPERS
 * =====================================================
 */

function redirect303(res, url) {
  return res.redirect(303, url);
}

function safeString(value, maxLength = 2000) {
  return String(value ?? '')
    .trim()
    .slice(0, maxLength);
}

/*
 * Only allow redirects to local application paths.
 *
 * This prevents a form from sending a customer to an
 * external website after submitting a CJ rating.
 */
function safeLocalRedirect(
  value,
  fallback = '/store/shop?department=cj',
) {
  const raw = safeString(value, 2000);

  if (
    !raw ||
    !raw.startsWith('/') ||
    raw.startsWith('//')
  ) {
    return fallback;
  }

  return raw;
}

function backOr(req, fallback) {
  return safeLocalRedirect(
    req.get('referer'),
    fallback,
  );
}

function cjProductViewUrl(cjProductId) {
  return (
    '/cj/product/' +
    encodeURIComponent(
      safeString(cjProductId, 300),
    )
  );
}

async function getCjProductByPublicId(
  cjProductId,
) {
  const cleanId = safeString(
    cjProductId,
    300,
  );

  if (!cleanId) {
    return null;
  }

  return CjProduct.findOne({
    cjProductId: cleanId,
    status: 'active',
  })
    .select(
      '_id cjProductId name avgRating ratingsCount status',
    )
    .lean();
}

async function getCjProductUrlByObjectId(
  cjProductObjectId,
) {
  if (!cjProductObjectId) {
    return null;
  }

  const product = await CjProduct.findById(
    cjProductObjectId,
  )
    .select('cjProductId')
    .lean();

  return product?.cjProductId
    ? cjProductViewUrl(
        product.cjProductId,
      )
    : null;
}

/*
 * Read the CJ-specific guest-rating cookie.
 *
 * This does not reuse the internal guestKey cookie,
 * which keeps the rating departments isolated.
 */
function readCjGuestRatingKey(req) {
  try {
    if (
      req.cookies &&
      req.cookies.cjRatingGuestKey
    ) {
      return safeString(
        req.cookies.cjRatingGuestKey,
        200,
      );
    }

    const rawCookie =
      req.headers.cookie || '';

    const match = rawCookie.match(
      /(?:^|;\s*)cjRatingGuestKey=([^;]+)/,
    );

    if (!match) {
      return null;
    }

    return safeString(
      decodeURIComponent(match[1]),
      200,
    );
  } catch {
    return null;
  }
}

/*
 * Create the CJ-specific guest identity when needed.
 *
 * The cookie:
 * - is HttpOnly
 * - uses SameSite=Lax
 * - lasts one year
 * - uses Secure in production
 */
function getOrSetCjGuestRatingKey(
  req,
  res,
) {
  try {
    const existing =
      readCjGuestRatingKey(req);

    if (
      existing &&
      existing.length >= 16
    ) {
      return existing;
    }

    const newKey =
      crypto
        .randomBytes(24)
        .toString('hex');

    const cookieParts = [
      'cjRatingGuestKey=' +
        encodeURIComponent(newKey),

      'Path=/',

      'Max-Age=31536000',

      'SameSite=Lax',

      'HttpOnly',
    ];

    if (
      String(
        process.env.NODE_ENV || '',
      ).toLowerCase() === 'production'
    ) {
      cookieParts.push('Secure');
    }

    /*
     * append() avoids overwriting another Set-Cookie
     * header that may already exist on the response.
     */
    res.append(
      'Set-Cookie',
      cookieParts.join('; '),
    );

    return newKey;
  } catch {
    return null;
  }
}

function actorOwnsRating(
  actor,
  rating,
) {
  if (!actor || !rating) {
    return false;
  }

  if (
    actor.type === 'user' &&
    rating.raterType === 'user'
  ) {
    return (
      String(rating.raterUser || '') ===
      String(actor.id || '')
    );
  }

  if (
    actor.type === 'business' &&
    rating.raterType === 'business'
  ) {
    return (
      String(
        rating.raterBusiness || '',
      ) ===
      String(actor.id || '')
    );
  }

  return false;
}

/*
 * =====================================================
 * WRITE RATE LIMITER
 * =====================================================
 */

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,

  max:
    String(
      process.env.NODE_ENV || '',
    ).toLowerCase() === 'production'
      ? 10
      : 100,

  standardHeaders: true,

  legacyHeaders: false,

  handler: (req, res) => {
    req.flash(
      'error',
      'Too many rating requests. Please wait a moment and try again.',
    );

    return redirect303(
      res,
      backOr(
        req,
        '/store/shop?department=cj',
      ),
    );
  },
});

/*
 * =====================================================
 * PUBLIC RATINGS API
 * =====================================================
 *
 * GET
 * /cj-ratings/api/products/:cjProductId/ratings
 *
 * Optional query:
 * ?page=1
 * ?limit=10
 * ?fresh=1
 */

router.get(
  '/api/products/:cjProductId/ratings',
  async (req, res) => {
    try {
      const product =
        await getCjProductByPublicId(
          req.params.cjProductId,
        );

      if (!product) {
        return res.status(404).json({
          ok: false,
          error:
            'CJ product not found',
        });
      }

      const page = Math.max(
        1,
        parseInt(
          req.query.page || '1',
          10,
        ) || 1,
      );

      const limit = Math.min(
        50,
        Math.max(
          1,
          parseInt(
            req.query.limit || '10',
            10,
          ) || 10,
        ),
      );

      const query = {
        cjProduct: product._id,
        status: 'published',
      };

      const [items, total] =
        await Promise.all([
          CjRating.find(query)
            .select(
              '_id stars title body raterType createdAt updatedAt',
            )
            .sort({
              createdAt: -1,
              _id: -1,
            })
            .skip(
              (page - 1) * limit,
            )
            .limit(limit)
            .lean(),

          CjRating.countDocuments(
            query,
          ),
        ]);

      let avgRating = Number(
        product.avgRating || 0,
      );

      let ratingsCount = Number(
        product.ratingsCount || 0,
      );

      /*
       * fresh=1 repairs and returns a live aggregate.
       */
      if (
        String(req.query.fresh) === '1'
      ) {
        const fresh =
          await recalcCjProductRating(
            product._id,
          );

        avgRating =
          fresh.avgRating;

        ratingsCount =
          fresh.ratingsCount;
      }

      return res.json({
        ok: true,

        product: {
          id: product.cjProductId,

          avgRating,

          ratingsCount,
        },

        page,

        limit,

        total,

        totalPages: Math.max(
          1,
          Math.ceil(total / limit),
        ),

        items,
      });
    } catch (error) {
      console.error(
        '[CJ ratings] List error:',
        error,
      );

      return res.status(400).json({
        ok: false,
        error: 'Invalid request',
      });
    }
  },
);

/*
 * =====================================================
 * CREATE OR UPDATE A CJ RATING
 * =====================================================
 *
 * POST
 * /cj-ratings/ratings/submit/:cjProductId
 *
 * One rating per actor per CJ product:
 * - user
 * - business
 * - guest cookie
 */

router.post(
  '/ratings/submit/:cjProductId',
  writeLimiter,
  currentActor(false),
  async (req, res) => {
    const safeProductUrl =
      cjProductViewUrl(
        req.params.cjProductId,
      );

    try {
      const product =
        await getCjProductByPublicId(
          req.params.cjProductId,
        );

      if (!product) {
        req.flash(
          'error',
          'CJ product not found.',
        );

        return redirect303(
          res,
          '/store/shop?department=cj',
        );
      }

      const fallbackUrl =
        safeLocalRedirect(
          req.body.redirect,
          cjProductViewUrl(
            product.cjProductId,
          ),
        );

      const stars = clampStars(
        req.body.stars,
      );

      if (!stars) {
        req.flash(
          'error',
          'Please choose a rating between 1 and 5 stars.',
        );

        return redirect303(
          res,
          fallbackUrl,
        );
      }

      const isAuthenticatedActor =
        Boolean(
          req.actor &&
            req.actor.type &&
            req.actor.id,
        );

      const raterType =
        isAuthenticatedActor
          ? req.actor.type
          : 'guest';

      let guestKey = null;

      if (!isAuthenticatedActor) {
        guestKey =
          getOrSetCjGuestRatingKey(
            req,
            res,
          );

        if (
          !guestKey ||
          guestKey.length < 16
        ) {
          req.flash(
            'error',
            'Your browser did not accept the review cookie. Please enable cookies and try again.',
          );

          return redirect303(
            res,
            fallbackUrl,
          );
        }
      }

      /*
       * The identity query is strict.
       *
       * Undefined actor fields are never included.
       */
      let identityQuery;

      if (raterType === 'user') {
        identityQuery = {
          cjProduct: product._id,

          raterType: 'user',

          raterUser:
            req.actor.id,
        };
      } else if (
        raterType === 'business'
      ) {
        identityQuery = {
          cjProduct: product._id,

          raterType:
            'business',

          raterBusiness:
            req.actor.id,
        };
      } else {
        identityQuery = {
          cjProduct: product._id,

          raterType: 'guest',

          guestKey,
        };
      }

      const payload = {
        cjProduct:
          product._id,

        cjProductId:
          product.cjProductId,

        raterType,

        raterUser:
          raterType === 'user'
            ? req.actor.id
            : null,

        raterBusiness:
          raterType === 'business'
            ? req.actor.id
            : null,

        guestKey:
          raterType === 'guest'
            ? guestKey
            : null,

        stars,

        title: stripHtml(
          req.body.title || '',
        ).slice(0, 120),

        body: stripHtml(
          req.body.body || '',
        ).slice(0, 2000),

        /*
         * Submitting again restores an actor's
         * own previously flagged rating.
         */
        status: 'published',

        flaggedByType: null,

        flaggedByUser: null,

        flaggedByBusiness: null,

        flaggedAt: null,
      };

      await CjRating.updateOne(
        identityQuery,
        {
          $set: payload,
        },
        {
          upsert: true,
          runValidators: true,
        },
      );

      await recalcCjProductRating(
        product._id,
      );

      req.flash(
        'success',
        'Thanks! Your CJ product rating has been saved.',
      );

      return redirect303(
        res,
        fallbackUrl,
      );
    } catch (error) {
      console.error(
        '[CJ ratings] Upsert error:',
        error,
      );

      req.flash(
        'error',
        'Could not save your CJ product rating. Please try again.',
      );

      return redirect303(
        res,
        safeProductUrl,
      );
    }
  },
);

/*
 * =====================================================
 * FLAG A CJ RATING
 * =====================================================
 *
 * POST
 * /cj-ratings/ratings/:ratingId/flag
 *
 * A logged-in user or business may report a review.
 * Once flagged, it no longer contributes to the public
 * average or review count.
 */

router.post(
  '/ratings/:ratingId/flag',
  writeLimiter,
  currentActor(true),
  async (req, res) => {
    try {
      const ratingId =
        req.params.ratingId;

      if (
        !isValidObjectId(
          ratingId,
        )
      ) {
        req.flash(
          'error',
          'Invalid CJ rating id.',
        );

        return redirect303(
          res,
          backOr(
            req,
            '/store/shop?department=cj',
          ),
        );
      }

      const rating =
        await CjRating.findById(
          ratingId,
        );

      if (!rating) {
        req.flash(
          'error',
          'CJ rating not found.',
        );

        return redirect303(
          res,
          backOr(
            req,
            '/store/shop?department=cj',
          ),
        );
      }

      if (
        actorOwnsRating(
          req.actor,
          rating,
        )
      ) {
        req.flash(
          'error',
          'You cannot report your own rating. You can update or delete it instead.',
        );

        const productUrl =
          await getCjProductUrlByObjectId(
            rating.cjProduct,
          );

        return redirect303(
          res,
          backOr(
            req,
            productUrl ||
              '/store/shop?department=cj',
          ),
        );
      }

      /*
       * Do not reveal whether another customer
       * already flagged this review.
       */
      await CjRating.updateOne(
        {
          _id: rating._id,
        },
        {
          $set: {
            status: 'flagged',

            flaggedByType:
              req.actor.type,

            flaggedByUser:
              req.actor.type ===
              'user'
                ? req.actor.id
                : null,

            flaggedByBusiness:
              req.actor.type ===
              'business'
                ? req.actor.id
                : null,

            flaggedAt:
              new Date(),
          },
        },
        {
          runValidators: true,
        },
      );

      await recalcCjProductRating(
        rating.cjProduct,
      );

      const productUrl =
        await getCjProductUrlByObjectId(
          rating.cjProduct,
        );

      req.flash(
        'success',
        'Thanks for reporting this CJ rating. It has been removed from the public rating while it is reviewed.',
      );

      return redirect303(
        res,
        backOr(
          req,
          productUrl ||
            '/store/shop?department=cj',
        ),
      );
    } catch (error) {
      console.error(
        '[CJ ratings] Flag error:',
        error,
      );

      req.flash(
        'error',
        'Could not report the CJ rating.',
      );

      return redirect303(
        res,
        backOr(
          req,
          '/store/shop?department=cj',
        ),
      );
    }
  },
);

/*
 * =====================================================
 * DELETE AN OWN CJ RATING
 * =====================================================
 *
 * POST
 * /cj-ratings/ratings/:ratingId/delete
 *
 * This route matches your current internal behavior:
 * only a logged-in user or business may delete their
 * own rating.
 *
 * Guest ratings can still be updated using the same
 * guest browser cookie.
 */

router.post(
  '/ratings/:ratingId/delete',
  writeLimiter,
  currentActor(true),
  async (req, res) => {
    try {
      const ratingId =
        req.params.ratingId;

      if (
        !isValidObjectId(
          ratingId,
        )
      ) {
        req.flash(
          'error',
          'Invalid CJ rating id.',
        );

        return redirect303(
          res,
          backOr(
            req,
            '/store/shop?department=cj',
          ),
        );
      }

      const rating =
        await CjRating.findById(
          ratingId,
        );

      if (!rating) {
        req.flash(
          'error',
          'CJ rating not found.',
        );

        return redirect303(
          res,
          backOr(
            req,
            '/store/shop?department=cj',
          ),
        );
      }

      const productUrl =
        await getCjProductUrlByObjectId(
          rating.cjProduct,
        );

      if (
        !actorOwnsRating(
          req.actor,
          rating,
        )
      ) {
        req.flash(
          'error',
          'You can only delete your own CJ rating.',
        );

        return redirect303(
          res,
          backOr(
            req,
            productUrl ||
              '/store/shop?department=cj',
          ),
        );
      }

      const productObjectId =
        rating.cjProduct;

      await rating.deleteOne();

      await recalcCjProductRating(
        productObjectId,
      );

      req.flash(
        'success',
        'Your CJ product rating was deleted.',
      );

      return redirect303(
        res,
        backOr(
          req,
          productUrl ||
            '/store/shop?department=cj',
        ),
      );
    } catch (error) {
      console.error(
        '[CJ ratings] Delete error:',
        error,
      );

      req.flash(
        'error',
        'Could not delete the CJ rating.',
      );

      return redirect303(
        res,
        backOr(
          req,
          '/store/shop?department=cj',
        ),
      );
    }
  },
);

/*
 * Simple route-mount test.
 *
 * Remove later after the CJ rating flow has been
 * tested successfully.
 */
router.get('/_ping', (req, res) => {
  return res.status(200).json({
    ok: true,

    hit: 'cjRatings',

    path: req.originalUrl,

    time:
      new Date().toISOString(),
  });
});

module.exports = router;
