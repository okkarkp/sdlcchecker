'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');

// GET /api/knowledge/stats?clientId=
router.get('/stats', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const stats = db.getKnowledgeStats(clientId);
  res.json({ success: true, ...stats });
});

// GET /api/knowledge?clientId=&module=
router.get('/', (req, res) => {
  const { clientId, module: mod } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const entries = db.listKnowledge(clientId, mod || null);
  res.json({ success: true, entries });
});

// POST /api/knowledge
router.post('/', (req, res) => {
  const { clientId, kind, module: mod, triggerText, guidance, sourceItemId, sourceItemType } = req.body;
  if (!clientId || !guidance) return res.status(400).json({ error: 'clientId + guidance required' });
  const id = db.saveKnowledgeEntry({ clientId, kind, module: mod, triggerText, guidance, sourceItemId, sourceItemType });
  res.json({ success: true, id });
});

// PATCH /api/knowledge/:id
router.patch('/:id', (req, res) => {
  const { clientId, ...fields } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.updateKnowledge(req.params.id, clientId, fields);
  res.json({ success: true });
});

// DELETE /api/knowledge/:id
router.delete('/:id', (req, res) => {
  const clientId = req.body.clientId || req.query.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.deleteKnowledge(req.params.id, clientId);
  res.json({ success: true });
});

// POST /api/knowledge/:id/bump — reinforce weight
router.post('/:id/bump', (req, res) => {
  const { clientId, delta = 0.5 } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.bumpKnowledgeWeight(req.params.id, clientId, delta);
  res.json({ success: true });
});

// POST /api/knowledge/:id/approve
router.post('/:id/approve', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.updateKnowledge(req.params.id, clientId, { status: 'approved' });
  res.json({ success: true });
});

// POST /api/knowledge/:id/reject — alias for delete
router.post('/:id/reject', (req, res) => {
  const { clientId } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.deleteKnowledge(req.params.id, clientId);
  res.json({ success: true });
});

module.exports = router;
