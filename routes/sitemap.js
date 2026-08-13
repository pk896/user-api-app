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
 * Includes:
 *
 * - main public Store pages;
 * - Internal Kasyora product pages;
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
 * - search/filter/query URLs;
 * - department query parameters;
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
      Product.find({
        customId: {
          $exists: true,
          $ne: '',
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
          '/about',
      },

      {
        location:
          siteUrl +
          '/contact',
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