// server.js
require('dotenv').config();

/* ---------------------------------------
   IMPORTANT: Connect to DB FIRST, before anything else
   This ensures DB is ready before any models/operations
--------------------------------------- */
const connectDB = require('./config/db');

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000; // 5 seconds
let retryCount = 0;

// Database state tracking
let dbConnectionEstablished = false;

async function initializeDatabase() {
  try {
    console.log('🔗 Attempting database connection...');
    await connectDB();
    dbConnectionEstablished = true;
    console.log('✅ Database connected successfully');
    return true;
  } catch (err) {
    console.error('❌ Failed to initialize database:', err.message);

    if (retryCount < MAX_RETRIES) {
      retryCount++;
      console.log(
        `🔄 Retry attempt ${retryCount}/${MAX_RETRIES} in ${RETRY_DELAY / 1000} seconds...`,
      );

      // Wait and retry
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
      return await initializeDatabase();
    } else {
      console.error('⚠️ Max retries reached. Starting server without database connection.');
      console.error('⚠️ Database-dependent features will be unavailable.');
      return false;
    }
  }
}

// Now validate environment (after DB connection attempt)
const validateEnv = require('./config/validateEnv');
try {
  validateEnv();
  console.log('✅ Environment validation passed');
} catch (err) {
  console.error('⚠️ Environment validation failed:', err && err.message);
  console.error('⚠️ Continuing with invalid environment - some features may not work correctly');
  // Don't throw, just log and continue
}

/* ---------------------------------------
   Rest of imports (after DB connection)
--------------------------------------- */
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const expressLayouts = require('express-ejs-layouts');
const compression = require('compression');
const morgan = require('morgan');
const MongoStore = require('connect-mongo');

const app = express();

// AWS S3 configuration
const { S3Client } = require('@aws-sdk/client-s3');
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const upload = multer({ storage: multer.memoryStorage() });
module.exports = { s3, upload };

/* ---------------------------------------
   Early middleware for app URLs
--------------------------------------- */
app.use((req, res, next) => {
  res.locals.appUrl = process.env.APP_URL || '';
  res.locals.frontendUrl = process.env.FRONTEND_URL || '';
  next();
});

app.use((req, res, next) => {
  // ensures layout.ejs always has these variables
  res.locals.title = res.locals.title || '';
  next();
});

/* ---------------------------------------
   Database connection state middleware
--------------------------------------- */
app.use((req, res, next) => {
  res.locals.dbAvailable = dbConnectionEstablished;
  res.locals.dbWarning = !dbConnectionEstablished;
  next();
});

/* ---------------------------------------
   Global Error Handlers
--------------------------------------- */
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  // Don't exit, just log the error
  console.error('⚠️ Continuing despite uncaught exception');
});

/* ---------------------------------------
   CORS Configuration
--------------------------------------- */
const DEV_VITE_1 = 'http://localhost:5173';
const DEV_VITE_2 = 'http://localhost:5174';
const DEV_BACKEND = 'http://localhost:3000';
const DEV_BACKEND_127 = 'http://127.0.0.1:3000';
const PROD_BACKEND = 'https://my-express-server-rq4a.onrender.com';
const PROD_FRONTEND = 'https://my-vite-app-ra7d.onrender.com';
const ENV_FRONTEND = process.env.FRONTEND_URL;
const ENV_APP_URL = process.env.APP_URL;

const allowedOrigins = Array.from(
  new Set(
    [
      DEV_BACKEND,
      DEV_BACKEND_127,
      DEV_VITE_1,
      DEV_VITE_2,
      PROD_BACKEND,
      PROD_FRONTEND,
      ENV_FRONTEND,
      ENV_APP_URL,
    ].filter(Boolean),
  ),
);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === 'null') return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`⚠️ CORS blocked for origin: ${origin}`);
    return callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Requested-With', 'Authorization'],
  optionsSuccessStatus: 204,
};

