'use strict';

const express = require('express');
const router = express.Router();

function getBusinessId(req) {
  // Try common session shapes (adjust if yours differs)
  return (
    req.session?.businessId ||
    req.session?.business?._id ||
    req.session?.business?.id ||
    null
  );
}

function isUserLoggedIn(req) {
  return Boolean(req.user || req.session?.userId || req.session?.user?._id);
}

function isBusinessLoggedIn(req) {
  return Boolean(getBusinessId(req));
}

// If you already have these middleware, use them.
// Otherwise we do a safe fallback.
let requireAnyAuth = (req, res, next) => {
  if (isUserLoggedIn(req) || isBusinessLoggedIn(req)) return next();
  return res.status(401).render('login', { error: ['Please login first.'] });
};

// Views:
// - Normal users: render 'orders.ejs' (or whatever you use for buyers)
// - Sellers/business: render 'order-list.ejs' (your JS-driven page)
router.get('/', requireAnyAuth, (req, res) => {
  if (isBusinessLoggedIn(req)) {
    return res.render('order-list', {
      nonce: res.locals.nonce,
      success: req.flash?.('success') || [],
      error: req.flash?.('error') || [],
    });
  }

  // normal user orders page
  return res.render('orders', {
    nonce: res.locals.nonce,
    success: req.flash?.('success') || [],
    error: req.flash?.('error') || [],
  });
});

module.exports = router;
