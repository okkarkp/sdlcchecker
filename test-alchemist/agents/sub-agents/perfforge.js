/**
 * PerfForge — standalone performance-testing agent.
 * AI-driven exploration of an app to find slow pages/APIs, plus native load
 * testing. Kicks off a run (streamed live over WS as pf_* events) and returns
 * the run id. Not part of "Run All Agents" — the orchestrator calls agents by
 * name, so adding this to the registry only exposes it for standalone use.
 */
const BaseAgent = require('../base-agent');
const pf = require('../../lib/perfforge');

class PerfForgeAgent extends BaseAgent {
  constructor() {
    super('perfforge', 'PerfForge',
      'AI-driven performance testing — explore an app, find slow pages & APIs, then load-test them.',
      '⚡');
  }

  async execute(input, opts = {}) {
    // opts carries the AI provider + keys from Test Alchemist's settings
    // (provider, model, anthropicApiKey, openaiApiKey, geminiApiKey, copilotToken).
    const cfg = { ...input, ...opts };
    if (input.mode === 'native') return pf.startNative(cfg);
    return pf.startExplore(cfg);  // default: AI exploration (+ auto load test)
  }
}

module.exports = new PerfForgeAgent();
