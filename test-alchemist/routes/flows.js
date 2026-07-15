'use strict';
const express = require('express');
const https   = require('https');
const router  = express.Router();
const axios   = require('axios');
const db      = require('../lib/db');
const { callAI } = require('../providers');

// Bypass self-signed / corporate proxy certificates (same as jira.js)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Figma API helper with automatic retry on 429 (rate limit)
async function figmaGet(url, params, figmaToken, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(url, {
        headers: { 'X-Figma-Token': figmaToken },
        httpsAgent,
        timeout: 60000,
        params,
      });
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < maxRetries) {
        // Respect Retry-After header but cap at 30s to avoid absurd waits
        const rawRetry = parseInt(err.response?.headers?.['retry-after'] || '0', 10);
        const delay = rawRetry > 0 ? Math.min(rawRetry * 1000, 30000) : attempt * 10000;
        console.log(`[Figma] 429 rate limited — retrying in ${delay / 1000}s (attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (status === 403) throw Object.assign(new Error('Figma token invalid or file not accessible. Regenerate your token at figma.com/developers.'), { status: 403 });
      if (status === 404) throw Object.assign(new Error('Figma file not found. Check the URL and ensure it\'s shared with the token owner.'), { status: 404 });
      if (status === 429) throw Object.assign(new Error('Figma API rate limit reached — your token may be temporarily blocked. Try again in a few minutes or generate a new Personal Access Token at figma.com/developers.'), { status: 429 });
      throw err;
    }
  }
}

// Extract AI provider opts from any request body
function extractAiOpts(body) {
  return {
    provider:        body.provider,
    model:           body.model,
    anthropicApiKey: body.anthropicApiKey,
    openaiApiKey:    body.openaiApiKey,
    geminiApiKey:    body.geminiApiKey,
    copilotToken:    body.copilotToken,
  };
}

// GET /api/flows
router.get('/', (req, res) => {
  const { clientId } = req.query;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  res.json({ success: true, flows: db.getAppFlows(clientId) });
});

// POST /api/flows
router.post('/', (req, res) => {
  const { clientId, name, module, description, steps, source } = req.body;
  if (!clientId || !name) return res.status(400).json({ error: 'clientId + name required' });
  const id = db.saveAppFlow({ clientId, name, module, description, steps, source });
  res.json({ success: true, id });
});

// PATCH /api/flows/:id
router.patch('/:id', (req, res) => {
  const { clientId, ...fields } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.updateAppFlow(req.params.id, clientId, fields);
  res.json({ success: true });
});

// DELETE /api/flows/:id
router.delete('/:id', (req, res) => {
  const clientId = req.body.clientId || req.query.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  db.deleteAppFlow(req.params.id, clientId);
  res.json({ success: true });
});

// POST /api/flows/from-figma  — AI extracts flow from Figma URL or description
router.post('/from-figma', async (req, res) => {
  const { clientId, figmaUrl, description: userDesc } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  const aiOpts = extractAiOpts(req.body);

  const prompt = `You are a QA architect analyzing a Figma design or app description.
${figmaUrl ? `Figma URL: ${figmaUrl}` : ''}
${userDesc ? `App/Feature description: ${userDesc}` : ''}

Extract the main user flow as ordered steps. Return ONLY this JSON:
{
  "name": "Flow name (e.g. Transfer of Shares)",
  "module": "Module code or feature name",
  "description": "One-line description",
  "steps": [
    {
      "title": "Step name (2-3 words)",
      "description": "What the user does or sees",
      "rule": "Key validation rule or note (optional, null if none)",
      "tc_count": 0
    }
  ]
}
Keep steps to 3-8 max. Return ONLY the JSON.`;

  try {
    const data = await callAI(prompt, 2048, aiOpts);
    res.json({ success: true, flow: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/flows/figma-pages ──────────────────────────────────────────────
// Step 1: fetch only page names + IDs using depth=1 (very fast, no frame data).
router.post('/figma-pages', async (req, res) => {
  const body = req.body || {};
  const figmaFileUrl = body.figmaFileUrl || body.figma_file_url || body.url || '';
  if (!figmaFileUrl) return res.status(400).json({ error: 'figmaFileUrl required' });

  const keyMatch = figmaFileUrl.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9_-]+)/);
  if (!keyMatch) return res.status(400).json({ error: 'Invalid Figma URL.' });
  const fileKey = keyMatch[1];

  const figmaToken = body.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
  if (!figmaToken) return res.status(400).json({ error: 'Figma Access Token not configured. Add it in ⚙ Settings → Figma or set FIGMA_ACCESS_TOKEN in .env' });

  try {
    // depth=1 → returns only document + pages (no frames), very fast even for huge files
    const file  = await figmaGet(`https://api.figma.com/v1/files/${fileKey}`, { depth: 1 }, figmaToken);
    const pages = (file.document?.children || [])
      .filter(p => p.type === 'CANVAS')
      .map(p => ({ id: p.id, name: p.name }));
    res.json({ success: true, fileName: file.name, fileKey, pages });
  } catch (err) {
    const code = err.status || err.response?.status;
    if (code === 403) return res.status(403).json({ error: err.message });
    if (code === 404) return res.status(404).json({ error: err.message });
    if (code === 429) return res.status(429).json({ error: err.message });
    return res.status(500).json({ error: `Figma API error: ${err.message}` });
  }
});

