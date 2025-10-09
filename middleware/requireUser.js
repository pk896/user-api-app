// ===========================================
// 🧭 middleware/requireUser.js
// -------------------------------------------
// Ensures only logged-in users (not businesses) 
// can access user-specific pages like dashboard, 
// orders, or wishlist.
// ===========================================
module.exports = function requireUser(req, res, next) {
  try {
    // 🧩 Check if user session exists
    if (!req.session.user && !req.user) {
      req.flash("error", "❌ You must be logged in as a user to continue.");
      return res.redirect("/users/login");
    }

    // ✅ Make user data easily accessible in views
    res.locals.user = req.session.user || req.user;
    next();
  } catch (err) {
    console.error("❌ requireUser middleware error:", err);
    req.flash("error", "Unexpected error. Please log in again.");
    return res.redirect("/users/login");
  }
};
