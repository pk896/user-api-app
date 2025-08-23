// server.js
const express = require('express');
const session = require('express-session');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const compression = require('compression');
const morgan = require('morgan');
const MongoStore = require('connect-mongo');
require('dotenv').config();

const app = express();

// --------------------------
// Environment Validation
// --------------------------
['MONGO_URI', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].forEach(name => {
  if (!process.env[name]) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
});

// --------------------------
// Connect to MongoDB (with retry logic)
// --------------------------
const connectWithRetry = (retries = 5, delay = 5000) => {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch((err) => {
      console.error('❌ MongoDB connection error:', err);
      if (retries > 0) {
        console.log(`🔄 Retrying in ${delay / 1000} seconds... (${retries} attempts left)`);
        setTimeout(() => connectWithRetry(retries - 1, delay), delay);
      } else {
        console.error('❌ Could not connect to MongoDB after multiple attempts');
        process.exit(1);
      }
    });
};
connectWithRetry();

// --------------------------
// Middleware
// --------------------------

// Parse form data & JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// EJS as view engine
app.set('view engine', 'ejs');

// Logging (production-friendly)
app.use(morgan('combined'));

// Secure headers (with CSP)
app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://apis.google.com"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
  }
}));

// Compression (gzip)
app.use(compression());

// Rate limiting (100 requests / 15 min per IP)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// --------------------------
// Sessions (using MongoDB store)
// --------------------------
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 // 1 hour
  }
}));

// --------------------------
// Passport (Google OAuth)
// --------------------------
const passport = require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// --------------------------
// Routes
// --------------------------
const paymentRoutes = require('./routes/payment');
app.use('/payment', paymentRoutes);

const usersRouter = require('./routes/users');
app.use('/users', usersRouter);

// --------------------------
// Google OAuth routes
// --------------------------
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/users/login' }),
  (req, res) => {
    // Save Google user info to session (like normal login)
    req.session.userId = req.user._id;
    req.session.userName = req.user.name;
    req.session.userEmail = req.user.email;
    req.session.userAge = req.user.age || '';

    res.redirect('/users/dashboard');
  }
);

// --------------------------
// Health check (for Render/Heroku/K8s)
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// 404 handler
app.use((req, res) => {
  res.status(404).render('404'); // create views/404.ejs
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('500', { error: err }); // create views/500.ejs
});

// --------------------------
// Start Server
// --------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

