// middleware/requireUser.js
module.exports = function requireUser(req, res, next) {
  if (req.session && req.session.user) return next();

  // helpful debug (remove later)
  console.log("[requireUser] blocked:", {
    hasUser: !!req.session?.user,
    hasBusiness: !!req.session?.business,
    url: req.originalUrl
  });

  req.flash("error", "Please log in with a user account.");
  // optional 'next' param so we can send them back after login
  const nextUrl = encodeURIComponent(req.originalUrl || "/users/dashboard");
  return res.redirect(`/users/login?next=${nextUrl}`);
};
