/**
 * routes/twin.js — Digital Twin HTTP API
 *
 * POST /api/twin/crawl             — Start a crawl (config in body or saved). Async — streams via WS.
 * GET  /api/twin/status            — Twin meta summary
 * GET  /api/twin/pages             — List all crawled pages
 * GET  /api/twin/pages/:route      — Full context object for a route (route URL-encoded)
 * POST /api/twin/extract           — Run LLM extraction on a doc, merge into store
 * POST /api/twin/config            — Save crawl config (stored in twin_meta.config)
 * GET  /api/twin/config            — Get saved crawl config (passwords masked)
 * POST /api/twin/reset             — Soft-delete all twin rows
 * POST /api/twin/webhook/deploy    — Background re-crawl trigger; validates header secret
 *
 * NOTE: Like the rest of Test Alchemist, this is a local-only tool. Tokens/credentials
 * are stored in the SQLite DB on the user's own machine (the same posture as `.env`).
 * The webhook endpoint requires a configured secret; everything else assumes localhost trust.
 */
'use strict';

const express = require('express');
const router  = express.Router();

const { db, now } = require('../lib/db');
const { runCrawl, runGuidedCrawl, softDeleteAllTwinRows } = require('../lib/twin/crawler');
const { extractAndMerge, htmlToText }     = require('../lib/twin/extractor');
const { assembleTwinContext, listPages, getMeta } = require('../lib/twin/context');

// ── Crawl-state guard: prevent overlapping crawls ──────────────────────────────
let activeCrawl = null;   // { startedAt, clientId, baseUrl, mode, stop }

// ── Helpers ────────────────────────────────────────────────────────────────────
function getStoredConfig() {
  const row = db.prepare(`SELECT config FROM twin_meta WHERE id=1`).get();
  if (!row) return {};
  try { return JSON.parse(row.config || '{}'); } catch { return {}; }
}

function saveStoredConfig(config) {
  // upsert the config field on the singleton twin_meta row
  const existing = db.prepare(`SELECT id FROM twin_meta WHERE id=1`).get();
  if (existing) {
    db.prepare(`UPDATE twin_meta SET config=? WHERE id=1`).run(JSON.stringify(config));
  } else {
    db.prepare(`INSERT INTO twin_meta(id,config,crawled_at) VALUES(1,?,?)`).run(JSON.stringify(config), now());
  }
}

function maskCreds(cfg) {
  const c = JSON.parse(JSON.stringify(cfg || {}));
  if (c.credentials?.password) c.credentials.password = '••••••';
  if (c.webhookSecret) c.webhookSecret = '••••••';
  // Identity fields (UIN/UEN/UUID) are mock test values, not secrets — surfaced as-is
  // so the UI can re-populate them. Only the optional fallback password is masked.
  if (c.identity?.password) c.identity.password = '••••••';
  if (Array.isArray(c.roles)) {
    for (const r of c.roles) {
      if (r.credentials?.password) r.credentials.password = '••••••';
      if (r.identity?.password)    r.identity.password = '••••••';
    }
  }
  return c;
}

// ── POST /api/twin/crawl ─────────────────────────────────────────────────────
router.post('/crawl', async (req, res) => {
  if (activeCrawl) {
    return res.status(409).json({
      error: 'A crawl is already running',
      since: activeCrawl.startedAt,
      baseUrl: activeCrawl.baseUrl,
    });
  }

  const stored = getStoredConfig();
  const config = {
    ...stored,
    ...req.body,
    identity:    { ...(stored.identity || {}),    ...(req.body.identity || {}) },
    credentials: { ...(stored.credentials || {}), ...(req.body.credentials || {}) },
    clientId: req.body.clientId || 'anon',
  };
  if (!config.baseUrl) {
    return res.status(400).json({ error: 'baseUrl required (in body or saved config or APP_BASE_URL .env)' });
  }

  const guided = config.mode === 'guided';
  // Guided recording is driven by the user clicking Stop (or closing the browser).
  let stopRequested = false;
  activeCrawl = {
    startedAt: new Date().toISOString(),
    clientId: config.clientId,
    baseUrl: config.baseUrl,
    mode: guided ? 'guided' : 'auto',
    requestStop: () => { stopRequested = true; },
  };
  // Persist the current config (without overwriting credentials with masked values).
  // Don't persist transient guided-only fields (mode / moduleName / startRoute).
  const { mode, moduleName, startRoute, ...persistable } = req.body;
  saveStoredConfig({ ...stored, ...persistable });

  // Reply immediately — progress streams via WS (twin_progress / twin_done events)
  res.status(202).json({ accepted: true, mode: activeCrawl.mode, baseUrl: config.baseUrl, clientId: config.clientId });

  setImmediate(async () => {
    try {
      if (guided) await runGuidedCrawl(config, () => stopRequested);
      else        await runCrawl(config);
    } catch (e) {
      try {
        global.broadcastTo?.(config.clientId, { type: 'twin_progress', level: 'error', text: `✗ ${guided ? 'Recording' : 'Crawl'} failed: ${e.message}` });
        global.broadcastTo?.(config.clientId, { type: 'twin_done', error: e.message });
      } catch {}
    } finally {
      activeCrawl = null;
    }
  });
});

