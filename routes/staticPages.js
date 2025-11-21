// routes/staticPages.js
const express = require('express');
const router = express.Router();

router.get('/privacy', (req, res) => {
  res.render('privacy', {
    title: 'Privacy Policy',
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

router.get('/terms', (req, res) => {
  res.render('terms', {
    title: 'Terms of Service',
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
  });
});

module.exports = router;
