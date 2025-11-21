// middleware/requireOrdersAdmin.js
module.exports = function requireOrdersAdmin(req, res, next) {
  if (req.session && req.session.ordersAdmin) {return next();}

  // If the client wants HTML, redirect to Orders Admin login
  if (req.accepts('html')) {
    req.flash('error', '🔒 Orders admin login required.');
    return res.redirect('/admin/orders/login');
  }

  // Otherwise (API/AJAX), send 401 JSON
  return res.status(401).json({ ok: false, message: 'Unauthorized' });
};
