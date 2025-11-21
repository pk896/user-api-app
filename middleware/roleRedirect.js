// middleware/roleRedirect.js
module.exports = function roleRedirect(req, res, next) {
  const isUser = !!req.user; // Passport-managed user (Google OAuth)
  const isBusiness = !!req.session.business; // Business stored in session
  const role = isBusiness ? req.session.business.role : null;

  // ✅ Skip API routes (frontend / AJAX needs them)
  if (req.path.startsWith('/api')) {
    return next();
  }

  // --------------------------
  // Business restrictions
  // --------------------------
  if (isBusiness && req.path.startsWith('/users')) {
    if (req.flash) {
      req.flash('error', '🚫 Businesses cannot access user pages.');
    }
    return res.redirect('/business/dashboard');
  }

  // --------------------------
  // User restrictions
  // --------------------------
  if (isUser && (req.path.startsWith('/business') || req.path.startsWith('/products'))) {
    if (req.flash) {
      req.flash('error', '🚫 Users cannot access business pages.');
    }
    return res.redirect('/users/dashboard');
  }

  // --------------------------
  // Buyer-specific restrictions
  // --------------------------
  if (isBusiness && role === 'buyer' && req.path.startsWith('/products')) {
    if (req.flash) {
      req.flash('error', '🚫 Buyers cannot manage products. Only sellers and suppliers can.');
    }
    return res.redirect('/business/dashboard');
  }

  // ✅ Continue if no restriction matched
  next();
};
