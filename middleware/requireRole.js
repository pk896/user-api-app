// middleware/requireRole.js
module.exports = function requireRole(...allowed) {
  return function (req, res, next) {
    const biz = req.session && req.session.business;
    if (!biz) {
      if (req.flash) req.flash("error", "You must be logged in with a business account.");
      return res.redirect("/business/login");
    }
    const role = biz.role || biz.type || biz.userRole;
    if (!allowed.length || allowed.includes(role)) return next();

    if (req.flash) req.flash("error", `Forbidden — requires role: ${allowed.join(", ")}`);
    return res.redirect("/demands/my-demands");     // ← safe fallback
  };
};
