const express      = require('express');
const router       = express.Router();
const sessionStore = require('../lib/session-store');

// GET /api/session/:clientId — load saved session
router.get('/:clientId', (req, res) => {
  const session = sessionStore.getSession((req.tenantId || req.params.clientId));
  if (!session) return res.json({ exists: false });
  res.json({ exists: true, session });
});

// PUT /api/session/:clientId — partial update (merge fields into existing session)
router.put('/:clientId', (req, res) => {
  try {
    const data = sessionStore.saveSession((req.tenantId || req.params.clientId), req.body);
    res.json({ success: true, session: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/session/:clientId — clear saved session
router.delete('/:clientId', (req, res) => {
  try {
    sessionStore.deleteSession((req.tenantId || req.params.clientId));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
