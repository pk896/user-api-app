// config/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');

const GOOGLE_CALLBACK_URL =
  process.env.NODE_ENV === 'production'
    ? 'https://my-express-server-rq4a.onrender.com/auth/google/callback'
    : 'http://localhost:3000/auth/google/callback';

/**
 * Helper to read Google email + verified flag safely
 */
function extractGoogleEmail(profile) {
  const emailObj = Array.isArray(profile.emails) && profile.emails.length > 0
    ? profile.emails[0]
    : null;

  const email = emailObj?.value ? String(emailObj.value).toLowerCase().trim() : null;

  // Google may give "verified" either on emails[0].verified or on _json.email_verified
  const emailVerified =
    emailObj?.verified === true ||
    profile._json?.email_verified === true;

  return { email, emailVerified };
}

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const displayName =
          profile.displayName ||
          profile.name?.givenName ||
          profile.name?.familyName ||
          'Google User';

        const { email, emailVerified } = extractGoogleEmail(profile);

        if (!googleId) return done(new Error('Google profile has no id'), null);
        if (!email) return done(new Error('Google account has no email'), null);

        // 1) First try by googleId
        let user = await User.findOne({ googleId });

        // 2) If not found by googleId, try linking by email (ONLY if that account is not already tied to another googleId)
        if (!user) {
          user = await User.findOne({ email });

          // If an account exists with this email but already has a DIFFERENT googleId, refuse to link.
          if (user && user.googleId && user.googleId !== googleId) {
            return done(
              new Error('This email is already linked to a different Google account.'),
              null,
            );
          }
        }

        if (user) {
          let changed = false;

          // Ensure googleId is set
          if (!user.googleId) {
            user.googleId = googleId;
            changed = true;
          }

          // Provider adjustments
          // local -> both (now linked)
          // google -> google (still ok)
          // both -> both
          if (!user.provider) {
            user.provider = 'local';
            changed = true;
          }

          if (user.provider === 'local') {
            user.provider = 'both';
            changed = true;
          }

          // Trust Google's email verification if we don't yet have a verified email
          if (!user.isEmailVerified && emailVerified) {
            user.isEmailVerified = true;
            user.emailVerificationToken = null;
            user.emailVerificationExpires = null;
            changed = true;
          }

          // Optional: keep name updated if you want
          if (!user.name && displayName) {
            user.name = displayName;
            changed = true;
          }

          if (changed) await user.save();
          return done(null, user);
        }

        // 3) Create a new Google-based account
        try {
          const newUser = await User.create({
            name: displayName,
            email,
            googleId,
            provider: 'google',
            passwordHash: null,
            isEmailVerified: !!emailVerified,
          });

          return done(null, newUser);
        } catch (e) {
          // If email/googleId unique index triggers due to race condition:
          if (e && e.code === 11000) {
            // Try again: fetch by googleId or email
            const existing = (await User.findOne({ googleId })) || (await User.findOne({ email }));
            if (existing) return done(null, existing);
          }
          throw e;
        }
      } catch (err) {
        console.error('[GoogleStrategy] Error:', err);
        return done(err, null);
      }
    }
  ),
);

// Passport session glue – only used for Google flow (you use custom sessions for local)
passport.serializeUser((user, done) => {
  done(null, user._id.toString());
});

passport.deserializeUser(async (id, done) => {
  try {
    const user = await User.findById(id);
    done(null, user || null);
  } catch (err) {
    done(err, null);
  }
});

module.exports = passport;
