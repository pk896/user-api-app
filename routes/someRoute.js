// routes/someRoute.js
'use strict';
const express = require('express');
const { validationResult } = require('express-validator');
const { urlField } = require('../middleware/validators');
const router = express.Router();

router.post(
  '/submit-link',
  [
    urlField('link', { requirePublicIP: true }), // generic safe
    // or: urlField("imageUrl", { restrictToHosts: ["yourcdn.example.com"] }),
  ],
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash(
        'error',
        errors
          .array()
          .map((e) => e.msg)
          .join(', '),
      );
      return res.redirect('back');
    }
    // ... proceed safely
    res.send('ok');
  },
);

module.exports = router;
