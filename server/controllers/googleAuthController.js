const jwt = require('jsonwebtoken');
const { getGoogleAuthUrl, exchangeCodeForProfile } = require('../services/googleAuth');
const User = require('../models/User');

const TOKEN_EXPIRY = '7d';

function redirectToGoogle(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res
      .status(500)
      .send('Google sign-in is not configured on this server yet — GOOGLE_CLIENT_ID / GOOGLE_REDIRECT_URI missing from .env.');
  }

  res.redirect(getGoogleAuthUrl(clientId, redirectUri));
}

async function handleCallback(req, res) {
  const { code, error } = req.query;

  if (error) {
    return res.redirect(`/login?error=${encodeURIComponent('Google sign-in was cancelled.')}`);
  }
  if (!code) {
    return res.redirect(`/login?error=${encodeURIComponent('Missing authorization code from Google.')}`);
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.redirect(`/login?error=${encodeURIComponent('Google sign-in is not configured on this server yet.')}`);
  }

  try {
    const profile = await exchangeCodeForProfile(code, { clientId, clientSecret, redirectUri });

    if (!profile.email || !profile.email_verified) {
      return res.redirect(`/login?error=${encodeURIComponent('Could not verify your Google email address.')}`);
    }

    let user = await User.findByGoogleId(profile.sub);

    if (!user) {
      const existingByEmail = await User.findByEmail(profile.email);
      if (existingByEmail) {
        await User.linkGoogleId(existingByEmail.id, profile.sub);
        user = existingByEmail;
      } else {
        user = await User.createFromGoogle({ email: profile.email, googleId: profile.sub, fullName: profile.name });
      }
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });

    res.redirect(`/oauth-complete?token=${encodeURIComponent(token)}`);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect(`/login?error=${encodeURIComponent('Something went wrong signing in with Google. Please try again.')}`);
  }
}

module.exports = { redirectToGoogle, handleCallback };