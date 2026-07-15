const express = require('express');
const router  = express.Router();
const auth    = require('../lib/auth');

// GET /api/auth/me — current auth state (unauthenticated-safe).
router.get('/me', (req, res) => {
  if (!auth.isAuthEnabled()) return res.json({ authEnabled: false, authenticated: true });
  const u = auth.currentUser(req);
  res.json({ authEnabled: true, authenticated: !!u, user: u ? { username: u.u, role: u.r } : null });
});

// POST /api/auth/login — verify credentials, set the session cookie.
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const token = auth.login(username, password);
  if (!token) return res.status(401).json({ error: 'Invalid username or password' });
  auth.setSessionCookie(res, token);
  res.json({ ok: true, user: { username } });
});

// POST /api/auth/logout — clear the session cookie.
router.post('/logout', (req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
