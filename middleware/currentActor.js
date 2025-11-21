// middleware/currentActor.js
module.exports = function currentActor(required = true) {
  return function (req, res, next) {
    const user = req.session?.user || null;
    const biz = req.session?.business || null;

    if (!user && !biz) {
      if (!required) {return next();}
      req.flash('error', 'Please log in to rate products.');
      return res.redirect('/users/login');
    }

    if (user) {
      req.actor = { type: 'user', id: user._id, displayName: user.name || 'User' };
    } else {
      req.actor = { type: 'business', id: biz._id, displayName: biz.name || 'Business' };
    }
    next();
  };
};
