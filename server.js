// server.js
const validateEnv = require("./config/validateEnv");
validateEnv();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require("multer");
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require("crypto");
const expressLayouts = require('express-ejs-layouts');
// const mongoose = require('mongoose');
const compression = require('compression');
const morgan = require('morgan');
const MongoStore = require('connect-mongo');
require('dotenv').config();

const app = express();

/* ---------------------------------------
   AWS S3 v3 Client Setup
--------------------------------------- */
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});
const upload = multer({ storage: multer.memoryStorage() });
module.exports = { s3, upload };

app.use((req, res, next) => {
  // Your existing locals...
  res.locals.appUrl  = process.env.APP_URL || '';   // e.g. https://my-express-server-rq4a.onrender.com
  res.locals.frontendUrl = process.env.FRONTEND_URL || '';
  next();
});

/* ---------------------------------------
   Environment Validation
--------------------------------------- */
/*['MONGO_URI', 'SESSION_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].forEach(name => {
  if (!process.env[name]) {
    console.error(`❌ Missing required env var: ${name}`);
    process.exit(1);
  }
});*/

/* ---------------------------------------
   Global Error Handlers
--------------------------------------- */
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
});

/* ---------------------------------------
   Frontends + CORS allow-list
--------------------------------------- */
const DEV_VITE_1 = "http://localhost:5173";
const DEV_VITE_2 = "http://localhost:5174";
const DEV_BACKEND = "http://localhost:3000";
const DEV_BACKEND_127 = "http://127.0.0.1:3000";

const PROD_BACKEND = "https://my-express-server-rq4a.onrender.com";
const PROD_FRONTEND = "https://my-vite-app-ra7d.onrender.com";

const ENV_FRONTEND = process.env.FRONTEND_URL;
const ENV_APP_URL  = process.env.APP_URL;

const allowedOrigins = Array.from(new Set([
  DEV_BACKEND,
  DEV_BACKEND_127,
  DEV_VITE_1,
  DEV_VITE_2,
  PROD_BACKEND,
  PROD_FRONTEND,
  ENV_FRONTEND,
  ENV_APP_URL,
].filter(Boolean)));

