'use strict';
const express = require('express');
const router  = express.Router();
const db      = require('../lib/db');
const { randomUUID } = require('crypto');

// ── Generations ───────────────────────────────────────────────────────────────

// GET /api/history/generations?clientId=
router.get('/generations', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const rows = db.listGenerations(clientId);
  res.json({ success: true, generations: rows });
});

// GET /api/history/generations/:id?clientId=
router.get('/generations/:id', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const gen = db.getGeneration(req.params.id, clientId);
  if (!gen) return res.status(404).json({ error: 'Not found' });
  const scenarios  = db.parseRows(db.getScenariosForGeneration(req.params.id));
  const testcases  = db.parseRows(db.getTestCasesForGeneration(req.params.id));
  res.json({ success: true, generation: gen, scenarios, testcases });
});

// DELETE /api/history/generations/:id
router.delete('/generations/:id', (req, res) => {
  const clientId = req.body.clientId || req.query.clientId;
  db.deleteGeneration(req.params.id, clientId);
  res.json({ success: true });
});

// DELETE /api/history/generations/:id/test-cases — archive only test cases (keep generation + scenarios)
router.delete('/generations/:id/test-cases', (req, res) => {
  const clientId = req.body.clientId || req.query.clientId;
  db.archiveTestCasesForGeneration(req.params.id, clientId);
  res.json({ success: true });
});

// ── Scenarios ─────────────────────────────────────────────────────────────────

// GET /api/history/scenarios?generationId=
router.get('/scenarios', (req, res) => {
  const { generationId } = req.query;
  if (!generationId) return res.status(400).json({ error: 'generationId required' });
  const rows = db.parseRows(db.getScenariosForGeneration(generationId));
  res.json({ success: true, scenarios: rows });
});

// PATCH /api/history/scenarios/:id
router.patch('/scenarios/:id', (req, res) => {
  const { clientId, ...fields } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.updateScenario(req.params.id, clientId, fields);
  res.json({ success: true });
});

// ── Test Cases ────────────────────────────────────────────────────────────────

// GET /api/history/test-cases?generationId=
router.get('/test-cases', (req, res) => {
  const { generationId } = req.query;
  if (!generationId) return res.status(400).json({ error: 'generationId required' });
  const rows = db.parseRows(db.getTestCasesForGeneration(generationId));
  res.json({ success: true, testcases: rows });
});

// GET /api/history/test-cases/:id?clientId=
router.get('/test-cases/:id', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const tc = db.parseRow(db.getTestCase(req.params.id, clientId));
  if (!tc) return res.status(404).json({ error: 'Not found' });
  res.json({ success: true, testcase: tc });
});

// PATCH /api/history/test-cases/:id
router.patch('/test-cases/:id', (req, res) => {
  const { clientId, ...fields } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.updateTestCase(req.params.id, clientId, fields);
  res.json({ success: true });
});

// ── Import endpoints ──────────────────────────────────────────────────────────
// POST /api/history/scenarios/import
// Body: { clientId, title, scenarios: [{id,title,module,priority,description,tags,acceptance_criteria}] }
router.post('/scenarios/import', (req, res) => {
  try {
    const { clientId, title, scenarios, generationId } = req.body;
    if (!clientId)          return res.status(400).json({ error: 'clientId required' });
    if (!Array.isArray(scenarios) || !scenarios.length)
                            return res.status(400).json({ error: 'scenarios array required' });

    // Reuse existing generation or create a new one
    const genTitle = title || `Imported Scenarios ${new Date().toLocaleDateString()}`;
    const genId    = generationId || db.saveGeneration({ clientId, title: genTitle });
    db.saveScenarios(genId, clientId, scenarios);

    const saved = db.parseRows(db.getScenariosForGeneration(genId));
    res.json({ success: true, generationId: genId, scenarios: saved });
  } catch (err) {
    console.error('[Import Scenarios]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/history/test-cases/import
// Body: { clientId, title, testcases: [{id,title,module,priority,steps,preconditions,expected_result,...}] }
router.post('/test-cases/import', (req, res) => {
  try {
    const { clientId, title, testcases, generationId } = req.body;
    if (!clientId)         return res.status(400).json({ error: 'clientId required' });
    if (!Array.isArray(testcases) || !testcases.length)
                           return res.status(400).json({ error: 'testcases array required' });

    // Reuse existing generation or create a new one
    const genTitle = title || `Imported Test Cases ${new Date().toLocaleDateString()}`;
    const genId    = generationId || db.saveGeneration({ clientId, title: genTitle });
    db.saveTestCases(genId, clientId, testcases);

    const saved = db.parseRows(db.getTestCasesForGeneration(genId));
    res.json({ success: true, generationId: genId, testcases: saved });
  } catch (err) {
    console.error('[Import TCs]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
