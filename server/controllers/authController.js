const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = '7d';

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: TOKEN_EXPIRY });
}

async function signup(req, res) {
  const { email, password, fullName } = req.body;

  if (!isValidEmail(email)) {
    return res.status(400).json({ success: false, error: 'A valid email is required' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ success: false, error: 'Password must be at least 8 characters' });
  }

  const existing = await User.findByEmail(email);
  if (existing) {
    return res.status(409).json({ success: false, error: 'An account with this email already exists' });
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const user = await User.create({ email, passwordHash, fullName });
  const token = signToken(user);

  res.status(201).json({ success: true, token, user });
}

async function login(req, res) {
  const { email, password } = req.body;

  if (!isValidEmail(email) || !password) {
    return res.status(400).json({ success: false, error: 'Email and password are required' });
  }

  const user = await User.findByEmail(email);
  if (!user) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }

  if (!user.password_hash) {
    return res.status(401).json({
      success: false,
      error: 'This account was created with Google sign-in and has no password. Use "Continue with Google" instead.'
    });
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ success: false, error: 'Invalid email or password' });
  }

  const token = signToken(user);
  const { password_hash, ...safeUser } = user;

  res.json({ success: true, token, user: safeUser });
}

module.exports = { signup, login };