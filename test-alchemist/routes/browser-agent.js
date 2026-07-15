'use strict';
const express             = require('express');
const router              = express.Router();
const { runBrowserAgent } = require('../lib/browser-agent');

// Active agent sessions: clientId → { running, startedAt }
const sessions = new Map();

// Pull the active AI provider + credentials from the request body so the agent
// follows whatever provider is selected in the header (Copilot / OpenAI / …).
function extractAiOpts(body = {}) {
  return {
    provider:        body.provider,
    model:           body.model,
    anthropicApiKey: body.anthropicApiKey,
    openaiApiKey:    body.openaiApiKey,
    geminiApiKey:    body.geminiApiKey,
    copilotToken:    body.copilotToken,
  };
}

// ── POST /api/browser-agent/automate ─────────────────────────────────────────
// Uses the active AI provider to generate a Playwright script for the TC's steps
// and runs it headed via the local Playwright runtime.
router.post('/automate', async (req, res) => {
  const { testcase, clientId, model } = req.body;
  if (!testcase) return res.status(400).json({ error: 'testcase required' });

  const cid = clientId || 'anon';
  if (sessions.get(cid)?.running) {
    return res.status(409).json({ error: 'Agent already running for this client — stop it first' });
  }

  sessions.set(cid, { running: true, startedAt: Date.now() });

  const aiOpts = extractAiOpts(req.body);
  const broadcastFn = (msg) => global.broadcastTo(cid, msg);
  broadcastFn({ type: 'agent_action', level: 'start', text: `▶ Automate Agent: ${testcase.title}` });

  // Respond immediately — progress streams via WebSocket
  res.json({ success: true, message: 'Agent started — watch the Execution Log for live updates' });

  const shouldStop = () => !sessions.get(cid)?.running;
  const repoPath = req.body.repoPath;
  const instruction = req.body.instruction;
  setImmediate(async () => {
    try {
      const result = await runBrowserAgent({ mode: 'automate', testcase, instruction, broadcastFn, aiOpts, shouldStop, repoPath });
      broadcastFn({
        type:    'agent_done',
        success: true,
        files:   result.files || [],
        message: `Browser automation complete${result.files?.length ? ` — ${result.files.length} file(s) saved` : ''}`,
      });
    } catch (err) {
      broadcastFn({ type: 'agent_done',   success: false, error: err.message });
      broadcastFn({ type: 'agent_action', level: 'error', text: `✗ ${err.message}` });
    } finally {
      sessions.delete(cid);
    }
  });
});

// ── POST /api/browser-agent/execute ──────────────────────────────────────────
// The active AI provider generates a Playwright script from a free-text prompt
// and runs it headed via the local Playwright runtime.
router.post('/execute', async (req, res) => {
  const { prompt, clientId } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });

  const cid = clientId || 'anon';
  if (sessions.get(cid)?.running) {
    return res.status(409).json({ error: 'Agent already running — stop it first' });
  }

  sessions.set(cid, { running: true, startedAt: Date.now() });

  const aiOpts = extractAiOpts(req.body);
  const broadcastFn = (msg) => global.broadcastTo(cid, msg);
  broadcastFn({
    type:  'agent_action',
    level: 'start',
    text:  `▶ Browser Agent: "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`,
  });

  res.json({ success: true, message: 'Browser agent started — watch the Execution Log' });

  const shouldStop = () => !sessions.get(cid)?.running;
  setImmediate(async () => {
    try {
      await runBrowserAgent({ mode: 'execute', prompt, broadcastFn, aiOpts, shouldStop });
      broadcastFn({ type: 'agent_done', success: true, message: 'Browser flow complete' });
    } catch (err) {
      broadcastFn({ type: 'agent_done',   success: false, error: err.message });
      broadcastFn({ type: 'agent_action', level: 'error', text: `✗ ${err.message}` });
    } finally {
      sessions.delete(cid);
    }
  });
});

// ── POST /api/browser-agent/stop ─────────────────────────────────────────────
router.post('/stop', (req, res) => {
  const cid = req.body.clientId || 'anon';
  sessions.delete(cid);
  global.broadcastTo(cid, { type: 'agent_action', level: 'warn', text: '⏹ Agent stopped by user' });
  global.broadcastTo(cid, { type: 'agent_done', success: false, message: 'Stopped' });
  res.json({ success: true });
});

// ── GET /api/browser-agent/status ────────────────────────────────────────────
router.get('/status', (req, res) => {
  const cid = req.query.clientId || 'anon';
  const s   = sessions.get(cid);
  res.json({ running: !!s?.running, startedAt: s?.startedAt });
});

module.exports = router;
