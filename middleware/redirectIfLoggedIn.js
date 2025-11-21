// middleware/redirectIfLoggedIn.js
// 🚦 Redirect already logged-in businesses away from login/signup

module.exports = function redirectIfLoggedIn(req, res, next) {
  const business = req.session.business;

  if (business && business.role) {
    console.log(`⚡ ${business.role} already logged in → redirecting to dashboard`);
    return res.redirect('/business/dashboard');
  }

  next();
};
