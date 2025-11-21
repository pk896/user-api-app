// routes/users.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

const User = require('../models/User');
const Order = require('../models/Order');
const Shipment = require('../models/Shipment');

/* -----------------------------------------------------
   Small helpers so renders never crash even if your EJS
   doesn't reference these
----------------------------------------------------- */
function pageStyles() {
  return '';
}
function pageScripts() {
  return '';
}

/* -----------------------------------------------------
   Gate: requires a logged-in user
----------------------------------------------------- */
function ensureUser(req, res, next) {
  if (req.session && req.session.user) {return next();}
  if (req.session && !req.session.returnTo) {req.session.returnTo = req.originalUrl;}
  req.flash('error', 'Please log in.');
  return res.redirect('/users/login');
}

/* =======================================================
   AUTH PAGES
======================================================= */

// GET /users/signup
router.get('/signup', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-signup', {
    title: 'User Sign Up',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

// POST /users/signup
router.post('/signup', async (req, res) => {
  try {
    const { name, email, password, confirm, age, confirm16 } = req.body || {};
    if (!name || !email || !password || !confirm || typeof age === 'undefined') {
      req.flash('error', 'All fields are required.');
      return res.redirect('/users/signup');
    }

    const cleanName = String(name).trim();
    const cleanEmail = String(email).toLowerCase().trim();
    const pass = String(password);
    const conf = String(confirm);

    if (cleanName.length < 2 || cleanName.length > 80) {
      req.flash('error', 'Please enter your full name (2–80 chars).');
      return res.redirect('/users/signup');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      req.flash('error', 'Please enter a valid email address.');
      return res.redirect('/users/signup');
    }
    if (pass.length < 6) {
      req.flash('error', 'Password must be at least 6 characters.');
      return res.redirect('/users/signup');
    }
    if (pass !== conf) {
      req.flash('error', 'Passwords do not match.');
      return res.redirect('/users/signup');
    }

    const nAge = Number(age);
    if (!Number.isInteger(nAge) || nAge < 16 || nAge > 120) {
      req.flash('error', 'You must be at least 16 years old (valid whole number).');
      return res.redirect('/users/signup');
    }
    if (!confirm16) {
      req.flash('error', 'Please confirm that you are at least 16 years old.');
      return res.redirect('/users/signup');
    }

    const exists = await User.findOne({ email: cleanEmail }).lean();
    if (exists) {
      req.flash('error', 'Email already registered.');
      return res.redirect('/users/signup');
    }

    const passwordHash = await bcrypt.hash(pass, 12);
    const user = await User.create({
      name: cleanName,
      email: cleanEmail,
      age: nAge,
      passwordHash,
    });

    // Regenerate to prevent session fixation
    req.session.regenerate((err) => {
      if (err) {
        console.error('[POST /users/signup] session regenerate failed:', err);
        req.flash('error', 'Registration succeeded, but session failed. Please log in.');
        return res.redirect('/users/login');
      }
      req.session.user = {
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      };
      req.flash('success', 'Welcome! Your account is ready.');
      return res.redirect('/users/dashboard');
    });
  } catch (err) {
    if (err && err.code === 11000) {
      req.flash('error', 'Email already registered.');
      return res.redirect('/users/signup');
    }
    console.error('Signup error:', err);
    req.flash('error', 'Registration failed.');
    return res.redirect('/users/signup');
  }
});

// GET /users/login
router.get('/login', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-login', {
    title: 'User Login',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

// POST /users/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, remember } = req.body || {};
    const cleanEmail = String(email || '')
      .toLowerCase()
      .trim();
    const pass = String(password || '');

    if (!cleanEmail || !pass) {
      console.warn('[LOGIN] missing creds', { cleanEmail, passLen: pass.length });
      req.flash('error', 'Email and password required.');
      return res.redirect('/users/login');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      console.warn('[LOGIN] invalid email format:', cleanEmail);
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    const user = await User.findOne({ email: cleanEmail }).lean(false); // return doc, not lean object
    if (!user) {
      console.warn('[LOGIN] user not found:', cleanEmail);
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    if (!user.passwordHash || typeof user.passwordHash !== 'string') {
      console.warn('[LOGIN] missing passwordHash on user:', user._id.toString());
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    const ok = await require('bcrypt').compare(pass, user.passwordHash);
    if (!ok) {
      console.warn('[LOGIN] bcrypt compare failed for:', user._id.toString());
      req.flash('error', 'Invalid credentials.');
      return res.redirect('/users/login');
    }

    // preserve existing business session
    const keepBusiness = req.session.business || null;

    req.session.regenerate((err) => {
      if (err) {
        console.error('[LOGIN] regenerate err', err);
        req.flash('error', 'Login failed.');
        return res.redirect('/users/login');
      }

      if (keepBusiness) {req.session.business = keepBusiness;}

      req.session.user = {
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      };

      if (remember) {
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
      } else {
        req.session.cookie.expires = false;
      }

      const redirectTo = req.session.returnTo || '/users/dashboard';
      delete req.session.returnTo;

      console.log('[LOGIN] OK ->', redirectTo);
      req.flash('success', 'Logged in successfully.');
      return res.redirect(redirectTo);
    });
  } catch (err) {
    console.error('[LOGIN] error', err);
    req.flash('error', 'Login failed.');
    return res.redirect('/users/login');
  }
});

// POST /users/login
// NOTE: No per-route rateLimiter here — server.js already mounts one on /users/login
/*router.post("/login", async (req, res) => {
  try {
    const { email, password, remember } = req.body || {};
    const cleanEmail = String(email || "").toLowerCase().trim();
    const pass = String(password || "");

    if (!cleanEmail || !pass) {
      req.flash("error", "Email and password required.");
      return res.redirect("/users/login");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      req.flash("error", "Invalid credentials.");
      return res.redirect("/users/login");
    }

    const user = await User.findOne({ email: cleanEmail });
    if (!user || typeof user.passwordHash !== "string") {
      req.flash("error", "Invalid credentials.");
      return res.redirect("/users/login");
    }

    const ok = await bcrypt.compare(pass, user.passwordHash);
    if (!ok) {
      req.flash("error", "Invalid credentials.");
      return res.redirect("/users/login");
    }

    // Preserve existing business session
    const keepBusiness = req.session.business || null;

    // Regenerate session to prevent fixation
    req.session.regenerate(err => {
      if (err) {
        console.error("[POST /users/login] regenerate err", err);
        req.flash("error", "Login failed.");
        return res.redirect("/users/login");
      }

      if (keepBusiness) req.session.business = keepBusiness;

      req.session.user = {
        _id: user._id.toString(),
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      };

      // Remember me -> extend cookie
      if (remember) {
        req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30; // 30 days
      } else {
        req.session.cookie.expires = false; // session cookie
      }

      const redirectTo = req.session.returnTo || "/users/dashboard";
      delete req.session.returnTo;

      req.flash("success", "Logged in successfully.");
      return res.redirect(redirectTo);
    });
  } catch (err) {
    console.error("[POST /users/login] error", err);
    req.flash("error", "Login failed.");
    return res.redirect("/users/login");
  }
});*/

// GET /users/logout
router.get('/logout', (req, res) => {
  const keepBusiness = req.session?.business || null;
  req.session.regenerate((err) => {
    if (err) {
      console.error('[GET /users/logout] regenerate err', err);
      if (req.session) {req.session.user = null;}
      req.flash('success', 'Logged out.');
      return res.redirect('/users/login');
    }
    if (keepBusiness) {req.session.business = keepBusiness;}
    req.flash('success', 'Logged out.');
    res.redirect('/users/login');
  });
});

/* =======================================================
   PROFILE
======================================================= */
router.get('/profile', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const doc = await User.findById(req.session.user._id).lean();
  const user = doc ? { ...doc, _id: doc._id.toString() } : req.session.user;

  res.render('users-profile', {
    title: 'My Profile',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user,
    business: req.session.business || null,
  });
});

/* =======================================================
   DASHBOARD
======================================================= */
router.get('/dashboard', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const userObjectId = mongoose.Types.ObjectId.isValid(uid)
    ? new mongoose.Types.ObjectId(uid)
    : null;

  const [orders, shipments, totalOrders, paidOrders, spentAgg] = await Promise.all([
    Order.find({ userId: uid }).sort({ createdAt: -1 }).limit(10).lean(),
    Shipment.find({ userId: uid })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean()
      .catch(() => []),
    Order.countDocuments({ userId: uid }),
    Order.countDocuments({ userId: uid, status: 'paid' }).catch(() => 0),
    userObjectId
      ? Order.aggregate([
          { $match: { userId: userObjectId } },
          { $group: { _id: null, total: { $sum: { $ifNull: ['$amount.total', '$total'] } } } },
        ]).catch(() => [])
      : [],
  ]);

  const totalSpent = spentAgg?.[0]?.total || 0;

  res.render('users-dashboard', {
    title: 'User Dashboard',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    orders,
    shipments,
    kpis: { totalOrders, paidOrders, totalSpent },
  });
});

