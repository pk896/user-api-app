const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');
const { body, validationResult } = require('express-validator');
const passport = require('passport'); // Add if using passport Google strategy

// -------------------------
// Middleware for validation
// -------------------------
const validateUser = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('age').optional().isInt({ min: 0 }).withMessage('Age must be a positive number'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 chars long')
];

// -------------------------
// Sign-up page
// -------------------------
router.get('/render-sign-up', (req, res) => {
  res.render('signup', { errors: [], oldInput: {} });
});

// -------------------------
//redirection to Login page
// -------------------------
router.get('/render-login', (req, res) => {
  /*if (!req.session.userId) {
    return res.redirect('/users/sign-up');
  }*/
  res.render('login', { errors: [], oldInput: {} });
});

// -------------------------
// Dashboard
// -------------------------
router.get('/dashboard', (req, res) => {
  if (!req.session.userId) {
    return res.redirect('/users/sign-up');
  }

  const stats = {
    projects: 5,
    tasksCompleted: 12,
    messages: 3
  };

  res.render('dashboard', {
    user: {
      name: req.session.userName,
      email: req.session.userEmail,
      age: req.session.userAge
    },
    stats
  });
});

// -------------------------
// Logout
// -------------------------
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out');
    }
    res.clearCookie('connect.sid');
    res.render('signup', { errors: [], oldInput: {} });
  });
});

// -------------------------
// Google OAuth
// -------------------------
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/users/sign-up?error=Google login failed' }),
  (req, res) => {
    // Successful login
    req.session.userId = req.user._id;
    req.session.userName = req.user.name;
    req.session.userEmail = req.user.email;
    req.session.userAge = req.user.age || null;
    res.redirect('/users/dashboard');
  }
);

// -------------------------
// Sign-up form submission (EJS)
// -------------------------
router.post('/submit-form', validateUser, async (req, res) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    return res.status(400).render('signup', {
      errors: errors.array(),
      oldInput: req.body
    });
  }

  try {
    const { name, email, age, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({ name, email: email.toLowerCase(), age, password: hashedPassword });
    const savedUser = await newUser.save();

    req.session.userId = savedUser._id;
    req.session.userName = savedUser.name;
    req.session.userEmail = savedUser.email;
    req.session.userAge = savedUser.age;

    res.redirect('/users/dashboard');
  } catch (err) {
    console.error('Error saving user:', err);
    res.status(500).render('signup', {
      errors: [{ msg: 'Error creating account, please try again later.' }],
      oldInput: req.body
    });
  }
});

// -------------------------
// Login route
// -------------------------
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).send('Email and password are required');

    const user = await User.findOne({ email: email.toLowerCase() });
    if (!user) return res.status(400).send('Invalid email or password');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send('Invalid email or password.');

    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userAge = user.age;

    res.redirect('/users/dashboard');
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Server error');
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

/*router.get('/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching user' });
  }
});*/

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