// PayPal Webhooks MUST use RAW body (before express.json)
const paypalWebhooks = require('./routes/paypalWebhooks');

// Accept any content-type to avoid charset/proxy issues
app.use('/webhooks', express.raw({ type: '*/*' }), paypalWebhooks);

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
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
});

// 4) Helmet with CSP
app.use((req, res, next) => {
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],

        // ✅ Only allow scripts from self + nonce + explicit providers
        scriptSrc: [
          "'self'",
          `'nonce-${res.locals.nonce}'`,
          'https://apis.google.com',
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
          'https://www.paypalobjects.com',
        ],

        // ✅ Needed for PayPal button if it injects inline styles (you already allow unsafe-inline for style)
        styleSrc: ["'self'", "'unsafe-inline'"],

        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.amazonaws.com',
          'https://*.cloudinary.com',
          'https://www.paypalobjects.com',
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
        ],

        // ✅ XHR/fetch/websocket
        connectSrc: [
          "'self'",
          'https://api-m.paypal.com',
          'https://api-m.sandbox.paypal.com',
          'https://api.paypal.com',
          'https://api.sandbox.paypal.com',
          'https://www.paypal.com',
          'https://www.sandbox.paypal.com',
          'https://www.paypalobjects.com',
        ],

        // ✅ PayPal renders in iframes
        frameSrc: ["'self'", 'https://www.paypal.com', 'https://www.sandbox.paypal.com'],

        // ✅ Good security hardening (won’t break your app)
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],

        // Keep as you had it (empty array disables auto-upgrade)
        upgradeInsecureRequests: [],
      },
    },
  })(req, res, next);
});

// 5) Static files
app.use(express.static(path.join(__dirname, 'public')));

// 6) Views / layouts / logs / compression
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(morgan('combined'));
app.use(compression());

