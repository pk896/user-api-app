// routes/users.js
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
  if (req.isAuthenticated()) {
    return next();
  }
  req.flash('error', 'You must be logged in to access the dashboard');
  res.redirect('/users/render-log-in');
}

// -------------------------
// Signup page
// -------------------------
router.get('/render-sign-up', (req, res) => {

  const theme = req.session.theme || 'light'; // light or dark

    res.render('signup', {
      title: 'Sign Up',
    active: 'signup',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
  oldInput: {},                    // preserve empty old input
    error: req.flash('error') || [], // ensure array even if no flash
    success: req.flash('success') || []})
  });

// -------------------------
// Login page
// -------------------------

router.get('/render-log-in', (req, res) => {

  const theme = req.session.theme || 'light'; // light or dark
  
  res.render('login', {
    title: 'Log In',
    active: 'login',
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
    oldInput: {},                    // preserve empty old input
    error: req.flash('error') || [], // ensure array even if no flash
    success: req.flash('success') || []
  })
});


// -------------------------
// Protected dashboard
// -------------------------
router.get('/dashboard', (req, res) => {

   const theme = req.session.theme || 'light'; // light or dark

  if (!req.session.userId) {
    req.flash('error', 'You must be logged in to access the dashboard');
    return res.redirect('/users/render-log-in');
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

  res.render('dashboard', {
    title: 'Dashboard',
    active: 'dashboard', user, stats,
    themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css'
  });
});

// -------------------------
// Home page
// -------------------------
router.get('/home', (req, res) => {

const theme = req.session.theme || 'light'; // light or dark

  res.render('home', { 
    title: 'Home',
    active: 'home',
    user: req.session.userId ? {
      name: req.session.userName,
      email: req.session.userEmail,
      age: req.session.userAge,
    } : null,
     themeCss: theme === 'dark' ? '/css/dark.css' : '/css/light.css',
  });
});

// -------------------------
// About page
// -------------------------
router.get('/about', (req, res) => {

  const theme = req.session.theme || 'light'; // light or dark

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

// -------------------------
// Contact page
// -------------------------
router.get('/contact', (req, res) => {

  const theme = req.session.theme || 'light'; // light or dark

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

// Unified Logout
router.get('/logout', (req, res, next) => {
  console.log("------ LOGOUT START ------");
  console.log("User before logout:", req.user);

  // Set flash BEFORE destroying session
  if (req.session) {
    req.flash('success', 'You have been logged out successfully');
  }

  // Passport logout (works for Google + local)
  req.logout(err => {
    if (err) {
      console.error('Error during logout:', err);
      return next(err);
    }

    // Destroy session for local users
    if (req.session) {
      req.session.destroy(err => {
        if (err) {
          console.error('Error destroying session:', err);
          return res.redirect('/users/dashboard');
        }

        // Clear session cookie
        res.clearCookie('connect.sid');

        console.log("Logout complete: session destroyed, cookie cleared");
        return res.redirect('/users/render-log-in');
      });
    } else {
      // If no session, just redirect
      return res.redirect('/users/render-log-in');
    }
  });
});

// -------------------------
// Unified Logout
// -------------------------
/*router.get('/logout', (req, res, next) => {
  console.log("------ LOGOUT START ------");
  console.log("User before logout:", req.user);

  // Passport logout (works for Google + local)
  req.logout(err => {
    if (err) {
      console.error('Error during logout:', err);
      return next(err);
    }

    // Destroy session for local users
    req.session.destroy(err => {
      if (err) {
        console.error('Error destroying session:', err);
        req.flash('error', 'Error logging out');
        return res.redirect('/users/dashboard');
      }

      // Clear session cookie
      const sessionName = req.session?.cookie?.name || 'connect.sid';
      res.clearCookie(sessionName);

      console.log("Logout complete: session destroyed, cookie cleared");
      req.flash('success', 'You have been logged out successfully');

      return res.redirect('/users/render-log-in');
    });
  });
});*/

// -------------------------
// Signup form submission with automatic login
// -------------------------
router.post('/submit-form', validateUser, async (req, res, next) => {
  const errors = validationResult(req);
  const theme = req.session.theme || 'light'; // <-- you were missing this before
  if (!errors.isEmpty()) {
    return res.status(400).render('signup', { 
      title: 'Sign Up',
      active: 'signup',
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

    const newUser = new User({ 
      name, 
      email: email.toLowerCase(), 
      age, 
      password: hashedPassword 
    });
    const savedUser = await newUser.save();

    // Automatically log the user in
    req.login(savedUser, err => {   // <-- Passport sets req.user
      if (err) return next(err);

      // Set session vars for template rendering & dashboard
      req.session.userId = savedUser._id;
      req.session.userName = savedUser.name;
      req.session.userEmail = savedUser.email;
      req.session.userAge = savedUser.age;

      req.flash('success', 'Account created successfully! Welcome!');

      // Redirect to dashboard
      return res.redirect('/users/dashboard');
    });

  } catch (err) {
    console.error('Error saving user:', err);
    res.status(500).render('signup', { 
      errors: [{ msg: 'Error creating account, please try again later.' }], 
      oldInput: req.body 
    });
  }
});

// -------------------------
// Local login form submission (refactored with req.login)
// -------------------------
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      req.flash('error', 'Email and password are required');
      return res.redirect('/users/render-log-in');
    }

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/users/render-log-in');
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/users/render-log-in');
    }

    // Use Passport's req.login to set req.user
    req.login(user, err => {
      if (err) return next(err);

      // Also set session variables
      req.session.userId = user._id;
      req.session.userName = user.name;
      req.session.userEmail = user.email;
      req.session.userAge = user.age;

      req.flash('success', `Welcome back, ${user.name}!`);

      // Redirect to dashboard
      return res.redirect('/users/dashboard');
    });

      console.log('Session after login:', req.session);

  } catch (err) {
    console.error('Login error:', err);
    req.flash('error', 'Server error, please try again later');
    return res.redirect('/users/render-log-in');
  }
});

// -------------------------
// CRUD API endpoints
// -------------------------
router.get('/', async (req, res) => {
  try {
    const users = await User.find().select('-password');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    if (req.body.password) {
      req.body.password = await bcrypt.hash(req.body.password, 10);
    }
    const updatedUser = await User.findByIdAndUpdate(req.params.id, req.body, { new: true }).select('-password');
    if (!updatedUser) return res.status(404).json({ message: 'User not found' });
    res.json(updatedUser);
  } catch (err) {
    res.status(400).json({ message: 'Error updating user' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deletedUser = await User.findByIdAndDelete(req.params.id);
    if (!deletedUser) return res.status(404).json({ message: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting user' });
  }
});

module.exports = router;