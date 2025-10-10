// server.js
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash'); // ✅ added
const multer = require("multer");
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require("crypto");
const expressLayouts = require('express-ejs-layouts');
const mongoose = require('mongoose');
const compression = require('compression');
const morgan = require('morgan');
const MongoStore = require('connect-mongo');
require('dotenv').config();

const app = express();

// --------------------------
// AWS S3 v3 Client Setup
// --------------------------
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION, // e.g., 'us-east-1'
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,   // from .env
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY // from .env
  }
});

// Multer setup (memory storage for S3 upload)
const upload = multer({ storage: multer.memoryStorage() });

module.exports = { s3, upload }; // export to use in routes


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
// Global Error Handlers
// --------------------------
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

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
  ? 'https://my-vite-app-ra7d.onrender.com'  // ✅ replace with your deployed frontend
  : 'http://localhost:5174';             // ✅ Vite dev server

// ----------------------------
// 🧩 CORS Configuration (fixed "null not allowed" issue)
// ----------------------------
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "https://my-express-server-rq4a.onrender.com", // ✅ your deployed frontend domain
];

app.use(
  cors({
    origin: function (origin, callback) {
      // ✅ Allow same-origin requests or requests without Origin header (like EJS forms, Postman, curl)
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`⚠️ CORS blocked for origin: ${origin}`);
      return callback(null, false); // 👈 Don’t throw, just deny silently
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

/*// Define allowed origins
const allowedOrigins = [

  'https://my-vite-app-ra7d.onrender.com',
  'https://my-express-server-rq4a.onrender.com', // backend origin itself
  'http://localhost:3000',  // local dev          
  'http://localhost:5173', // production frontend URL
  'http://localhost:5174'  // ✅ Vite dev server

];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS error: ${origin} is not allowed.`), false);
  },
  credentials: true
}));*/

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

// -------------------------------
// 🧱 Security: Helmet with CSP Nonce (Final Secure Version)
// -------------------------------

// Generate a nonce for every response BEFORE Helmet
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

// ✅ Configure Helmet with dynamic after setting nonce in CSP
app.use((req, res, next) => {
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://apis.google.com",
          "https://www.paypal.com",
          "https://www.sandbox.paypal.com",
          `'nonce-${res.locals.nonce}'`, // ✅ evaluated string, not a function
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.amazonaws.com",
          "https://*.cloudinary.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: [
          "'self'",
          "https://api.paypal.com",
          "https://api.sandbox.paypal.com",
        ],
        frameSrc: [
          "'self'",
          "https://www.paypal.com",
          "https://www.sandbox.paypal.com",
        ],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  })(req, res, next); // ✅ run helmet as middleware inside the function
});


/*// --------------------------
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
}));*/

// Compression
app.use(compression());

// ✅ Define a shared limiter (production vs dev)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "production" ? 100 : 1000, // allow more in dev
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

// ✅ Apply limiter only to authentication & signup routes
app.use("/business/login", limiter);
app.use("/business/login", limiter);
app.use("/business/signup", limiter);
app.use("/business/signup", limiter);

app.use("/users/login", limiter);
app.use("/users/login", limiter);
app.use("/users/signup", limiter);
app.use("/users/rendersignup", limiter);

// ❌ Do NOT apply globally anymore
// app.use(limiter);


/*// Rate limiting
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

app.use(limiter);*/