// ── POST /api/twin/stop ──────────────────────────────────────────────────────
// Signals a running (guided) crawl to finish and persist what's been captured.
router.post('/stop', (req, res) => {
  if (!activeCrawl) return res.json({ stopped: false, reason: 'no crawl running' });
  try { activeCrawl.requestStop?.(); } catch {}
  res.json({ stopped: true, mode: activeCrawl.mode });
});

// ── GET /api/twin/status ─────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const meta = getMeta();
  res.json({
    ...meta,
    crawling: !!activeCrawl,
    crawl_started_at: activeCrawl?.startedAt || null,
  });
});

// ── GET /api/twin/pages ──────────────────────────────────────────────────────
router.get('/pages', (req, res) => {
  res.json({ pages: listPages() });
});

// ── GET /api/twin/pages/:route ───────────────────────────────────────────────
// route is URL-encoded path (e.g. %2Flogin)
router.get('/pages/:route', (req, res) => {
  const route = decodeURIComponent(req.params.route || '');
  const role = req.query.role || null;
  const ctx = assembleTwinContext(route, { role });
  if (!ctx) return res.status(404).json({ error: `No twin page for route "${route}"` });
  res.json({ context: ctx });
});

// ── POST /api/twin/extract ───────────────────────────────────────────────────
router.post('/extract', async (req, res) => {
  const { text, html, source = 'manual', sourceUrl = '' } = req.body || {};
  if (!text && !html) return res.status(400).json({ error: 'Provide "text" or "html" in the request body' });

  const aiOpts = {
    provider:        req.body.provider,
    model:           req.body.model,
    anthropicApiKey: req.body.anthropicApiKey,
    openaiApiKey:    req.body.openaiApiKey,
    geminiApiKey:    req.body.geminiApiKey,
    copilotToken:    req.body.copilotToken,
  };

  try {
    const result = await extractAndMerge({ text, html, source, sourceUrl, aiOpts });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/twin/config ────────────────────────────────────────────────────
router.post('/config', (req, res) => {
  const config = req.body || {};
  saveStoredConfig({ ...getStoredConfig(), ...config });
  res.json({ saved: true, config: maskCreds(getStoredConfig()) });
});

// ── GET /api/twin/config ─────────────────────────────────────────────────────
router.get('/config', (req, res) => {
  res.json({ config: maskCreds(getStoredConfig()) });
});

// ── POST /api/twin/reset ─────────────────────────────────────────────────────
router.post('/reset', (req, res) => {
  softDeleteAllTwinRows();
  // Reset meta counts but keep the saved config so the next crawl is one click away
  const cfg = getStoredConfig();
  db.prepare(`DELETE FROM twin_meta WHERE id=1`).run();
  saveStoredConfig(cfg);
  res.json({ reset: true });
});

// ── POST /api/twin/webhook/deploy ────────────────────────────────────────────
// CI/CD-callable trigger. Validates the X-Webhook-Secret header against the secret
// configured in twin_meta.config.webhookSecret (set via POST /api/twin/config) or
// the TWIN_WEBHOOK_SECRET env var. Returns 202 immediately; runs the crawl in bg.
router.post('/webhook/deploy', (req, res) => {
  const stored = getStoredConfig();
  const expected = stored.webhookSecret || process.env.TWIN_WEBHOOK_SECRET || '';
  if (!expected) return res.status(503).json({ error: 'No webhook secret configured' });

  const provided = req.get('X-Webhook-Secret') || req.body?.secret || '';
  if (provided !== expected) return res.status(401).json({ error: 'Invalid webhook secret' });

  if (activeCrawl) {
    return res.status(202).json({ accepted: false, reason: 'crawl already in progress' });
  }

  res.status(202).json({ accepted: true });

  // Fire-and-forget background re-crawl with the stored config
  setImmediate(async () => {
    activeCrawl = { startedAt: new Date().toISOString(), clientId: stored.clientId || 'webhook', baseUrl: stored.baseUrl };
    try {
      await runCrawl({ ...stored, clientId: stored.clientId || 'webhook' });
    } catch (e) {
      console.error('[twin webhook] crawl failed:', e.message);
    } finally {
      activeCrawl = null;
    }
  });
});

module.exports = router;
