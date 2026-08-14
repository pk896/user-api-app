// routes/sitemap.js
'use strict';

const express = require('express');

const Product = require('../models/Product');
const CjProduct = require('../models/CjProduct');

const router = express.Router();

function getSiteUrl() {
  return String(
    process.env.APP_URL ||
      process.env.PUBLIC_BASE_URL ||
      'https://kasyora.com',
  )
    .trim()
    .replace(/\/+$/, '');
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function safeLastModified(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString();
}

function sitemapUrlEntry({
  location,
  lastModified = '',
}) {
  const safeLocation =
    escapeXml(location);

  const safeLastModifiedValue =
    safeLastModified(lastModified);

  return [
    '  <url>',
    `    <loc>${safeLocation}</loc>`,
    ...(safeLastModifiedValue
      ? [
          `    <lastmod>${escapeXml(
            safeLastModifiedValue,
          )}</lastmod>`,
        ]
      : []),
    '  </url>',
  ].join('\n');
}

/*
 * Public Kasyora sitemap
 * ======================
 *
 * Includes only public canonical pages that Kasyora intends
 * search engines to discover and index.
 *
 * Includes:
 *
 * - public Kasyora company/legal pages;
 * - main public Store pages;
 * - Internal and CJ Fast Liner landing pages;
 * - in-stock Internal Kasyora product pages;
 * - active CJ product pages with enabled variants.
 *
 * Excludes:
 *
 * - carts;
 * - checkout;
 * - payment;
 * - dashboards;
 * - admin;
 * - authentication;
 * - search/filter URLs;
 * - pagination URLs;
 * - non-canonical department variants;
 * - product share URLs.
 */
router.get('/sitemap.xml', async (_req, res) => {
  try {
    const siteUrl =
      getSiteUrl();

    const [
      internalProducts,
      cjProducts,
    ] = await Promise.all([
      /*
       * Internal public product route:
       *
       * /store/product/:id
       *
       * The live product page requires stock > 0, so the
       * sitemap must not advertise out-of-stock product URLs
       * that would redirect away from the product page.
       */
      Product.find({
        customId: {
          $exists: true,
          $ne: '',
        },

        stock: {
          $gt: 0,
        },
      })
        .select(
          'customId updatedAt',
        )
        .sort({
          updatedAt: -1,
          _id: -1,
        })
        .lean(),

      /*
       * CJ product URLs remain completely separate from
       * Internal Kasyora product URLs.
       *
       * Only active CJ products with at least one enabled
       * variant are included.
       */
      CjProduct.find({
        status: 'active',

        cjProductId: {
          $exists: true,
          $ne: '',
        },

        variants: {
          $elemMatch: {
            isEnabled: true,
          },
        },
      })
        .select(
          'cjProductId updatedAt',
        )
        .sort({
          updatedAt: -1,
          _id: -1,
        })
        .lean(),
    ]);

    /*
     * Public canonical landing pages.
     *
     * Do not add cart, checkout, account, dashboard,
     * authentication or search-result URLs here.
     */
    const staticEntries = [
      {
        location:
          siteUrl +
          '/store',
      },

      {
        location:
          siteUrl +
          '/store/shop',
      },

      {
        location:
          siteUrl +
          '/store/bestseller',
      },

      {
        location:
          siteUrl +
          '/products/sales',
      },

      {
        location:
          siteUrl +
          '/products/sales?department=cj',
      },

      {
        location:
          siteUrl +
          '/home',
      },

      {
        location:
          siteUrl +
          '/users/about',
      },

      {
        location:
          siteUrl +
          '/store/contact',
      },

      {
        location:
          siteUrl +
          '/privacy',
      },

      {
        location:
          siteUrl +
          '/terms',
      },
    ];

    const internalEntries =
      internalProducts
        .map((product) => {
          const customId =
            String(
              product?.customId ||
                '',
            ).trim();

          if (!customId) {
            return null;
          }

          return {
            location:
              siteUrl +
              '/store/product/' +
              encodeURIComponent(
                customId,
              ),

            lastModified:
              product.updatedAt,
          };
        })
        .filter(Boolean);

    const cjEntries =
      cjProducts
        .map((product) => {
          const cjProductId =
            String(
              product?.cjProductId ||
                '',
            ).trim();

          if (!cjProductId) {
            return null;
          }

          return {
            location:
              siteUrl +
              '/cj/product/' +
              encodeURIComponent(
                cjProductId,
              ),

            lastModified:
              product.updatedAt,
          };
        })
        .filter(Boolean);

    const allEntries = [
      ...staticEntries,
      ...internalEntries,
      ...cjEntries,
    ];

    const sitemapXml = [
      '<?xml version="1.0" encoding="UTF-8"?>',

      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',

      ...allEntries.map(
        sitemapUrlEntry,
      ),

      '</urlset>',
      '',
    ].join('\n');

    res.set(
      'Content-Type',
      'application/xml; charset=utf-8',
    );

    res.set(
      'Cache-Control',
      'public, max-age=300',
    );

    return res
      .status(200)
      .send(sitemapXml);
  } catch (error) {
    console.error(
      '[sitemap] Failed to generate sitemap:',
      error,
    );

    return res
      .status(500)
      .type('text/plain')
      .send(
        'Sitemap temporarily unavailable.',
      );
  }
});

module.exports = router;