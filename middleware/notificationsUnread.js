// Attach unread count to res.locals for templates
module.exports = async function notificationsUnread(req, res, next) {
  try {
    const filter = {};
    if (req.session?.user?._id) filter.recipientUser = req.session.user._id;
    if (req.session?.business?._id) filter.recipientBusiness = req.session.business._id;

    if (!filter.recipientUser && !filter.recipientBusiness) {
      res.locals.notificationsUnreadCount = 0;
      return next();
    }

    const count = await Notification.countDocuments({ ...filter, isRead: false });
    res.locals.notificationsUnreadCount = count;
    next();
  } catch (err) {
    console.error("notificationsUnread error:", err);
    res.locals.notificationsUnreadCount = 0;
    next();
  }
};
