// middleware/redirectIfNotLoggedIn.js
// 🚫 Redirect visitors who are not logged in as business users

module.exports = function redirectIfNotLoggedIn(req, res, next) {
  const business = req.session.business;

  if (!business || !business._id) {
    console.warn("⚠️  Unauthorized access attempt to protected route.");
    req.flash("error", "You must be logged in as a business to access that page.");
    return res.redirect("/business/login");
  }

  // ✅ If business is logged in, continue to route handler
  next();
};