/* =======================================================
   ORDERS LIST + SHIPMENT SNAPSHOT
======================================================= */
router.get('/orders', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).lean();
  const orderIds = orders.map((o) => o._id);
  const shipments = await Shipment.find({ orderId: { $in: orderIds } })
    .lean()
    .catch(() => []);

  const byOrder = shipments.reduce((acc, s) => ((acc[String(s.orderId)] = s), acc), {});
  const withShip = orders.map((o) => ({ ...o, shipment: byOrder[String(o._id)] || null }));

  res.render('users-orders', {
    title: 'My Orders',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    orders: withShip,
  });
});

/* =======================================================
   ORDER DETAIL + SHIPMENT DETAIL
======================================================= */
router.get('/orders/:id', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const order = await Order.findOne({ _id: req.params.id, userId: uid }).lean();
  if (!order) {
    req.flash('error', 'Order not found.');
    return res.redirect('/users/orders');
  }

  const shipment = await Shipment.findOne({ orderId: order._id })
    .lean()
    .catch(() => null);

  res.render('users-order-detail', {
    title: `Order #${order._id.toString().slice(-6)}`,
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    order,
    shipment,
  });
});

/* =======================================================
   PAYMENTS (derived from Orders)
======================================================= */
router.get('/payments', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const uid = req.session.user._id;

  const orders = await Order.find({ userId: uid }).sort({ createdAt: -1 }).lean();

  const payments = [];
  for (const o of orders) {
    if (Array.isArray(o?.captures)) {
      for (const c of o.captures) {
        payments.push({
          orderId: o._id,
          provider: 'PayPal',
          id: c.id || c.capture_id,
          amount: Number(c.amount?.value || c.amount || o.total || 0),
          currency: c.amount?.currency_code || o.currency || 'USD',
          status: c.status || o.status || 'PAID',
          createdAt: c.create_time ? new Date(c.create_time) : o.createdAt,
        });
      }
    } else if (o?.payment && Array.isArray(o.payment.captures)) {
      for (const c of o.payment.captures) {
        payments.push({
          orderId: o._id,
          provider: 'PayPal',
          id: c.id,
          amount: Number(c.amount?.value || 0),
          currency: c.amount?.currency_code || 'USD',
          status: c.status || o.status || 'PAID',
          createdAt: c.create_time ? new Date(c.create_time) : o.createdAt,
        });
      }
    } else if (o?.paypalCaptureId) {
      payments.push({
        orderId: o._id,
        provider: 'PayPal',
        id: o.paypalCaptureId,
        amount: Number(o.total || 0),
        currency: o.currency || 'USD',
        status: o.status || 'PAID',
        createdAt: o.createdAt,
      });
    }
  }

  res.render('users-payments', {
    title: 'My Payments',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
    payments,
  });
});

