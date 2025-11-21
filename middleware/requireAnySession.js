// middleware/requireAnySession.js
module.exports = function requireAnySession(req, res, next) {
  if (req.session?.user || req.session?.business) {return next();}
  req.flash('error', 'Please log in to use the wishlist.');
  return res.redirect('/users/login');
};
