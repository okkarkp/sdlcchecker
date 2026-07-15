'use strict';
/**
 * routes/app-map.js — App Map API
 *
 * Endpoints:
 *   POST /api/app-map/crawl        — Crawl a live application
 *   POST /api/app-map/figma-upload  — Upload Figma JSON or images
 *   GET  /api/app-map/:clientId     — Get stored app map
 *   DELETE /api/app-map/:clientId   — Clear stored app map
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const { crawlApp, getAppMapContext }  = require('../lib/app-crawler');
const { parseFigmaJson, parseFigmaImages, getFigmaContext } = require('../lib/figma-parser');
const { callAI, callAIWithImages } = require('../providers');
const db = require('../lib/db');

// Multer config for Figma uploads
const upload = multer({
  dest: path.join(__dirname, '..', 'uploads', 'figma'),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max per file
  fileFilter: (req, file, cb) => {
    const allowed = ['.json', '.png', '.jpg', '.jpeg', '.svg', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// Multer error handler
function handleUpload(req, res, next) {
  upload.array('files', 30)(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large — max 500MB per file. Try compressing the PDF or splitting into smaller files.' });
      return res.status(400).json({ error: `Upload error: ${err.message}` });
    }
    next();
  });
}

// In-memory app map cache per client (also persisted to DB)
const appMapCache = new Map();

// ── POST /api/app-map/crawl ──────────────────────────────────────────────────
// In-flight crawl state keyed by clientId
const crawlControllers = new Map();

router.post('/crawl', async (req, res) => {
  let { baseUrl, clientId, options = {} } = req.body;
  if (!baseUrl) return res.status(400).json({ error: 'baseUrl required' });
  if (!clientId) return res.status(400).json({ error: 'clientId required' });

  // Auto-prepend https:// if no protocol
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;

  // Validate URL
  try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const broadcastFn = (msg) => global.broadcastTo(clientId, { ...msg, logStep: 'appmap' });

  // Create controller for stop signal
  const controller = { state: 'running' };
  crawlControllers.set(clientId, controller);

  // Respond immediately, stream progress via WS
  res.json({ success: true, message: 'Recording started — browser will open' });

  setImmediate(async () => {
    try {
      const appMap = await crawlApp(baseUrl, { ...options, _controller: controller }, broadcastFn);

      // Store in cache and DB
      appMapCache.set(clientId, appMap);
      saveAppMap(clientId, appMap);

      broadcastFn({
        type: 'crawl_done',
        success: true,
        summary: appMap.summary,
        totalPages: appMap.totalPages,
      });
    } catch (err) {
      console.error('[Crawl] Error:', err.message);
      broadcastFn({ type: 'crawl_done', success: false, error: err.message });
    } finally {
      crawlControllers.delete(clientId);
    }
  });
});

// ── POST /api/app-map/crawl-stop — Stop recording and save results ───────────
router.post('/crawl-stop', (req, res) => {
  const { clientId } = req.body;
  const ctrl = crawlControllers.get(clientId);
  if (ctrl) {
    ctrl.state = 'stopped';
    if (ctrl._stopResolve) { ctrl._stopResolve(); ctrl._stopResolve = null; }
    res.json({ success: true, message: 'Recording stopped — saving flows…' });
  } else {
    res.json({ success: false, message: 'No active recording session' });
  }
});

// ── POST /api/app-map/figma-upload ───────────────────────────────────────────
router.post('/figma-upload', handleUpload, async (req, res) => {
  req.socket.setTimeout(300000);
  res.setTimeout(300000);

  const clientId = req.body.clientId;
  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

  const aiOpts = {
    provider:        req.body.provider,
    model:           req.body.model,
    anthropicApiKey: req.body.anthropicApiKey,
    openaiApiKey:    req.body.openaiApiKey,
    geminiApiKey:    req.body.geminiApiKey,
    copilotToken:    req.body.copilotToken,
  };

  try {
    const jsonFiles = req.files.filter(f => f.originalname.endsWith('.json'));
    const imageFiles = req.files.filter(f => /\.(png|jpg|jpeg)$/i.test(f.originalname));
    const pdfFiles = req.files.filter(f => /\.pdf$/i.test(f.originalname));

    if (jsonFiles.length) {
      // Parse Figma JSON export
      const content = fs.readFileSync(jsonFiles[0].path, 'utf-8');
      const appMap = parseFigmaJson(content);
      appMap.sourceFile = jsonFiles[0].originalname;
      appMapCache.set(clientId, appMap);
      saveAppMap(clientId, appMap);
      req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(_) {} });
      return res.json({ success: true, totalPages: appMap.totalPages, source: 'figma-json', summary: appMap.summary });
    }

    if (!imageFiles.length && !pdfFiles.length) {
      return res.status(400).json({ error: 'Upload screen images (.png/.jpg), PDF, or JSON export' });
    }

    // ── Build images array from PNGs/JPGs and PDFs ─────────────────────────
    const images = imageFiles.map(f => ({
      base64: fs.readFileSync(f.path).toString('base64'),
      mimeType: f.originalname.match(/\.png$/i) ? 'image/png' : 'image/jpeg',
      name: f.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
    }));

    // For PDFs: send as document (Claude/Gemini support natively) or extract text
    const pdfDocuments = [];
    for (const f of pdfFiles) {
      pdfDocuments.push({
        base64: fs.readFileSync(f.path).toString('base64'),
        mimeType: 'application/pdf',
        name: f.originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' '),
      });
    }

    const basePrompt = `You are a QA architect analyzing UI designs/wireframes for test planning.

For each screen/page/section, identify:
- Screen/page name (from headers, navigation, or visual context)
- Forms and their input fields (labels, types, required indicators)
- Buttons and actions available
- Navigation elements
- Key UI elements and their purpose

Return ONLY valid JSON (no markdown, no code fences):
{
  "name": "Short app/feature flow name",
  "module": "Module name (e.g. Authentication, Dashboard, User Management, Orders)",
  "description": "One-line description of what this flow covers",
  "steps": [
    { "title": "2-4 word screen/page name", "description": "What is on this screen — forms, buttons, fields, key elements visible", "rule": null, "tc_count": 0 }
  ]
}

Rules:
- Create one step per distinct screen/page/section
- Title should be the page/screen name (e.g. "Login Page", "User Dashboard", "Create Order")
- Description should list available interactions: forms with field names, buttons, dropdowns, tables, etc.
- If you detect validation rules (required fields, format hints), put them in "rule"
- Module should be a single category that best describes the overall flow`;

    let flow;

    // ── Strategy: images go via vision; PDFs are chunked for text-based analysis ──
    if (images.length && !pdfDocuments.length) {
      // Pure image upload — use vision
      const prompt = `${basePrompt}\n\nI'm uploading ${images.length} screen(s) from a UI design. Analyze ALL screens. 3-15 steps max.`;
      try {
        flow = await callAIWithImages(prompt, images, 4096, aiOpts);
      } catch (visionErr) {
        console.warn('[FigmaUpload] Vision failed:', visionErr.message);
        const fileList = imageFiles.map(f => f.originalname).join(', ');
        const textPrompt = `${basePrompt}\n\nI uploaded these UI screenshots but vision is not available: ${fileList}\nBased on file names, create a reasonable app flow. Each file is a screen.`;
        flow = await callAI(textPrompt, 4096, aiOpts);
      }
    } else if (pdfDocuments.length) {
      // PDF upload — extract text, process in chunks, merge
      flow = await processPdfInChunks(pdfDocuments, images, basePrompt, aiOpts);
    }

    if (!flow || !flow.steps?.length) {
      console.warn('[FigmaUpload] AI returned invalid flow:', JSON.stringify(flow)?.slice(0, 500));
      throw new Error('AI could not analyze the files — try clearer screenshots, a different provider, or ensure the PDF contains UI wireframes');
    }

    // Save as a single app flow
    const existingFlows = db.getAppFlows(clientId).filter(f => f.source === 'figma-upload');
    existingFlows.forEach(f => db.deleteAppFlow(f.id, clientId));

    db.saveAppFlow({
      clientId,
      name: flow.name || 'Figma Flow',
      module: flow.module || 'General',
      description: flow.description || `Analyzed from ${images.length} screenshot(s)`,
      steps: flow.steps,
      source: 'figma-upload',
    });

    // Clean up temp files
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(_) {} });

    res.json({
      success: true,
      totalPages: flow.steps.length,
      source: 'figma-images',
      flow,
      saved: true,
    });
  } catch (err) {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch(_) {} });
    res.status(500).json({ error: `Figma analysis failed: ${err.message}` });
  }
});

// ── GET /api/app-map/:clientId ───────────────────────────────────────────────
router.get('/:clientId', (req, res) => {
  const { clientId } = req.params;
  const appMap = appMapCache.get(clientId) || loadAppMap(clientId);
  if (!appMap) return res.json({ success: true, appMap: null });
  res.json({ success: true, appMap });
});

// ── GET /api/app-map/:clientId/context ───────────────────────────────────────
// Returns the compact text context for injection into AI prompts
router.get('/:clientId/context', (req, res) => {
  const { clientId } = req.params;
  const appMap = appMapCache.get(clientId) || loadAppMap(clientId);
  if (!appMap) return res.json({ success: true, context: '' });

  const context = appMap.source?.includes('figma')
    ? getFigmaContext(appMap)
    : getAppMapContext(appMap);

  res.json({ success: true, context });
});

// ── DELETE /api/app-map/:clientId ────────────────────────────────────────────
router.delete('/:clientId', (req, res) => {
  const { clientId } = req.params;
  appMapCache.delete(clientId);
  deleteAppMap(clientId);
  res.json({ success: true });
});

// ── PDF chunked processing ───────────────────────────────────────────────────
// Split large PDFs into manageable chunks, process each with AI, merge results
async function processPdfInChunks(pdfDocuments, images, basePrompt, aiOpts) {
  const pdfParse = require('pdf-parse');
  const provider = aiOpts.provider || 'copilot';

  // First try: send PDF directly via vision (Claude/Gemini/OpenAI support native PDF)
  // Always attempt vision first — many PDFs are image-based wireframes with no extractable text
  try {
    const allMedia = [...images, ...pdfDocuments];
    const prompt = `${basePrompt}\n\nI'm uploading PDF document(s) with UI wireframes/flows. Analyze ALL pages and create steps for every distinct screen/page/section. No limit on steps — capture everything.`;
    const flow = await callAIWithImages(prompt, allMedia, 8192, aiOpts);
    if (flow?.steps?.length) return flow;
    console.warn('[FigmaUpload] Native PDF vision returned no steps, trying text extraction...');
  } catch (err) {
    console.warn('[FigmaUpload] Native PDF vision failed, falling back to text extraction:', err.message);
  }

  // Fallback: extract text and process in chunks
  let fullText = '';
  for (const doc of pdfDocuments) {
    const data = await pdfParse(Buffer.from(doc.base64, 'base64'));
    fullText += `\n=== ${doc.name} ===\n${data.text}\n`;
  }

  // Check if extracted text is mostly empty (image-based PDF)
  const meaningfulText = fullText.replace(/[\s\n\r=]/g, '').length;
  if (meaningfulText < 100) {
    console.warn(`[FigmaUpload] PDF has no extractable text (${meaningfulText} chars). Image-based PDF — converting pages to images...`);

    // Convert PDF pages to images and retry via vision
    try {
      const { pdf } = await import('pdf-to-img');
      const convertedImages = [...images];
      for (const doc of pdfDocuments) {
        const pdfBuffer = Buffer.from(doc.base64, 'base64');
        let pageNum = 0;
        const maxPages = 20;
        for await (const pageImage of pdf(pdfBuffer, { scale: 1.5 })) {
          pageNum++;
          if (pageNum > maxPages) break;
          convertedImages.push({
            base64: pageImage.toString('base64'),
            mimeType: 'image/png',
            name: `${doc.name} - Page ${pageNum}`,
          });
        }
        console.log(`[FigmaUpload] Converted ${doc.name}: ${Math.min(pageNum, maxPages)} page(s) to PNG`);
      }

      if (convertedImages.length) {
        const prompt = `${basePrompt}\n\nI'm uploading ${convertedImages.length} screenshot(s) from PDF wireframes/UI designs. Analyze ALL screens. Create steps for every distinct page/section.`;
        const flow = await callAIWithImages(prompt, convertedImages, 8192, aiOpts);
        if (flow?.steps?.length) return flow;
      }
    } catch (convErr) {
      console.warn('[FigmaUpload] PDF-to-image conversion failed:', convErr.message);
    }

    throw new Error(
      'This PDF is image-based (wireframes/mockups) with no extractable text. ' +
      'PDF-to-image conversion was attempted but analysis failed. ' +
      'Try using Claude or Gemini provider, or export wireframes as PNG screenshots.'
    );
  }

  // Split text into chunks of ~30K chars (allows room for prompt + response)
  const CHUNK_SIZE = 30000;
  const chunks = [];
  for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
    chunks.push(fullText.slice(i, i + CHUNK_SIZE));
  }

  console.log(`[FigmaUpload] Processing PDF: ${fullText.length} chars in ${chunks.length} chunk(s)`);
  console.log(`[FigmaUpload] PDF text preview: ${fullText.slice(0, 500)}`);

  // Process each chunk — collect steps from all
  const allSteps = [];
  let flowName = '';
  let flowModule = '';
  let flowDesc = '';

  for (let i = 0; i < chunks.length; i++) {
    const chunkPrompt = `${basePrompt}

This is part ${i + 1} of ${chunks.length} of a PDF document containing UI wireframes/functional specifications.
${i > 0 ? `Previous sections already identified these pages: ${allSteps.map(s => s.title).join(', ')}. Do NOT repeat them.` : ''}

Analyze this section and extract ALL distinct screens/pages/flows. No limit on steps — capture every page and form.

Document content (Part ${i + 1}/${chunks.length}):
${chunks[i]}`;

    try {
      const partial = await callAI(chunkPrompt, 4096, aiOpts);
      console.log(`[FigmaUpload] Chunk ${i + 1}/${chunks.length} response:`, JSON.stringify(partial)?.slice(0, 300));
      if (partial?.steps?.length) {
        allSteps.push(...partial.steps);
        if (!flowName && partial.name) flowName = partial.name;
        if (!flowModule && partial.module) flowModule = partial.module;
        if (!flowDesc && partial.description) flowDesc = partial.description;
      } else if (typeof partial === 'string') {
        // AI returned raw text — try to extract steps
        console.warn(`[FigmaUpload] Chunk ${i + 1} returned string, not JSON object`);
      }
    } catch (err) {
      console.warn(`[FigmaUpload] Chunk ${i + 1}/${chunks.length} failed:`, err.message);
    }
  }

  if (!allSteps.length) return null;

  // Deduplicate steps by title
  const seen = new Set();
  const dedupedSteps = allSteps.filter(s => {
    const key = (s.title || '').toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    name: flowName || 'Document Flow',
    module: flowModule || 'General',
    description: flowDesc || `Extracted from ${pdfDocuments.length} PDF(s) — ${dedupedSteps.length} screens`,
    steps: dedupedSteps,
  };
}

// ── DB persistence helpers ───────────────────────────────────────────────────
function saveAppMap(clientId, appMap) {
  try {
    // Delete old crawl-based flows to avoid duplicates
    const existingFlows = db.getAppFlows(clientId).filter(f => f.source === 'crawl');
    existingFlows.forEach(f => db.deleteAppFlow(f.id, clientId));

    const pages = (appMap.pages || []).filter(p => !p.error);
    if (!pages.length) return;

    // Derive a single module from the app's base URL or most common module
    const moduleName = deriveModuleFromApp(appMap.baseUrl, pages);

    // Build ONE flow — each page becomes a step
    const steps = [];
    for (const page of pages) {
      const pageName = page.title || derivePageName(page.url) || 'Page';

      // Build description: headings + forms + buttons + inputs
      const descParts = [];

      // Headings visible on the page
      if (page.headings?.length) {
        descParts.push(`Headings: ${page.headings.map(h => h.text).join(', ')}`);
      }

      // Forms with their fields
      if (page.forms?.length) {
        for (const form of page.forms) {
          const fieldNames = (form.fields || []).map(f => f.label || f.name || f.placeholder || f.type).filter(Boolean);
          const formLabel = form.submitButton ? `Form "${form.submitButton}"` : 'Form';
          descParts.push(`${formLabel}: ${fieldNames.join(', ') || 'no fields'}`);
        }
      }

      // Buttons / actions
      if (page.buttons?.length) {
        const actionButtons = page.buttons
          .filter(b => b.text && !b.text.match(/^(×|close|cancel|x)$/i))
          .map(b => b.text)
          .slice(0, 10);
        if (actionButtons.length) descParts.push(`Actions: ${actionButtons.join(', ')}`);
      }

      // Standalone inputs
      const allInputs = [...(page.inputs || []), ...(page.selects || []), ...(page.textareas || [])];
      if (allInputs.length) {
        const inputLabels = allInputs.map(i => i.label || i.name || i.placeholder || i.type).filter(Boolean);
        if (inputLabels.length) descParts.push(`Inputs: ${inputLabels.join(', ')}`);
      }

      steps.push({
        title: pageName,
        description: descParts.join('. ') || `Static page at ${page.url}`,
        rule: null,
        tc_count: 0,
      });
    }

    // Derive a flow name from the app
    const flowName = deriveFlowName(appMap.baseUrl, pages);

    db.saveAppFlow({
      clientId,
      name: flowName,
      module: moduleName,
      description: `Recorded ${pages.length} page(s) from ${appMap.baseUrl}`,
      steps,
      source: 'crawl',
    });
  } catch (err) {
    console.warn('[AppMap] Failed to persist:', err.message);
  }
}

function deriveFlowName(baseUrl, pages) {
  try {
    const host = new URL(baseUrl).hostname.replace('www.', '');
    // Use first meaningful path segment or hostname
    const path = new URL(baseUrl).pathname.split('/').filter(Boolean);
    if (path.length) return path[0].replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ' Flow';
    return host.split('.')[0].replace(/\b\w/g, c => c.toUpperCase()) + ' Flow';
  } catch { return 'Recorded Flow'; }
}

function deriveModuleFromApp(baseUrl, pages) {
  // Count module occurrences across all pages, pick the most frequent
  const moduleCounts = {};
  for (const page of pages) {
    const mod = deriveModule(page);
    moduleCounts[mod] = (moduleCounts[mod] || 0) + 1;
  }
  // Pick the most common module (excluding 'General' if others exist)
  const sorted = Object.entries(moduleCounts).sort((a, b) => b[1] - a[1]);
  const nonGeneral = sorted.filter(([m]) => m !== 'General');
  if (nonGeneral.length) return nonGeneral[0][0];
  // Fallback: derive from baseUrl hostname
  try {
    const host = new URL(baseUrl).hostname.replace('www.', '');
    return host.split('.')[0].replace(/\b\w/g, c => c.toUpperCase());
  } catch { return 'General'; }
}

function derivePageName(url) {
  try {
    const path = new URL(url).pathname.split('/').filter(Boolean);
    if (!path.length) return 'Home';
    return path[path.length - 1]
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  } catch { return 'Page'; }
}

function deriveModule(page) {
  const url = (page.url || '').toLowerCase();
  const title = (page.title || '').toLowerCase();
  if (url.includes('login') || title.includes('login') || title.includes('sign in')) return 'Authentication';
  if (url.includes('register') || title.includes('register') || title.includes('sign up')) return 'Registration';
  if (url.includes('dashboard') || title.includes('dashboard')) return 'Dashboard';
  if (url.includes('profile') || title.includes('profile')) return 'Profile';
  if (url.includes('settings') || title.includes('settings')) return 'Settings';
  if (url.includes('search') || title.includes('search')) return 'Search';
  if (url.includes('admin') || title.includes('admin')) return 'Admin';
  if (url.includes('report') || title.includes('report')) return 'Reports';
  // Derive from URL path
  try {
    const path = new URL(page.url).pathname.split('/').filter(Boolean);
    if (path.length >= 1) return path[0].charAt(0).toUpperCase() + path[0].slice(1);
  } catch {}
  return 'General';
}

function loadAppMap(clientId) {
  try {
    const entries = db.listKnowledge(clientId).filter(k => k.kind === 'app_map');
    if (!entries.length) return null;
    return JSON.parse(entries[0].guidance);
  } catch { return null; }
}

function deleteAppMap(clientId) {
  try {
    const entries = db.listKnowledge(clientId).filter(k => k.kind === 'app_map');
    entries.forEach(e => db.deleteKnowledge(e.id, clientId));
  } catch {}
}

module.exports = router;
