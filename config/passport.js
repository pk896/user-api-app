// config/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

const GOOGLE_CALLBACK_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://my-express-server-rq4a.onrender.com/auth/google/callback'
    : 'http://localhost:3000/auth/google/callback';

passport.use(new GoogleStrategy(
  {
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: GOOGLE_CALLBACK_URL,
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails?.[0]?.value?.toLowerCase();
      if (!email) return done(new Error("Google account has no email"), null);

      let user = await User.findOne({ email });

      if (!user) {
        const random = crypto.randomBytes(16).toString('hex');
        const passwordHash = await bcrypt.hash(random, 12);
        user = await User.create({
          name: profile.displayName || (profile.name?.givenName || "Google User"),
          email,
          passwordHash, // ✅ our schema
        });
      }

      return done(null, user);
    } catch (err) {
      return done(err, null);
    }
  }
));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;
