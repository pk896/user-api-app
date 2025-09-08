// server.js
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash'); // ✅ added
const path = require('path');
const cors = require('cors');
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

//Http to https redirection in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

// Detect frontend origin based on environment
const frontendOrigin = process.env.NODE_ENV === 'production'
  ? 'https://https://my-vite-app-ra7d.onrender.com'  // ✅ replace with your deployed frontend
  : 'http://localhost:5174';             // ✅ Vite dev server

// Define allowed origins
const allowedOrigins = [
  'http://localhost:3000',          // local dev
  'https://my-vite-app-ra7d.onrender.com',
  'http://localhost:5173', // production frontend URL
  'http://localhost:5174'
];

// CORS middleware
app.use(cors({
  origin: function(origin, callback) {
    // allow requests with no origin (like Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = `CORS error: ${origin} is not allowed.`;
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true // allow cookies/session
}));

// --------------------------
// Middleware
// --------------------------
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.set('trust proxy', 1); // trust first proxy (Render)

// EJS as view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Layouts
app.use(expressLayouts);
app.set('layout', 'layout');

// Logging
app.use(morgan('combined'));

// --------------------------
// Security headers (Helmet + CSP)
// --------------------------
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://apis.google.com", "https://www.paypal.com", "https://www.sandbox.paypal.com"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'", frontendOrigin], // ✅ allow frontend
    frameSrc: ["'self'", "https://www.paypal.com", "https://sandbox.paypal.com"], // ✅ needed for PayPal buttons
  }
}));


// Security headers
/*app.use(helmet());
app.use(helmet.contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "https://apis.google.com"],
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
  }
}));*/

// Compression
app.use(compression());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({
      success: false,
      message: "Too many requests. Please try again later.",
    });
  },
});

app.use(limiter);

// --------------------------
// Sessions (Mongo store)
// --------------------------

/*app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGO_URI, // your MongoDB connection string
    ttl: 14 * 24 * 60 * 60 // session lifetime in seconds (e.g., 14 days)
  }),
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));*/

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
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax', // Required for OAuth
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
// Theme toggle route
// --------------------------
app.post('/theme-toggle', (req, res) => {
  // Toggle session theme
  req.session.theme = req.session.theme === 'dark' ? 'light' : 'dark';
  res.json({ theme: req.session.theme });
});

// Redirect root to /users/home or render a homepage
app.get('/', (req, res) => {
  //res.redirect('/users/home');
  // OR if you have a homepage view:
   res.render('home', { layout: 'layout', title: 'Home', active: 'home' });
});

app.get('/session-test', (req, res) => {
  req.session.views = (req.session.views || 0) + 1;
  res.send(`Session views: ${req.session.views}`);
});


// --------------------------
// Debug route to check environment
// --------------------------
app.get('/env', (req, res) => {
  res.send(`NODE_ENV = ${process.env.NODE_ENV}`);
});


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

