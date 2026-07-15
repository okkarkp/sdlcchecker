const express = require('express');
const router  = express.Router();
const { orchestrator, subAgents } = require('../agents');

function extractOpts(body) {
  const { provider, model, anthropicApiKey, openaiApiKey, geminiApiKey, copilotToken } = body;
  return { provider, model, anthropicApiKey, openaiApiKey, geminiApiKey, copilotToken };
}

// GET /api/agents — status of all agents
router.get('/', (req, res) => {
  res.json({
    success:      true,
    orchestrator: orchestrator.toJSON(),
    agents:       subAgents.map(a => a.toJSON()),
  });
});

// POST /api/agents/reset — force-reset orchestrator + all sub-agents to idle
router.post('/reset', (req, res) => {
  orchestrator.status     = 'idle';
  orchestrator.startedAt  = null;
  orchestrator.finishedAt = null;
  orchestrator.lastError  = null;
  orchestrator.log        = [];
  subAgents.forEach(a => {
    a.status     = 'idle';
    a.startedAt  = null;
    a.finishedAt = null;
    a.lastError  = null;
  });
  global.broadcast?.({ type: 'agent_status' });
  res.json({ success: true, message: 'All agents reset to idle' });
});

// POST /api/agents/orchestrate — run full E2E orchestration
router.post('/orchestrate', async (req, res) => {
  const opts  = extractOpts(req.body);
  const input = { ...req.body };
  ['provider','model','anthropicApiKey','openaiApiKey','geminiApiKey','copilotToken'].forEach(k => delete input[k]);

  try {
    const result = await orchestrator.run(input, opts);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message, log: orchestrator.log });
  }
});

// POST /api/agents/:id/run — run a single sub-agent by id
router.post('/:id/run', async (req, res) => {
  const agent = subAgents.find(a => a.id === req.params.id);
  if (!agent) return res.status(404).json({ error: `Agent '${req.params.id}' not found` });

  const opts  = extractOpts(req.body);
  const input = { ...req.body };
  ['provider','model','anthropicApiKey','openaiApiKey','geminiApiKey','copilotToken'].forEach(k => delete input[k]);

  try {
    const result = await agent.run(input, opts);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
