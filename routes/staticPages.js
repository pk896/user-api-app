// routes/staticPages.js
'use strict';

const express = require('express');

const router = express.Router();

router.get('/privacy', (req, res) => {
  res.render('privacy', {
    title: 'Privacy Policy',

    /*
     * Public Privacy Policy SEO
     * =========================
     *
     * This page uses views/layout.ejs and explicitly opts
     * into the general-layout public SEO metadata.
     */
    seoTitle:
      'Privacy Policy | Kasyora',

    seoDescription:
      'Read the Kasyora Privacy Policy to understand how Kasyora collects, uses, protects and manages personal information when you use its websites, services and commerce platform.',

    seoCanonicalPath:
      '/privacy',

    seoRobots:
      'index,follow,max-image-preview:large',

    seoOgType:
      'website',

    seoImage:
      '/images/branding/logo-unincorporate.png',

    themeCss: res.locals.themeCss,

    success: req.flash('success'),

    error: req.flash('error'),
  });
});

router.get('/terms', (req, res) => {
  res.render('terms', {
    title: 'Terms of Service',

    /*
     * Public Terms of Service SEO
     * ===========================
     *
     * This page uses views/layout.ejs and explicitly opts
     * into the general-layout public SEO metadata.
     */
    seoTitle:
      'Terms of Service | Kasyora',

    seoDescription:
      'Read the Kasyora Terms of Service governing access to and use of Kasyora websites, services, marketplace features and commerce platform.',

    seoCanonicalPath:
      '/terms',

    seoRobots:
      'index,follow,max-image-preview:large',

    seoOgType:
      'website',

    seoImage:
      '/images/branding/logo-unincorporate.png',

    themeCss: res.locals.themeCss,

    success: req.flash('success'),

    error: req.flash('error'),
  });
});

module.exports = router;
