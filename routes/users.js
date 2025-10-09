const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const User = require('../models/User');

// -------------------------
// Validation middleware
// -------------------------
const validateUser = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('age').optional().isInt({ min: 0 }).withMessage('Age must be a positive number'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 chars long')
];

// -------------------------
// Auth middleware
// -------------------------
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  req.flash('error', 'You must be logged in to access the dashboard');
  res.redirect('/users/login');
}

const requireUser = require("../middleware/requireUser");

// -------------------------
// Signup page
// -------------------------
router.get('/signup', (req, res) => {
  const theme = req.session.theme || 'light';
  res.render('users-signup', {
    title: 'Sign Up',
    active: 'user-signup',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    oldInput: {},
    error: req.flash('error') || [],
    success: req.flash('success') || []
  });
});

// -------------------------
// Login page
// -------------------------
router.get('/login', (req, res) => {
  const theme = req.session.theme || 'light';
  res.render('users-login', {
    title: 'Log In',
    active: 'user-login',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    oldInput: {},
    error: req.flash('error') || [],
    success: req.flash('success') || []
  });
});

// -------------------------
// Protected dashboard
// -------------------------
router.get('/dashboard', (req, res) => {
  const theme = req.session.theme || 'light';

  if (!req.session.userId) {
    req.flash('error', 'You must be logged in to access the dashboard');
    return res.redirect('/users/login');
  }

  const user = {
    name: req.session.userName,
    email: req.session.userEmail,
    age: req.session.userAge
  };

  const stats = {
    projects: 5,
    tasksCompleted: 12,
    messages: 3,
    notifications: 7,
    followers: 23,
    following: 18,
    lastLogin: "2025-08-25",
    reputation: 1200
  };

  res.render('dashboards/users-dashboard', {
    title: 'Dashboard',
    active: 'user-dashboard',
    user,
    stats,
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css'
  });
});

/* ----------------------------------------------------------
 * 🧭 GET: User Dashboard
 * -------------------------------------------------------- */
router.get("/dashboards/users-dashboard", requireUser, async (req, res) => {
  try {
    const user = req.user; // Passport sets this automatically
    const stats = {
      orders: 0,    // e.g., await Order.countDocuments({ user: user._id });
      wishlist: 0,  // e.g., await Wishlist.countDocuments({ user: user._id });
      payments: 0,  // e.g., await Payment.countDocuments({ user: user._id });
    };

    res.render("dashboards/users-dashboard", {
      title: "User Dashboard",
      user,
      stats,
      success: req.flash("success"),
      error: req.flash("error"),
      themeCss: res.locals.themeCss,
    });
  } catch (err) {
    console.error("❌ User dashboard error:", err);
    req.flash("error", "Failed to load user dashboard.");
    res.redirect("/users/login");
  }
});


// -------------------------
// Home / About / Contact
// -------------------------
router.get('/home', (req, res) => {
  const theme = req.session.theme || 'light';
  res.render('home', { 
    title: 'Home',
    active: 'home',
    user: req.session.userId ? {
      name: req.session.userName,
      email: req.session.userEmail,
      age: req.session.userAge
    } : null,
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css'
  });
});

router.get('/about', (req, res) => {
  const theme = req.session.theme || 'light';
  res.render('about', { 
    title: 'About',
    active: 'about',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    user: req.session.userId ? {
      name: req.session.userName,
      email: req.session.userEmail,
      age: req.session.userAge
    } : null
  });
});

router.get('/contact', (req, res) => {
  const theme = req.session.theme || 'light';
  res.render('contact', { 
    title: 'Contact',
    active: 'contact',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    user: req.session.userId ? {
      name: req.session.userName,
      email: req.session.userEmail,
      age: req.session.userAge
    } : null
  });
});

// -------------------------
// Profile pages
// -------------------------
router.get('/profile', (req, res) => {
  const theme = req.session.theme || 'light';

  if (!req.session.userId) {
    req.flash('error', 'You must be logged in to view your profile');
    return res.redirect('/users/login');
  }

  const user = {
    name: req.session.userName,
    email: req.session.userEmail,
    age: req.session.userAge
  };

  res.render('profile', {
    title: 'Profile',
    active: 'profile',
    user,
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    success: req.flash('success'),
    error: req.flash('error')
  });
});

router.get('/profile/edit', (req, res) => {
  const theme = req.session.theme || 'light';

  if (!req.session.userId) {
    req.flash('error', 'You must be logged in to edit your profile');
    return res.redirect('/users/login');
  }

  const user = {
    name: req.session.userName,
    email: req.session.userEmail,
    age: req.session.userAge
  };

  res.render('edit-profile', {
    title: 'Edit Profile',
    active: 'profile',
    user,
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    success: req.flash('success'),
    error: req.flash('error')
  });
});

