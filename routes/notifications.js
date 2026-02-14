'use strict';
const express = require('express');
const router = express.Router();
const Notification = require('../models/Notification');

// Helper: build recipient filter from session
function getRecipientFilter(req) {
  const f = {};
  if (req.session?.user?._id) {f.recipientUser = req.session.user._id;}
  if (req.session?.business?._id) {f.recipientBusiness = req.session.business._id;}
  return f;
}

// LIST (page)
router.get('/', async (req, res) => {
  try {
    const filter = getRecipientFilter(req);
    if (!filter.recipientUser && !filter.recipientBusiness) {
      req.flash('error', 'Sign in to view notifications.');
      return res.redirect('/users/login');
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = 20;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
    ]);

    const pages = Math.max(1, Math.ceil(total / limit));
    const theme = req.session.theme || 'light';
    const themeCss = theme === 'dark' ? '/css/dark.css' : '/css/light.css';
    const nonce = res.locals.nonce || '';

    return res.render('notifications/index', {
      title: 'Notifications',
      active: 'notifications',
      themeCss,
      nonce,
      notifications: rows,
      page,
      pages,
      total,
      success: req.flash('success'),
      error: req.flash('error'),
    });
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to load notifications.');
    return res.redirect('/');
  }
});

// MARK ONE READ
router.post('/:id/read', async (req, res) => {
  try {
    const filter = { _id: req.params.id, ...getRecipientFilter(req) };
    const doc = await Notification.findOne(filter);
    if (!doc) {return res.status(404).json({ ok: false, message: 'Not found' });}
    if (!doc.isRead) {
      doc.isRead = true;
      doc.readAt = new Date();
      await doc.save();
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, message: 'Server error' });
  }
});

// MARK ALL READ
router.post('/read-all', async (req, res) => {
  try {
    const filter = getRecipientFilter(req);
    if (!filter.recipientUser && !filter.recipientBusiness) {
      return res.status(401).json({ ok: false, message: 'Unauthorized' });
    }
    await Notification.updateMany(
      { ...filter, isRead: false },
      { $set: { isRead: true, readAt: new Date() } },
    );
    req.flash('success', 'All notifications marked as read.');
    return res.redirect('/notifications');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to mark all as read.');
    return res.redirect('/notifications');
  }
});

// UNREAD COUNT (API for badge refresh)
router.get('/api/unread-count', async (req, res) => {
  try {
    const filter = getRecipientFilter(req);
    if (!filter.recipientUser && !filter.recipientBusiness) {return res.json({ count: 0 });}
    const count = await Notification.countDocuments({ ...filter, isRead: false });
    return res.json({ count });
  } catch (err) {
    console.error(err);
    return res.json({ count: 0 });
  }
});

// DELETE ONE (optional)
router.post('/:id/delete', async (req, res) => {
  try {
    const filter = { _id: req.params.id, ...getRecipientFilter(req) };
    const deleted = await Notification.findOneAndDelete(filter);
    if (!deleted) {
      req.flash('error', 'Notification not found.');
    } else {
      req.flash('success', 'Notification deleted.');
    }
    return res.redirect('/notifications');
  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed to delete notification.');
    return res.redirect('/notifications');
  }
});

module.exports = router;
