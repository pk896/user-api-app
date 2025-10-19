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
const frontendOrigin =
  process.env.NODE_ENV === 'production'
    ? 'https://my-vite-app-ra7d.onrender.com'   // deployed Vite app
    : 'http://localhost:5174';                   // Vite dev server (match your actual port)

// ----------------------------
// 🧩 CORS Configuration
// ----------------------------
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'my-express-server-rq4a.onrender.com',
  frontendOrigin, // <- use the same value as above so it never drifts
];

app.use(
  cors({
    origin(origin, callback) {
      // Allow same-origin/no-origin (EJS forms, curl, Postman) and whitelisted frontends
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      console.warn(`⚠️ CORS blocked for origin: ${origin}`);
      return callback(null, false); // deny silently
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], // include PATCH
  })
);

/*// Detect frontend origin based on environment
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
);*/

// Generate a nonce for every response BEFORE Helmet
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

// existing Helmet wrapper
app.use((req, res, next) => {
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "'strict-dynamic'",
          `'nonce-${res.locals.nonce}'`,
          "https://apis.google.com",
          "https://www.paypal.com",
          "https://www.sandbox.paypal.com",
          "https://www.paypalobjects.com",
        ],
        imgSrc: [
          "'self'",
          "data:",
          "blob:",
          "https://*.amazonaws.com",
          "https://*.cloudinary.com",
          "https://www.paypalobjects.com",
          "https://www.paypal.com",
          "https://www.sandbox.paypal.com",
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: [
          "'self'",

            // ✅ Add these two:
          "https://api-m.paypal.com",
          "https://api-m.sandbox.paypal.com",


          "https://api.paypal.com",
          "https://api.sandbox.paypal.com",
          "https://www.paypal.com",
          "https://www.sandbox.paypal.com",
          "https://www.paypalobjects.com",
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
  })(req, res, next);
});

/*// === Add this block to control the geolocation permission ===
// Option A: Silence the console by allowing geolocation for PayPal iframes only.
app.use((req, res, next) => {
  res.setHeader(
    "Permissions-Policy",
    'geolocation=(self "https://www.paypal.com" "https://www.sandbox.paypal.com")'
  );
  next();
});*/

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
// app.use("/business/login", limiter);
app.use("/business/login", limiter);
app.use("/business/signup", limiter);
// app.use("/business/signup", limiter);

// app.use("/users/login", limiter);
app.use("/users/login", limiter);
app.use("/users/signup", limiter);
app.use("/users/rendersignup", limiter);

// ❌ Do NOT apply globally anymore
// app.use(limiter);

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

// Allow PayPal popups/overlays on checkout/payment pages
app.use((req, res, next) => {
  if (req.path.startsWith('/checkout') || req.path.startsWith('/payment')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  }
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

// URL control
app.use("/links", require("./routes/someRoute"));

// route for admin role on orders
app.use(require("./routes/adminOrders"));

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

// Checkout page
app.get('/payment/checkout', (req, res) => {
  const cart = req.session.cart || { items: [] };

  // (Optional) if you want to stop empty-checkout visits:
  // if (!cart.items.length) {
  //   req.flash('error', 'Your cart is empty.');
  //   return res.redirect('/sales');
  // }

  res.render('checkout', {
    title: 'Checkout',
    vatRate: Number(process.env.VAT_RATE || 0.15),       // used by checkout.ejs JSON config
    shippingFlat: Number(process.env.SHIPPING_FLAT || 0),// used by checkout.ejs JSON config
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});


// ---------------------------
// Additional EJS page routes
// ---------------------------
app.get('/thank-you', (req, res) => {
  res.render('thank-you', {
    title: 'Thank you',
    orderID: req.query.orderID || '',
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});

// Order list page
app.get('/orders', (req, res) => {
  res.render('order-list', {
    title: 'My Orders',
    themeCss: res.locals.themeCss,
    success: req.flash('success'),
    error: req.flash('error'),
    nonce: res.locals.nonce,
  });
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

// Silence devtools probe (optional)
app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  // Option A: no content
  // res.status(204).end();

  // Option B: minimal stub
  res.type('application/json').send('{}');
});


// 500 handler (after all routers) — DEBUG VERSION
app.use((err, req, res, next) => {
  console.error("❌ Template render error:", err);
  res.status(500).send(`<pre>${err.stack}</pre>`);
});

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


