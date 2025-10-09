// middleware/requireAdmin.js
module.exports = function requireAdmin(req, res, next) {
  if (!req.session.admin) {
    req.flash("error", "🔒 Admin login required.");
    return res.redirect("/admin/login");
  }
  next();
};
