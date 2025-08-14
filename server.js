const express = require('express');
const session = require('express-session');
const path = require('path');
const app = express();

require('dotenv').config();
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('✅ Connected to MongoDB');

    // start the server only after connection
    app.listen(3000, () => {
      console.log('Server is running on http://localhost:3000');
    });
  })
  .catch(err => console.error('❌ MongoDB connection error:', err));

const usersRouter = require('./routes/users');

// allow Express to read form data (from <form>)
app.use(express.urlencoded({ extended: true }));

// Middleware to parse JSON bodies
app.use(express.json());

// static file serving
app.use(express.static('public'));

// serve dinamic html templates in views
app.set('view engine', 'ejs');

// middleware to log every request
app.use((req, res, next) => {
  console.log(`${req.method} request to ${req.url}`);
  next();
});

// middleware to log the time of the request
app.use((req, res, next) => {
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

// Use the users router for all routes starting with /users
app.use('/users', usersRouter);
