module.exports = function requireRole(...allowed) {
  return function (req, res, next) {
    const b = req.session && req.session.business;
    if (!b) {
      req.flash('error', 'You must be logged in with a business account.');
      return res.redirect('/business/login');
    }
    if (!Array.isArray(allowed) || allowed.length === 0) {return next();}
    if (allowed.includes(b.role)) {return next();}

    req.flash('error', 'Access denied (role).');
    return res.redirect('/');
  };
};