// 7) Rate limiter
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: process.env.NODE_ENV === 'production' ? 100 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit exceeded for IP: ${req.ip}`);
    res.status(429).json({ success: false, message: 'Too many requests. Please try again later.' });
  },
});
app.use('/business/signup', limiter);
app.use('/users/login', limiter);
app.use('/users/signup', limiter);

// 7b) Stricter limiter for account recovery + sensitive actions
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: process.env.NODE_ENV === 'production' ? 10 : 100, // ✅ strict in prod
  standardHeaders: true,
  legacyHeaders: false,

  // ✅ In Render you already set: app.set('trust proxy', 1);
  // This makes req.ip correct behind the proxy.
  keyGenerator: (req) => {
    // add a little extra “stickiness” per endpoint
    const ip = req.ip || 'noip';
    const path = req.originalUrl || req.path || 'nop';
    return `${ip}:${path}`;
  },

  handler: (req, res) => {
    console.warn(`⚠️ Sensitive rate limit exceeded for IP: ${req.ip} on ${req.originalUrl}`);
    // Return a generic message (don’t leak anything)
    return res
      .status(429)
      .json({ success: false, message: 'Too many requests. Please try again later.' });
  },
});

// Users: forgot username + password reset + profile/password changes
app.use('/users/username/forgot', sensitiveLimiter);
app.use('/users/password/forgot', sensitiveLimiter);
app.use('/users/password/reset', sensitiveLimiter); // ✅ covers /users/password/reset/:token
app.use('/users/change-password', sensitiveLimiter);
app.use('/profile/edit', sensitiveLimiter);

// Business: login is already covered by your normal limiter,
// but change-email / profile / password reset are sensitive
app.use('/business/login', sensitiveLimiter);
app.use('/business/change-email', sensitiveLimiter);
app.use('/business/profile/edit-bank', sensitiveLimiter);
app.use('/profile/update-details', sensitiveLimiter)
app.use('/business/profile', sensitiveLimiter);
app.use('/business/password/forgot', sensitiveLimiter);
app.use('/business/password/reset', sensitiveLimiter); // ✅ covers /business/password/reset/:token

// admin routes ratelimiter protection
app.use('/admin/login', sensitiveLimiter)
app.use('/admin/payouts/create', sensitiveLimiter);
app.use('/admin/payouts/sync-recent', sensitiveLimiter);
app.use('/admin/payouts', sensitiveLimiter); // optional: protects list page too
app.use('/api/admin/orders', sensitiveLimiter); // optional but solid

// payment routes rate limiting protector
app.use('/payment/refund', sensitiveLimiter);
app.use('/payment/sync-refunds', sensitiveLimiter);
app.use('/payment/reconcile-recent-refunds', sensitiveLimiter);
/* ---------------------------------------
   Session Configuration (STABLE)
   ✅ MUST be mounted BEFORE passport.session() and before req.flash usage
   ✅ No fallback store / no switching
--------------------------------------- */
app.set('trust proxy', 1);

const SESSION_SECRET =
  (process.env.SESSION_SECRET && String(process.env.SESSION_SECRET).trim()) ||
  'dev_secret_change_me';

app.use(
  session({
    name: 'sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGO_URI,
      collectionName: 'sessions',
      ttl: 14 * 24 * 60 * 60, // 14 days
      autoRemove: 'native',
    }),
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 1000 * 60 * 60, // 1 hour
    },
  }),
);

app.use(flash());

// Date helpers middleware
const { attachDateHelpers } = require('./middleware/dates');
app.use(attachDateHelpers);

// Passport configuration
const passport = require('./config/passport');
app.use(passport.initialize());
app.use(passport.session());

// Global locals (AFTER passport)
app.use((req, res, next) => {
  res.locals.success = req.flash('success') || [];
  res.locals.error = req.flash('error') || [];
  res.locals.info = req.flash('info') || [];
  res.locals.warning = req.flash('warning') || [];
  res.locals.errors = req.flash('errors') || [];

  // Use your own session namespaces for navbar
  res.locals.user = req.session.user || null;
  res.locals.business = req.session.business || null;

  res.locals.theme = req.session.theme || 'light';
  res.locals.themeCss = res.locals.theme === 'dark' ? '/css/dark.css' : '/css/main.css';

  // Add database status to locals for templates
  res.locals.dbAvailable = dbConnectionEstablished;

  next();
});

/* ---------------------------------------
   Google OAuth Routes (FIXED)
--------------------------------------- */

// Start Google OAuth (save returnTo first)
function safeReturnTo(input) {
  if (!input) return null;

  // allow only local paths like "/users/dashboard?x=1"
  try {
    const u = new URL(String(input), 'http://localhost'); // base just for parsing
    const path = (u.pathname || '/') + (u.search || '') + (u.hash || '');
    if (!path.startsWith('/')) return null;
    if (path.startsWith('//')) return null;
    return path;
  } catch {
    const s = String(input);
    if (s.startsWith('/') && !s.startsWith('//')) return s;
    return null;
  }
}

app.get(
  '/auth/google',
  (req, res, next) => {
    const rt =
      safeReturnTo(req.query.returnTo) ||
      safeReturnTo(req.get('referer')) ||
      '/users/dashboard';

    req.session.returnTo = rt;

    // ✅ IMPORTANT: force-save before redirecting to Google
    req.session.save((err) => {
      if (err) console.warn('[auth/google] session save error:', err);
      next();
    });
  },
  passport.authenticate('google', { scope: ['profile', 'email'] }),
);

// Callback
app.get(
  '/auth/google/callback',
  passport.authenticate('google', {
    failureRedirect: '/users/login',
    failureFlash: true,
  }),
  async (req, res) => {
    if (!req.user) {
      req.flash('error', 'Google login failed. Please try again.');
      return res.redirect('/users/login');
    }

    // Keep only safe session data across regenerate
    const keep = {
      business: req.session?.business || null,
      cart: req.session?.cart || null,
      theme: req.session?.theme || null,
      returnTo: req.session?.returnTo || null,
    };

    req.session.regenerate(async (err) => {
      if (err) {
        console.error('[Google callback] session regenerate error:', err);
        req.flash('error', 'Login failed. Please try again.');
        return res.redirect('/users/login');
      }

      // Restore kept values
      if (keep.business) req.session.business = keep.business;
      if (keep.cart) req.session.cart = keep.cart;
      if (keep.theme) req.session.theme = keep.theme;

      // Set user session
      req.session.user = {
        _id: req.user._id.toString(),
        name: req.user.name,
        email: req.user.email,
        username: req.user.username || null,
        createdAt: req.user.createdAt,
        provider: req.user.provider || 'google',
        isEmailVerified: !!req.user.isEmailVerified,
      };

      // Optional: lastLogin update
      try {
        req.user.lastLogin = new Date();
        await req.user.save();
      } catch (e) {
        console.warn('[Google callback] lastLogin error:', e?.message);
      }

      const redirectTo = keep.returnTo || '/users/dashboard';

      // Clear returnTo after using it
      delete req.session.returnTo;

      req.session.save(() => {
        req.flash('success', 'Logged in with Google.');
        return res.redirect(redirectTo);
      });
    });
  },
);

/* ---------------------------------------
   Cache & COOP Headers
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
   Import and Register Routers
--------------------------------------- */
const deliveryOptionsApi = require('./routes/deliveryOptionsApi');
const productRatingsApiRoutes = require('./routes/productRatingsApi');
const deliveryOptionsAdmin = require('./routes/deliveryOptions');
const adminShippoRoutes = require('./routes/adminShippo');
const productsRouter = require('./routes/products');
const contactRoutes = require('./routes/contact');
const adminRoutes = require('./routes/admin');
const cartRoutes = require('./routes/cart');
const paymentRouter = require('./routes/payment');
const usersRouter = require('./routes/users');
const businessAuthRoutes = require('./routes/businessAuth');
const staticPagesRoutes = require('./routes/staticPages');
const salesRoutes = require('./routes/sales');
const someLinksRoutes = require('./routes/someRoute');
const demandsRoutes = require('./routes/demands');
const matchesRoutes = require('./routes/matches');
const notificationsRoutes = require('./routes/notifications');
const wishlistRoutes = require('./routes/wishlist');
const passwordResetRoutes = require('./routes/passwordReset');
const ratingsRouter = require('./routes/productRatings');
const orderTrackingRoutes = require('./routes/orderTracking');
const adminBizVerifyRoutes = require('./routes/adminBusinessVerification');
const adminOrdersApi = require('./routes/adminOrdersApi');
const adminPayoutsRoutes = require('./routes/adminPayouts');
const debugDangerRoutes = require('./routes/debugDanger');
const ordersDetailsRoutes = require('./routes/orderDetails');
const ordersRoutes = require('./routes/orders');
app.use('/_danger', debugDangerRoutes);

if (ratingsRouter) {
  app.use('/productRatings', ratingsRouter);
  // console.log('✅ Ratings router mounted at /productRatings');
}

// API first
app.use('/api/cart', cartRoutes);

// Public API for checkout
app.use('/api', deliveryOptionsApi);

// Admin API
app.use('/api/admin', adminOrdersApi);

// rating API
app.use('/api', productRatingsApiRoutes);

// Auth & identity
app.use('/users', usersRouter);
app.use('/business', businessAuthRoutes);

// Business/admin pages
app.use('/admin', adminRoutes);
// app.use('/admin', adminOrdersRoutes);
app.use('/admin', adminBizVerifyRoutes);
// Admin pages/forms
app.use('/admin', deliveryOptionsAdmin);
app.use(adminShippoRoutes);
app.use('/admin', adminPayoutsRoutes);

// Commerce / catalog
app.use('/products', productsRouter);
app.use('/payment', paymentRouter);

// Public pages
app.use('/contact', contactRoutes);
app.use('/sales', salesRoutes);
app.use('/links', someLinksRoutes);

// Demands & Matches
app.use('/demands', demandsRoutes);
app.use('/matches', matchesRoutes);

// Notifications and unread counter
app.use('/notifications', notificationsRoutes);

// Disable EJS caching in development
app.set('view cache', false);

// Ratings)
// app.use('productRatingsRoutes');
//app.use('/', productRatingsRoutes);

// Wishlist under /users
app.use('/users', wishlistRoutes);

// Password reset
app.use('/users/password', passwordResetRoutes);
// Tracking (separate namespace so it never conflicts)
app.use('/orders', orderTrackingRoutes);
app.use('/orderDetails', ordersDetailsRoutes);
app.use(ordersRoutes);

/* ---------------------------------------
   Additional Routes
--------------------------------------- */

// Land on the shopping page by default
app.get('/', (req, res) => {
  res.redirect(302, '/products/sales');
});

// Cart count API
app.get('/cart/count', (req, res) => {
  try {
    const count =
      req.session.cart && req.session.cart.items
        ? req.session.cart.items.reduce((sum, i) => sum + i.quantity, 0)
        : 0;
    res.json({ count });
  } catch (err) {
    console.error('❌ Failed to fetch cart count:', err);
    res.status(500).json({ count: 0 });
  }
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
app.get('/home', (req, res) => {
  res.render('home', {
    layout: 'layout',
    title: 'Home',
    active: 'home',
    dbAvailable: dbConnectionEstablished,
  });
});

app.get('/session-test', (req, res) => {
  req.session.views = (req.session.views || 0) + 1;
  res.send(`Session views: ${req.session.views}`);
});

/*app.get('/_debug/session', (req, res) => {
  res.json({
    hasUser: !!req.session.user,
    hasBusiness: !!req.session.business,
    session: req.session,
  });
});*/

// Enhanced health check
app.get('/healthz', (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    database: dbConnectionEstablished ? 'connected' : 'disconnected',
    memory: process.memoryUsage(),
  };

  res.status(200).json(health);
});

// Database status endpoint
app.get('/_status/database', (req, res) => {
  const mongoose = require('mongoose');
  res.json({
    connected: dbConnectionEstablished,
    mongooseState: mongoose.connection.readyState,
    retryCount: retryCount,
    maxRetries: MAX_RETRIES,
  });
});

// Static / legal LAST
app.use('/', staticPagesRoutes);

/* ---------------------------------------
   404 & 500 Error Handlers
--------------------------------------- */
app.use((req, res) => {
  res.status(404).render('404', {
    layout: 'layout',
    title: 'Page Not Found',
    active: '',
    dbAvailable: dbConnectionEstablished,
  });
});

app.get('/.well-known/appspecific/com.chrome.devtools.json', (req, res) => {
  res.type('application/json').send('{}');
});

app.use((err, req, res, _next) => {
  console.error('❌ Template render error:', err);
  res.status(500).send(`<pre>${err.stack}</pre>`);
});

/* ---------------------------------------
   Server Startup
--------------------------------------- */
const PORT = process.env.PORT || 3000;

async function startServer() {
  // Try to initialize database first
  await initializeDatabase();

  // If DB not available, keep your original warning behavior
  if (!dbConnectionEstablished) {
    console.warn('⚠️  WARNING: Starting server without database connection');
    console.warn('⚠️  Database-dependent features will be unavailable');

    // Add middleware to warn users on pages that need database
    app.use((req, res, next) => {
      if (
        req.path.includes('/admin') ||
        req.path.includes('/orders') ||
        req.path.includes('/users/dashboard')
      ) {
        req.flash('warning', 'Database is currently unavailable. Some features may not work.');
      }
      next();
    });
  }

  // Start the server
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(
      `📊 Database status: ${dbConnectionEstablished ? '✅ Connected' : '❌ Not connected'}`,
    );
    console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

startServer().catch((err) => {
  console.error('💀 Failed to start server:', err);
  console.error('💀 Server cannot start due to critical error');
  // Still don't use process.exit - just log and let the process naturally end
});
