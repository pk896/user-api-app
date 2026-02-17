// middleware/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();

  // ✅ If this is an API request, return JSON (not redirect)
  const wantsJson =
    req.path.startsWith('/api') ||
    req.originalUrl.startsWith('/api') ||
    req.xhr ||
    (req.headers.accept && req.headers.accept.includes('application/json'));

  if (wantsJson) {
    return res.status(401).json({ ok: false, message: 'Unauthorized (admin only).' });
  }

  // ✅ Normal browser page request → redirect with flash
  if (req.flash) req.flash('error', 'Please log in as admin.');
  return res.redirect('/admin/login');
};
