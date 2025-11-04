// middleware/requireGuest.js
module.exports = function requireGuest(req, res, next) {
  if (req.session?.user) {
    req.flash("success", "You’re already logged in.");
    return res.redirect("/users/dashboard");
  }
  return next();
};
