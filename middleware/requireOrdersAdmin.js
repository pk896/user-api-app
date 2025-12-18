// middleware/requireOrdersAdmin.js
module.exports = function requireOrdersAdmin(req, res, next) {
  const ok =
    Boolean(req.session?.ordersAdmin) ||
    Boolean(req.session?.admin); // allow main admin too

  if (ok) return next();

  // helper safe flash
  const flash = (type, msg) => {
    try {
      if (typeof req.flash === 'function') req.flash(type, msg);
    } catch {
      // ignore
    }
  };

  // If the client wants HTML, redirect to Orders Admin login
  if (req.accepts('html')) {
    flash('error', '🔒 Orders admin login required.');
    const nextUrl = encodeURIComponent(req.originalUrl || '/admin/orders');
    return res.redirect(`/admin/orders/login?next=${nextUrl}`);
  }

  // Otherwise (API/AJAX), send 401 JSON
  return res.status(401).json({
    ok: false,
    message: 'Unauthorized (orders admin required)',
  });
};