// --------------------------
// Sessions (Mongo store)
// --------------------------
app.use(session({
  name: 'sid',
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

// routes for the delivery options
const deliveryOptionRouter = require("./routes/deliveryOption");
app.use("/api/deliveryOption", deliveryOptionRouter)

//---------------------------
// product routes
//---------------------------
const productsRouter = require("./routes/products");
app.use("/products", productsRouter);

// 🌍 Contact Page Route
const contactRoutes = require("./routes/contact");
app.use("/contact", contactRoutes);

// 🌐 Admin Routes
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);

//---------------------------
// cart routes
//---------------------------
const cartRoutes = require("./routes/cart");
app.use("/api/cart", cartRoutes);

// --------------------------
// Routes
// --------------------------
const paymentRoutes = require('./routes/payment');
app.use('/payment', paymentRoutes);

// User routes
const usersRouter = require('./routes/users');
app.use('/users', usersRouter);

// Business auth routes
const businessAuthRoutes = require("./routes/businessAuth");
app.use("/business", businessAuthRoutes);

// shipment routes
const shipmentRoutes = require("./routes/shipments");
app.use("/shipments", shipmentRoutes);

// routes for terms and privacy
app.use("/", require("./routes/staticPages"));

// routes for sales-product page
app.use("/sales", require("./routes/sales"));

// 🛒 Get current cart item count
app.get("/cart/count", (req, res) => {
  try {
    const count = req.session.cart && req.session.cart.items
      ? req.session.cart.items.reduce((sum, i) => sum + i.quantity, 0)
      : 0;
    res.json({ count });
  } catch (err) {
    console.error("❌ Failed to fetch cart count:", err);
    res.status(500).json({ count: 0 });
  }
});

// ---------------------------
// 🌗 Theme toggle route
// ---------------------------
app.post('/theme-toggle', (req, res) => {
  // 🔄 Flip theme between dark and light
  req.session.theme = req.session.theme === 'dark' ? 'light' : 'dark';

  // ✅ Redirect back to where the user came from
  const referer = req.get('Referer');
  if (referer) {
    return res.redirect(referer);
  }

  // fallback if no referer header
  res.redirect('/');
});



// --------------------------
// Theme toggle route
// --------------------------
/*app.post('/theme-toggle', (req, res) => {
  // Toggle session theme
  req.session.theme = req.session.theme === 'dark' ? 'light' : 'dark';
  res.json({ theme: req.session.theme });
});
*/
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
//app.get('/env', (req, res) => {
  //res.send(`NODE_ENV = ${process.env.NODE_ENV}`);
//});


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

/*// 500 handler (after all routers)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).render('500', { 
    layout: 'layout', 
    title: 'Server Error',
    active: ''
  });
});*/

// 500 handler (after all routers) — DEBUG VERSION
app.use((err, req, res, next) => {
  console.error("❌ Template render error:", err);
  res.status(500).send(`<pre>${err.stack}</pre>`);
});

// --------------------------
// Connect to MongoDB with retry
// --------------------------
/*const connectWithRetry = (retries = 5, delay = 5000) => {
  console.log(`🔗 Attempting to connect to MongoDB... (${retries} retries left)`);
  mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log("✅ Connected to MongoDB");

    // Start Express server AFTER DB connection
    const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', async() => {
    console.log(`🚀 Server running on port ${PORT}`);
  });

  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    if (retries > 0) {
      console.log(`🔄 Retrying in ${delay / 1000} seconds...`);
      setTimeout(() => connectWithRetry(retries - 1, delay), delay);
    } else {
      console.error("❌ Could not connect to MongoDB after multiple attempts. Exiting...");
      process.exit(1);
    }
  });
};

connectWithRetry();*/

const connectWithRetry = async (retries = 5) => {
  try {
    console.log(`🔗 Attempting to connect to MongoDB... (${retries} retries left)`);

    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 20000, // wait up to 20s for server selection
      socketTimeoutMS: 60000,          // keep socket alive 60s
      connectTimeoutMS: 30000,         // wait up to 30s for initial connect
      maxPoolSize: 20,                 // prevent overload of connections
      minPoolSize: 2,                  // keep a small pool ready
      family: 4,                       // force IPv4 (avoid DNS IPv6 bugs)
    });

    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err.message);

    if (retries > 0) {
      console.log("🔄 Retrying in 5 seconds...");
      setTimeout(() => connectWithRetry(retries - 1), 5000);
    } else {
      console.error("🚨 All MongoDB connection attempts failed. Exiting.");
      process.exit(1);
    }
  }
};

// Call it once at startup
connectWithRetry();

// Start Express server AFTER DB connection
    const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', async() => {
    console.log(`🚀 Server running on port ${PORT}`);
  });