/* =======================================================
   CHANGE PASSWORD (while logged in)
======================================================= */
router.get('/change-password', ensureUser, (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('users-change-password', {
    title: 'Change Password',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user,
    business: req.session.business || null,
  });
});

router.post('/change-password', ensureUser, async (req, res) => {
  try {
    const { current, next, confirm } = req.body || {};
    if (!current || !next || !confirm) {
      req.flash('error', 'All fields are required.');
      return res.redirect('/users/change-password');
    }
    if (next !== confirm) {
      req.flash('error', 'New passwords do not match.');
      return res.redirect('/users/change-password');
    }

    const user = await User.findById(req.session.user._id);
    if (!user || typeof user.passwordHash !== 'string') {
      req.flash('error', 'User not found.');
      return res.redirect('/users/change-password');
    }

    const ok = await bcrypt.compare(String(current), user.passwordHash);
    if (!ok) {
      req.flash('error', 'Current password is incorrect.');
      return res.redirect('/users/change-password');
    }

    user.passwordHash = await bcrypt.hash(String(next), 12);
    await user.save();

    req.flash('success', 'Password updated.');
    res.redirect('/users/profile');
  } catch (err) {
    console.error('Change password error:', err);
    req.flash('error', 'Failed to change password.');
    res.redirect('/users/change-password');
  }
});

