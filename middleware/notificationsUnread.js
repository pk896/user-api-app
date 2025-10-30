// middleware/notificationsUnread.js
const Notification = require("../models/Notification");

module.exports = async function notificationsUnread(req, res, next) {
  try {
    if (req.session && req.session.business) {
      const buyerId = req.session.business._id;
      res.locals.notificationsUnread = await Notification.countDocuments({ buyerId, readAt: null });
    } else {
      res.locals.notificationsUnread = 0;
    }
  } catch (e) {
    res.locals.notificationsUnread = 0;
  }
  next();
};
