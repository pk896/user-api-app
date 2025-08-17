const express = require('express');
const session = require('express-session');
const path = require('path');
const app = express();

require('dotenv').config();
const mongoose = require('mongoose');

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');
})
  .catch(err => console.error('❌ MongoDB connection error:', err));


// allow Express to read form data (from <form>)
app.use(express.urlencoded({ extended: true }));

// Middleware to parse JSON bodies
app.use(express.json());

// static file serving
app.use(express.static('public'));

// serve dinamic html templates in views
app.set('view engine', 'ejs');

// middleware to log every request and log the time of the request
app.use((req, res, next) => {
  console.log(`${req.method} request to ${req.url}`);
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Session middleware
app.use(session({
  secret: process.env.SESSION_SECRET, // change this to a strong secret in production
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 } // 1 hour
}));

// --- Routes ---
const usersRouter = require('./routes/users');
app.use('/users', usersRouter);

// Health check endpoint (optional, good for Render)
app.get('/healthz', (req, res) => res.status(200).send('ok'));


// Always start server, even if DB fails
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));