/* =======================================================
   EDIT PROFILE
======================================================= */

// GET /users/profile/edit
router.get('/profile/edit', ensureUser, async (req, res) => {
  const { nonce = '' } = res.locals;
  const doc = await User.findById(req.session.user._id).lean();
  const user = doc ? { ...doc, _id: doc._id.toString() } : req.session.user;

  return res.render('users-profile-edit', {
    title: 'Edit Profile',
    active: 'users',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user,
    business: req.session.business || null,
  });
});

// POST /users/profile/edit
router.post('/profile/edit', ensureUser, async (req, res) => {
  try {
    const uid = req.session.user._id;
    const { name, age, password } = req.body || {};
    const cleanName = String(name || '').trim();

    if (!cleanName || cleanName.length < 2) {
      req.flash('error', 'Please enter your full name (min 2 characters).');
      return res.redirect('/users/profile/edit');
    }

    const updates = { name: cleanName };

    if (typeof age !== 'undefined' && age !== null && String(age).trim() !== '') {
      const nAge = Number(age);
      if (Number.isNaN(nAge) || nAge < 0 || nAge > 120) {
        req.flash('error', 'Please enter a valid age.');
        return res.redirect('/users/profile/edit');
      }
      updates.age = nAge;
    } else {
      updates.$unset = { ...(updates.$unset || {}), age: '' };
    }

    if (password && String(password).trim().length > 0) {
      const newHash = await bcrypt.hash(String(password).trim(), 12);
      updates.passwordHash = newHash;
      updates.$unset = { ...(updates.$unset || {}), password: '' };
    }

    const updated = await User.findByIdAndUpdate(uid, updates, {
      new: true,
      runValidators: true,
    }).lean();

    if (updated) {
      req.session.user.name = updated.name;
      if (updated.email) {req.session.user.email = updated.email;}
    }

    req.flash('success', 'Profile updated.');
    return res.redirect('/users/profile');
  } catch (err) {
    console.error('Profile update error:', err);
    req.flash('error', 'Failed to update profile.');
    return res.redirect('/users/profile/edit');
  }
});

// GET /users/about  (public)
router.get('/about', (req, res) => {
  const { nonce = '' } = res.locals;
  res.render('about', {
    title: 'About Phakisi Global',
    active: 'about',
    styles: pageStyles(nonce),
    scripts: pageScripts(nonce),
    user: req.session.user || null,
    business: req.session.business || null,
  });
});