// ── POST /api/flows/from-figma-file ──────────────────────────────────────────
// Step 2: fetch ONLY selected pages via /nodes endpoint (not the whole file),
// then generate one App Flow per page using AI in parallel.
router.post('/from-figma-file', async (req, res) => {
  req.socket.setTimeout(300000);
  res.setTimeout(300000);

  const body = req.body || {};
  const clientId     = body.clientId;
  const saveDirect   = body.saveDirect;
  const selectedPages = body.selectedPages;
  const fileName     = body.fileName;

  // Accept fileKey directly OR derive it from a figmaFileUrl
  let fileKey = body.fileKey;
  if (!fileKey && body.figmaFileUrl) {
    const m = body.figmaFileUrl.match(/figma\.com\/(?:file|design|proto)\/([A-Za-z0-9_-]+)/);
    if (m) fileKey = m[1];
  }

  if (!clientId)     return res.status(400).json({ error: 'clientId required' });
  if (!fileKey)      return res.status(400).json({ error: 'fileKey required — re-run Fetch Pages and try again' });
  if (!Array.isArray(selectedPages) || !selectedPages.length)
                     return res.status(400).json({ error: 'selectedPages required' });

  const figmaToken = body.figmaToken || process.env.FIGMA_ACCESS_TOKEN;
  if (!figmaToken) return res.status(400).json({ error: 'Figma Access Token not configured. Add it in ⚙ Settings → Figma or set FIGMA_ACCESS_TOKEN in .env' });

  const aiOpts = {
    provider:        req.body.provider,
    model:           req.body.model,
    anthropicApiKey: req.body.anthropicApiKey,
    openaiApiKey:    req.body.openaiApiKey,
    geminiApiKey:    req.body.geminiApiKey,
    copilotToken:    req.body.copilotToken,
  };

  // ── Fetch pages one at a time using depth=1 (just frame names, minimal data) ─
  // Batching all IDs in one call causes 429; one small call per page is safer.
  const FIGMA_DELAY = 1500; // ms between Figma API calls
  const pages = [];

  for (const { id: pageId, name: pageName } of selectedPages) {
    try {
      const nodesRes = await figmaGet(
        `https://api.figma.com/v1/files/${fileKey}/nodes`,
        { ids: pageId, depth: 1 }, // depth=1: page node + direct frame children only
        figmaToken
      );
      const node   = nodesRes.nodes?.[pageId]?.document;
      const frames = (node?.children || [])
        .filter(n => ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'GROUP'].includes(n.type))
        .map(n => n.name)
        .filter(Boolean)
        .slice(0, 25);
      if (frames.length > 0) pages.push({ name: pageName, frames });
    } catch (err) {
      const code = err.status || err.response?.status;
      if (code === 403) return res.status(403).json({ error: err.message });
      if (code === 429) return res.status(429).json({ error: err.message });
      console.warn(`[Figma] Skipping page "${pageName}":`, err.message);
    }
    // Pause between each page fetch to respect rate limits
    await new Promise(r => setTimeout(r, FIGMA_DELAY));
  }

  if (!pages.length) return res.status(400).json({ error: 'No frames found in the selected pages.' });

  // ── AI generation — 2 at a time with pause between batches ──────────────
  const CONCURRENCY = 2;
  const results = [];
  for (let i = 0; i < pages.length; i += CONCURRENCY) {
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    const batch = pages.slice(i, i + CONCURRENCY);
    const batchRes = await Promise.allSettled(
      batch.map(async ({ name: pageName, frames }) => {
        const prompt = `You are a QA architect analysing a Figma design file.
File: "${fileName || fileKey}"
Page: "${pageName}"
Screens/frames:
${frames.map((f, idx) => `  ${idx + 1}. ${f}`).join('\n')}

Convert into a structured app flow. 3–8 steps max.
Return ONLY valid JSON (no markdown):
{
  "name": "Short flow name",
  "module": "Module code (e.g. SHARES, ENTITY, BILLING)",
  "description": "One-line description",
  "steps": [
    { "title": "2-4 word title", "description": "What user does/sees", "rule": null, "tc_count": 0 }
  ]
}`;
        const data = await callAI(prompt, 1200, aiOpts);
        return { page: pageName, flow: data };
      })
    );
    results.push(...batchRes);
  }

  const flows  = results.filter(r => r.status === 'fulfilled').map(r => r.value);
  const errors = results.filter(r => r.status === 'rejected').map((r, i) => ({ page: pages[i]?.name, error: r.reason?.message }));

  if (!flows.length) return res.status(500).json({ error: 'No flows could be generated.', errors });

  // ── Bulk-save to DB ───────────────────────────────────────────────────────
  if (saveDirect) {
    for (const { flow } of flows) {
      try {
        db.saveAppFlow({ clientId, name: flow.name, module: flow.module, description: flow.description, steps: flow.steps || [], source: 'figma' });
      } catch (_) {}
    }
  }

  res.json({ success: true, fileName: fileName || fileKey, flows, errors, saved: saveDirect ? flows.length : 0 });
});

module.exports = router;
