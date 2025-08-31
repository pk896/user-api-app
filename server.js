// server.js
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash'); // ✅ added
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const expressLayouts = require('express-ejs-layouts');
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// EJS as view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Layouts
app.use(expressLayouts);
app.set('layout', 'layout');

// Logging
app.use(morgan('combined'));

// Security headers
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

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

// --------------------------
// Sessions (Mongo store)
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
// Connect-flash (after session!)
// --------------------------
app.use(flash());

// --------------------------
// Passport (Google OAuth)
// --------------------------
const passport = require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// --------------------------
// Make flash + user available in all views
// --------------------------
app.use((req, res, next) => {
  res.locals.user = req.user || null; // passport user

  // Flash messages
  res.locals.success = req.flash('success') || [];
  res.locals.error = req.flash('error') || [];
  res.locals.info = req.flash('info') || [];
  res.locals.warning = req.flash('warning') || [];
  res.locals.errors = req.flash('errors') || [];
  
    // Theme (light or dark)
  res.locals.theme = req.session.theme || 'light';
  res.locals.themeCss = res.locals.theme === 'dark' 
    ? '/css/dark.css' 
    : '/css/main.css';


  next();
});

// --------------------------
// google OAuth routes
// --------------------------
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/users/render-log-in' }),
  (req, res) => {
    req.session.userId = req.user._id;
    req.session.userName = req.user.name;
    req.session.userEmail = req.user.email;
    req.session.userAge = req.user.age || null;

    req.flash('success', `Welcome back, ${req.user.name}!`);
    res.redirect('/users/dashboard');
  }
);

// --------------------------
// Prevent cached pages after logout
// --------------------------
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// --------------------------
// Routes
// --------------------------
const paymentRoutes = require('./routes/payment');
app.use('/payment', paymentRoutes);

const usersRouter = require('./routes/users');
app.use('/users', usersRouter);

// --------------------------
// Health check
// --------------------------
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// 404 handler (after all routers)
app.use((req, res) => {
  res.status(404).render('404', { 
    layout: 'layout', 
    title: 'Page Not Found',
    active: ''
  });
});

// 500 handler (after all routers)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('500', { 
    layout: 'layout', 
    title: 'Server Error',
    active: ''
  });
});

// --------------------------
// Start Server
// --------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