router.post('/profile/edit', async (req, res) => {
  try {
    if (!req.session.userId) {
      req.flash('error', 'You must be logged in');
      return res.redirect('/users/login');
    }

    const { name, age, password } = req.body;
    const user = await User.findById(req.session.userId);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/users/profile');
    }

    user.name = name || user.name;
    user.age = age || user.age;

    if (password && password.trim().length >= 6) {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();

    req.session.userName = user.name;
    req.session.userAge = user.age;

    req.flash('success', '✅ Profile updated successfully');
    return res.redirect('/users/profile');
  } catch (err) {
    console.error('Profile update error:', err);
    req.flash('error', '❌ Failed to update profile');
    return res.redirect('/users/profile/edit');
  }
});

router.post('/profile/delete', async (req, res) => {
  try {
    if (!req.session.userId) {
      req.flash('error', 'You must be logged in');
      return res.redirect('/users/login');
    }

    const user = await User.findByIdAndDelete(req.session.userId);
    if (!user) {
      req.flash('error', 'User not found');
      return res.redirect('/users/profile');
    }

    req.session.destroy(err => {
      if (err) {
        console.error('Error destroying session:', err);
        return res.redirect('/users/profile');
      }
      res.clearCookie('connect.sid');
      req.flash('success', '✅ Your account has been permanently deleted.');
      return res.redirect('/');
    });
  } catch (err) {
    console.error('Delete account error:', err);
    req.flash('error', '❌ Failed to delete account');
    return res.redirect('/users/profile');
  }
});

// -------------------------
// Logout
// -------------------------
router.get('/logout', (req, res, next) => {
  if (req.session) req.flash('success', 'You have been logged out successfully');
  req.logout(err => {
    if (err) return next(err);
    if (req.session) {
      req.session.destroy(err => {
        if (err) return res.redirect('/users/dashboard');
        res.clearCookie('connect.sid');
        return res.redirect('/users/login');
      });
    } else {
      return res.redirect('/users/login');
    }
  });
});

// -------------------------
// Signup submission
// -------------------------
router.post('/submit-form', validateUser, async (req, res, next) => {
  const errors = validationResult(req);
  const theme = req.session.theme || 'light';
  if (!errors.isEmpty()) {
    return res.status(400).render('users-signup', {
      title: 'Sign Up',
      active: 'user-signup',
      themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
      error: req.flash('error') || [],
      success: req.flash('success') || [],
      errors: errors.array(),
      oldInput: req.body
    });
  }

  try {
    const { name, email, age, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email: email.toLowerCase(), age, password: hashedPassword });
    const savedUser = await newUser.save();

    req.login(savedUser, err => {
      if (err) return next(err);
      req.session.userId = savedUser._id;
      req.session.userName = savedUser.name;
      req.session.userEmail = savedUser.email;
      req.session.userAge = savedUser.age;
      req.flash('success', 'Account created successfully! Welcome!');
      return res.redirect('/users/dashboard');
    });
  } catch (err) {
    console.error('Error saving user:', err);
    res.status(500).render('users-signup', {
      title: 'Sign Up',
      active: 'user-signup',
      errors: [{ msg: 'Error creating account, please try again later.' }],
      oldInput: req.body
    });
  }
});

// -------------------------
// Local login
// -------------------------
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      req.flash('error', 'Email and password are required');
      return res.redirect('/users/login');
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/users/login');
    }

    req.login(user, err => {
      if (err) return next(err);
      req.session.userId = user._id;
      req.session.userName = user.name;
      req.session.userEmail = user.email;
      req.session.userAge = user.age;
      req.flash('success', `Welcome back, ${user.name}!`);
      return res.redirect('/users/dashboard');
    });
  } catch (err) {
    console.error('Login error:', err);
    req.flash('error', 'Server error, please try again later');
    return res.redirect('/users/login');
  }
});

// -------------------------
// Basic CRUD API
// -------------------------
router.get('/', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (req.body.password) req.body.password = await bcrypt.hash(req.body.password, 10);
    const updated = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
    if (!updated) return res.status(404).json({ message: 'User not found' });
    res.json(updated);
  } catch {
    res.status(400).json({ message: 'Error updating user' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await User.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch {
    res.status(500).json({ message: 'Error deleting user' });
  }
});

module.exports = router;

