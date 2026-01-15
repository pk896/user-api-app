// middleware/redirectIfNotLoggedIn.js
// 🚫 Redirect visitors who are not logged in as business users

module.exports = function redirectIfNotLoggedIn(req, res, next) {
  const s = req.session || {};
  const business = s.business || null;

  // ✅ accept either "business" object OR "businessId"
  const businessId = s.businessId || business?._id || business?.id;

  if (!businessId) {
    console.warn('⚠️ Unauthorized access attempt to protected route.');
    req.flash('error', 'You must be logged in as a business to access that page.');
    return res.redirect('/business/login');
  }

  // ✅ normalize so downstream code is consistent
  s.businessId = String(businessId);
  if (!s.business) s.business = { _id: s.businessId, name: 'Business' };
  if (s.business && s.business._id) s.business._id = String(s.business._id);

  return next();
};
