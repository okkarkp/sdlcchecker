/**
 * PerfForge routes — native load testing + AI-driven performance exploration.
 * Live progress streams over the existing WebSocket as pf_* events.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const pf = require('../lib/perfforge');

// GET /api/perfforge/info — capabilities (browser + Claude key)
router.get('/info', (req, res) => res.json({ success: true, ...pf.info(), running: pf.manager.running }));

// POST /api/perfforge/run — native load test
router.post('/run', async (req, res) => {
  try { res.json({ ok: true, run: await pf.startNative(req.body || {}) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/perfforge/explore — AI exploration (+ optional auto load test)
// Body carries the AI provider + keys from Test Alchemist's ⚙ Settings
// (provider/model/anthropicApiKey/openaiApiKey/geminiApiKey/copilotToken).
router.post('/explore', async (req, res) => {
  try { res.json({ ok: true, run: await pf.startExplore({ ...req.body }) }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

// POST /api/perfforge/stop
router.post('/stop', (req, res) => { pf.manager.stop(); res.json({ ok: true }); });

// GET /api/perfforge/history
router.get('/history', (req, res) => res.json({ runs: pf.history() }));

// GET /api/perfforge/download/:id/samples.csv
router.get('/download/:id/samples.csv', (req, res) => {
  const file = path.join(pf.RUNS_DIR, req.params.id, 'samples.csv');
  if (!fs.existsSync(file)) return res.status(404).send('not found');
  res.download(file, `${req.params.id}_samples.csv`);
});

module.exports = router;
