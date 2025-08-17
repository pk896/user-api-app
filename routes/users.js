const express = require('express');
const router = express.Router();
const User = require('../models/User');
const bcrypt = require('bcrypt');

// Create user
router.post('/', async (req, res) => {
    try {
        const newUser = new User(req.body);
        const savedUser = await newUser.save();
        res.status(201).json(savedUser);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// route for sign-up
router.get('/sign-up', (req, res) => {
  res.render('signup')
})

// POST /users/submit-form
router.post('/submit-form', async (req, res) => {
  try {
    const { name, email, age, password } = req.body;

     // Hash the password before saving
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user with hashed password
    const newUser = new User(
      { name, email, age, password: hashedPassword }
    );
    const savedUser = await newUser.save();
    if (savedUser) res.send(`congratulations ${savedUser.name}! your account is successfully created`)

     // Redirect to /users to see all users
    //res.redirect('/users/sign-up'); // or wherever you want
  } catch (err) {
    console.error('Error saving user:', err);
    res.status(500).send('Error saving user: ' + err.message);
  }
});


/*router.post('/submit-form', async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();

    res.redirect('/users');

  } catch (err) {
    console.error('Error saving user:', err);  // Log full error details
    res.status(500).send('Error saving user: ' + err.message);  // Send error message back to client
  }
});*/

//login route (session)
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).send('Invalid email or password');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send('Invalid email or password');

    // Store user info in session
    req.session.userId = user._id;
    req.session.userName = user.name;
    req.session.userEmail = user.email;
    req.session.userAge = user.age;

    // Redirect to dashboard after login
    res.redirect('/users/dashboard');

    //res.send(`Welcome, ${user.name}! You are now logged in.`);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Server error');
  }
});

// Login route
/*router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) return res.status(400).send('Invalid email or password');

    // Compare password with hashed password in DB
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).send('Invalid email or password');

    // Login successful
    res.send(`Welcome, ${user.name}!`);
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).send('Server error');
  }
});*/

//dinamic html templates(ejs)
router.get('/dashboard', (req, res) => {
  if (!req.session.userId) {
    return res.render('login'); // or wherever your login form is
  }

  // Prevent browser from caching this page
  //res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

  
  res.render('dashboard', {
     user: { 
      name: req.session.userName, 
      email: req.session.userEmail, 
      age: req.session.userAge 
  }});
});

// GET /users/dashboard
/*router.get('/dashboard', async (req, res) => {
  try {
    // Check if logged in
    if (!req.session.userId) {
      return res.status(401).send('Please log in first.');
    }

    // Get user details from MongoDB
    const user = await User.findById(req.session.userId).select('-password'); // exclude password

    if (!user) {
      return res.status(404).send('User not found');
    }

    // Send a simple HTML dashboard (for now)
    res.send(`
      <h1>Welcome, ${user.name}</h1>
      <p>Email: ${user.email}</p>
      <p>Age: ${user.age}</p>
      <a href="/users/logout">Logout</a>
    `);
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Server error');
  }
});*/

// logout
router.get('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Error destroying session:', err);
      return res.status(500).send('Error logging out');
    }

    res.clearCookie('connect.sid'); // optional but recommended
    res.render('login')
  });
});

// Get all users
router.get('/', async (req, res) => {
    try {
        const users = await User.find();
        res.json(users);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Get one user by ID
router.get('/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

// Update user
router.put('/:id', async (req, res) => {
    try {
        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            req.body,
            { new: true }
        );
        if (!updatedUser) return res.status(404).json({ message: 'User not found' });
        res.json(updatedUser);
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
});

// Delete user
router.delete('/:id', async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id);
        if (!deletedUser) return res.status(404).json({ message: 'User not found' });
        res.json({ message: 'User deleted successfully' });
    } catch (err) {
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