const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === "null") return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`⚠️ CORS blocked for origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-Requested-With", "Authorization"],
  optionsSuccessStatus: 204,
};

/* ---------------------------------------
   ORDER OF MIDDLEWARE (CRITICAL)
--------------------------------------- */

// 1) Parsers FIRST
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// 2) CORS
app.use(cors(corsOptions));

// 3) Nonce BEFORE Helmet (for CSP)
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

// 4) Helmet with CSP (kept your directives)
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

// 5) Static
app.use(express.static(path.join(__dirname, 'public')));

// 6) Views / layouts / logs / compression
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(morgan('combined'));
app.use(compression());

// 7) Rate limiter (scoped)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
  },
});
app.use("/business/login", limiter);
app.use("/business/signup", limiter);
app.use("/users/login", limiter);
app.use("/users/signup", limiter);
app.use("/users/rendersignup", limiter);

// 8) Sessions → flash → passport → locals
app.set('trust proxy', 1);
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'None' : 'Lax',
    maxAge: 1000 * 60 * 60
  }
}));

app.use(flash());

const passport = require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// Global locals (AFTER passport)
app.use((req, res, next) => {
  res.locals.success = req.flash('success') || [];
  res.locals.error   = req.flash('error')   || [];
  res.locals.info    = req.flash('info')    || [];
  res.locals.warning = req.flash('warning') || [];
  res.locals.errors  = req.flash('errors')  || [];

  // Use your own session namespaces for navbar
  res.locals.user     = req.session.user || null;
  res.locals.business = req.session.business || null;

  res.locals.theme = req.session.theme || 'light';
  res.locals.themeCss = res.locals.theme === 'dark' ? '/css/dark.css' : '/css/main.css';
  next();
});

/* ---------------------------------------
   Google OAuth
--------------------------------------- */
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/users/login', failureFlash: true }),
  (req, res) => {
    if (!req.user) return res.redirect('/users/login');

    // Regenerate + save ensures cookie write before redirect
    req.session.regenerate((err) => {
      if (err) return res.redirect('/users/login');
      req.session.user = {
        _id: req.user._id.toString(),
        name: req.user.name,
        email: req.user.email,
        createdAt: req.user.createdAt,
      };
      req.session.save(() => {
        req.flash('success', 'Logged in with Google.');
        res.redirect('/users/dashboard');
      });
    });
  }
);

/* ---------------------------------------
   Cache & COOP
--------------------------------------- */
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith('/checkout') || req.path.startsWith('/payment')) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  }
  next();
});

/* ---------------------------------------
   Routers
--------------------------------------- */
const deliveryOptionRouter = require("./routes/deliveryOption");
const productsRouter       = require("./routes/products");
const contactRoutes        = require("./routes/contact");
const adminRoutes          = require("./routes/admin");
const adminOrdersRoutes    = require("./routes/ordersAdmin");
const cartRoutes           = require("./routes/cart");
const paymentRoutes        = require("./routes/payment");
const usersRouter          = require("./routes/users");
const businessAuthRoutes   = require("./routes/businessAuth");
const shipmentRoutes       = require("./routes/shipments");
const staticPagesRoutes    = require("./routes/staticPages");
const salesRoutes          = require("./routes/sales");
const someLinksRoutes      = require("./routes/someRoute");
const requireOrdersAdmin   = require("./middleware/requireOrdersAdmin");
const deliveryOptionsAdmin = require("./routes/deliveryOptionsAdmin");
const requireAdmin         = require("./middleware/requireAdmin");
const deliveryOptionsApi   = require('./routes/deliveryOptionsApi');
const demandsRoutes        = require('./routes/demands');
const matchesRoutes        = require("./routes/matches");
const notificationsRoutes  = require("./routes/notifications");
const notificationsUnread  = require("./middleware/notificationsUnread");
const wishlistRoutes       = require("./routes/wishlist");
const passwordResetRoutes  = require("./routes/passwordReset");
const productRatingsRoutes = require("./routes/productRatings");

// API first
app.use("/api/deliveryOption", deliveryOptionRouter);
app.use("/api/cart", cartRoutes);

// Admin API
app.use('/api/admin', requireAdmin);
app.use("/api/admin", paymentRoutes);
app.use('/api/admin', requireOrdersAdmin);

// Auth & identity
app.use("/users", usersRouter);
app.use("/business", businessAuthRoutes);

// Business/admin pages
app.use("/admin", adminRoutes);
app.use("/admin", adminOrdersRoutes);
app.use(deliveryOptionsAdmin);
app.use(deliveryOptionsApi);

// Commerce / catalog
app.use("/products", productsRouter);
app.use("/shipments", shipmentRoutes);
app.use("/payment", paymentRoutes);

// Public pages
app.use("/contact", contactRoutes);
app.use("/sales",   salesRoutes);
app.use("/links",   someLinksRoutes);

// Demands & Matches
app.use("/demands",  demandsRoutes);
app.use("/matches",  matchesRoutes);

// Notifications and unread counter
app.use("/notifications", notificationsRoutes);
app.use(notificationsUnread);

// Ratings
app.use(productRatingsRoutes);

// Wishlist under /users
app.use("/users", wishlistRoutes);

// Password reset
app.use("/users/password", passwordResetRoutes);

// Land on the shopping page by default (put this BEFORE staticPagesRoutes)
app.get("/", (req, res) => {
  res.redirect(302, "/products/sales"); // use 301 in production if you want it permanent
});

// Static / legal LAST
app.use("/", staticPagesRoutes);

/* ---------------------------------------
   Extra EJS page routes you added
--------------------------------------- */
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

app.get('/payment/checkout', (req, res) => {
  const cart = req.session.cart || { items: [] };
  res.render('checkout', {
    title: 'Checkout',
    vatRate: Number(process.env.VAT_RATE || 0.15),
    shippingFlat: Number(process.env.SHIPPING_FLAT || 0),
    themeCss: res.locals.themeCss,
    //success: req.flash('success'),
    //error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});

app.get('/thank-you', (req, res) => {
  res.render('thank-you', {
    title: 'Thank you',
    orderID: req.query.orderID || '',
    themeCss: res.locals.themeCss,
    //success: req.flash('success'),
    //error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});

app.get('/orders', (req, res) => {
  res.render('order-list', {
    title: 'My Orders',
    themeCss: res.locals.themeCss,
    //success: req.flash('success'),
    //error: req.flash('error'),
    nonce: res.locals.nonce,
  });
});

/* ---------------------------------------
   Theme toggle
--------------------------------------- */
app.post('/theme-toggle', (req, res) => {
  req.session.theme = req.session.theme === 'dark' ? 'light' : 'dark';
  const referer = req.get('Referer');
  if (referer) return res.redirect(referer);
  res.redirect('/');
});

/* ---------------------------------------
   Home + Debug + Health
--------------------------------------- */
app.get('/', (req, res) => {
  res.render('home', { layout: 'layout', title: 'Home', active: 'home' });
});

app.get('/session-test', (req, res) => {
  req.session.views = (req.session.views || 0) + 1;
  res.send(`Session views: ${req.session.views}`);
});

app.get("/_debug/session", (req, res) => {
  res.json({
    hasUser: !!req.session.user,
    hasBusiness: !!req.session.business,
    session: req.session
  });
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));

/* ---------------------------------------
   404 & 500
--------------------------------------- */
app.use((req, res) => {
  res.status(404).render('404', {
    layout: 'layout',
    title: 'Page Not Found',
    active: ''
  });
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.type('application/json').send('{}');
});

app.use((err, req, res, next) => {
  console.error("❌ Template render error:", err);
  res.status(500).send(`<pre>${err.stack}</pre>`);
});

/* ---------------------------------------
   DB connect + listen
--------------------------------------- */
const { connectWithRetry } = require('./utils/db');
connectWithRetry();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));