/*// DEV-ONLY: view a user doc (masked) to verify fields
router.get("/_dev/show", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).send("Not found");
  const email = String(req.query.email || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ ok:false, msg:"email required" });
  const u = await User.findOne({ email }).lean();
  if (!u) return res.json({ ok:false, msg:"user not found" });
  const masked = {
    _id: u._id,
    email: u.email,
    name: u.name,
    hasPasswordHash: typeof u.passwordHash === "string" && u.passwordHash.length > 0,
    passwordHashLen: u.passwordHash ? String(u.passwordHash).length : 0,
    hasLegacyPasswordField: typeof u.password === "string",
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
  res.json({ ok:true, user: masked });
});

// DEV-ONLY: seed a test user (overwrites same email)
router.post("/_dev/seed-user", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).send("Not found");
  const email = String(req.body.email || "").toLowerCase().trim();
  const name = String(req.body.name || "Test User").trim();
  const pw   = String(req.body.password || "secret123").trim();
  if (!email || !pw) return res.status(400).json({ ok:false, msg:"email/password required" });
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash(pw, 12);
  await User.findOneAndUpdate(
    { email },
    { $set: { name, email, passwordHash: hash }, $unset: { password: "" } },
    { upsert: true, new: true }
  );
  res.json({ ok:true, msg:"seeded", email });
});

// DEV-ONLY: migrate legacy { password } -> { passwordHash }
router.post("/_dev/migrate-passwords", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).send("Not found");
  const bcrypt = require("bcrypt");
  const cursor = User.find({ passwordHash: { $exists: false }, password: { $exists: true } }).cursor();
  let migrated = 0;
  for await (const doc of cursor) {
    const plain = String(doc.password || "");
    if (plain.length >= 6) {
      doc.passwordHash = await bcrypt.hash(plain, 12);
      doc.password = undefined;
      await doc.save();
      migrated++;
    }
  }
  res.json({ ok:true, migrated });
});

// --- DEV ONLY: simple browser form to set a user's password ---
router.get("/_dev/set-password-form", (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).send("Not found");
  res.send(`
    <form method="POST" action="/users/_dev/set-password" style="max-width:420px;margin:40px auto;font-family:system-ui">
      <h3>Set password (DEV)</h3>
      <label style="display:block;margin:8px 0">Email
        <input name="email" type="email" required style="width:100%;padding:.5rem"/>
      </label>
      <label style="display:block;margin:8px 0">New password
        <input name="password" type="password" required minlength="6" style="width:100%;padding:.5rem"/>
      </label>
      <button style="padding:.5rem .8rem">Set Password</button>
      <p style="margin-top:6px;color:#888">POSTS urlencoded; dev only.</p>
    </form>
  `);
});

router.post("/_dev/set-password", async (req, res) => {
  if (process.env.NODE_ENV === "production") return res.status(404).send("Not found");
  try {
    const email = String(req.body?.email || "").toLowerCase().trim();
    const pw    = String(req.body?.password || "");
    if (!email || pw.length < 6) return res.status(400).send("email and 6+ char password required");

    const user = await User.findOne({ email });
    if (!user) return res.status(404).send("user not found");

    const hash = await require("bcrypt").hash(pw, 12);
    user.passwordHash = hash;
    user.password = undefined;
    await user.save();

    res.send(`OK — password updated for ${email}. <a href="/users/_dev/show?email=${encodeURIComponent(email)}">Show doc</a>`);
  } catch (e) {
    console.error("[_dev/set-password] err", e);
    res.status(500).send("error");
  }
});*/

module.exports = router;

/*
NOTES:
- No per-route rate limiter is defined here, because server.js already mounts a rate limiter
  for /users/login and /users/signup. This avoids conflicts and double-limiting.
- We do not pass success/error into res.render; server.js already exposes flash arrays via res.locals.
- Session is regenerated on login/signup to prevent fixation. We preserve req.session.business.
- We respect req.session.returnTo and clear it after successful login.
*/
