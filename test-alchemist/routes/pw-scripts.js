/**
 * routes/pw-scripts.js — Standalone Playwright Script Library
 *
 * Scripts are global (no client_id) — visible across ALL sessions.
 *
 * Generation uses Playwright Codegen:
 *   npx playwright codegen --output <tmpfile> <url>
 *   Headed Chrome + Inspector open on the user's machine.
 *   When the user closes the browser, the recorded script is written to
 *   tmpfile, read by the server, saved to SQLite, and broadcast via WS.
 *
 * Routes:
 *   GET    /api/pw-scripts            list all scripts (meta only)
 *   GET    /api/pw-scripts/:id        get one script including full content
 *   POST   /api/pw-scripts            launch codegen → save recorded script
 *   PUT    /api/pw-scripts/:id        update script content (manual edit)
 *   DELETE /api/pw-scripts/:id        delete
 *   POST   /api/pw-scripts/:id/run    run via Playwright CLI, stream via WS
 */
'use strict';

const express    = require('express');
const router     = express.Router();
const path       = require('path');
const fs         = require('fs');
const os         = require('os');
const { spawn }  = require('child_process');
const db         = require('../lib/db');
const PDFDocument = require('pdfkit');
const repoCtx    = require('../lib/repo-context');
const { convertRecordingToRepoScripts } = require('../lib/browser-agent');

const APP_ROOT     = path.join(__dirname, '..');
const REPORTS_DIR  = path.join(APP_ROOT, '.pwlib-reports');

// In-memory map of scriptId → latest PDF path (cleared on restart)
const _pdfCache = new Map();

// ── Inject page.screenshot() after every action / assertion ──────────────────
// Matches ALL of these patterns from Playwright codegen output:
//   await page.goto(...)
//   await page.getByRole(...).click()
//   await page.locator(...).fill(...)
//   await page.getByText(...).check()
//   await expect(page).toHaveTitle(...)
//   await expect(page.locator(...)).toBeVisible()
//   await page.keyboard.press(...)
function injectScreenshots(script, ssDir) {
  const ssFixed = ssDir.replace(/\\/g, '/');
  let step = 0;

  return script.split('\n').map(line => {
    const trimmed = line.trim();

    // Must be a complete statement that starts with await and ends with ;
    // Must involve page interaction OR an assertion
    const isAction =
      trimmed.startsWith('await ') &&
      trimmed.endsWith(';') &&
      (
        trimmed.includes('page.')   ||   // any page method
        trimmed.includes('expect(')      // any assertion
      ) &&
      // Skip pure screenshot injections themselves (avoid double-injecting)
      !trimmed.includes('page.screenshot(');

    if (isAction) {
      step++;
      const indent = line.match(/^(\s*)/)[1];
      const img = `${ssFixed}/step-${String(step).padStart(3, '0')}.png`;
      return `${line}\n${indent}await page.screenshot({ path: '${img}', fullPage: true }).catch(()=>{});`;
    }
    return line;
  }).join('\n');
}

// ── PDF generation from a screenshots directory ──────────────────────────────
async function buildPdf(scriptId, screenshotDir, tcTitle) {
  try {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });

    // Collect all PNG/JPEG screenshots Playwright wrote
    const imgs = fs.readdirSync(screenshotDir)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .map(f => path.join(screenshotDir, f))
      .sort();

    if (!imgs.length) return null;

    const pdfPath = path.join(REPORTS_DIR, `${scriptId}-${Date.now()}.pdf`);
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: false, margin: 20 });
      const out  = fs.createWriteStream(pdfPath);
      doc.pipe(out);

      // Cover page
      doc.addPage({ size: 'A4' });
      doc.font('Helvetica-Bold').fontSize(18).fillColor('#1a1a1a')
        .text('Playwright Execution Report', { align: 'center' });
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(12).fillColor('#555')
        .text(`Test: ${tcTitle}`, { align: 'center' });
      doc.fontSize(10).fillColor('#888')
        .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
      doc.moveDown(1);
      doc.fontSize(11).fillColor('#333')
        .text(`${imgs.length} screenshot${imgs.length !== 1 ? 's' : ''} captured during execution.`, { align: 'center' });

      // One page per screenshot
      imgs.forEach((imgPath, i) => {
        doc.addPage({ size: 'A4', margin: 20 });
        doc.font('Helvetica').fontSize(9).fillColor('#888')
          .text(`Screenshot ${i + 1} / ${imgs.length}  ·  ${path.basename(imgPath)}`, 0, 20, { align: 'right' });

        // Fit image to page width while keeping aspect ratio
        try {
          const pageW = doc.page.width  - 40;
          const pageH = doc.page.height - 60;
          doc.image(imgPath, 20, 35, { fit: [pageW, pageH], align: 'center', valign: 'top' });
        } catch {}
      });

      doc.end();
      out.on('finish', resolve);
      out.on('error', reject);
    });

    return pdfPath;
  } catch (e) {
    console.warn('[pwLib] PDF generation failed:', e.message);
    return null;
  }
}

// ── GET /api/pw-scripts ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    res.json({ success: true, scripts: db.listPwScripts(req.tenantId || 'default') });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pw-scripts/testcases — all TCs from ALL sessions/generations ─────
// Used to populate the TC selector in the Script Library.
// Must be defined BEFORE /:id so "testcases" isn't treated as an id param.
router.get('/testcases', (req, res) => {
  try {
    const T = req.tenantId;   // set when auth enabled → scope to workspace
    const sql = `
      SELECT t.id, t.tc_id, t.title, t.module,
             g.title  AS gen_title,
             g.app_name
      FROM   test_case t
      JOIN   generation g ON g.id = t.generation_id
      WHERE  t.status != 'archived'${T ? ' AND t.client_id = ?' : ''}
      ORDER  BY t.created_at DESC
      LIMIT  500`;
    const rows = T ? db.db.prepare(sql).all(T) : db.db.prepare(sql).all();
    res.json({ success: true, testcases: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/pw-scripts/:id ───────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const row = db.getPwScript(req.params.id, req.tenantId || 'default');
  if (!row) return res.status(404).json({ error: 'Script not found' });
  res.json({ success: true, script: row });
});

// ── POST /api/pw-scripts ──────────────────────────────────────────────────────
// Launches Playwright Codegen on the server machine.
// The user records interactions in the headed browser, then closes it.
// The --output file is read, saved to SQLite, and broadcast via WebSocket.
//
// Body: { tcId?, tcTitle, module?, baseUrl?, clientId? }
router.post('/', (req, res) => {
  const {
    tcId,
    tcTitle,
    module: mod,
    baseUrl   = '',
    clientId  = 'anon',
    jiraTestKey = '',
    executionKey = '',
  } = req.body;

  if (!tcTitle) return res.status(400).json({ error: 'tcTitle is required' });

  const tmpFile = path.join(os.tmpdir(), `pwlib-codegen-${Date.now()}.js`);
  const bc      = msg => global.broadcastTo(clientId, msg);

  // Respond immediately — codegen runs until user closes browser
  res.json({ success: true, message: 'Playwright Codegen launched — record your flow then close the browser' });

  bc({ type: 'pw_lib_codegen_status', status: 'recording', tcTitle });

  // Launch Playwright Codegen using the local playwright-core CLI and system Chrome.
  // Flags:  -b chromium --channel chrome  → uses installed system Chrome (avoids
  //         needing npx to download Playwright's bundled Chromium browser).
  //         --target playwright-test      → generates @playwright/test format
  //         -o <file>                     → write script on browser close
  // Use the FULL playwright package CLI (it ships the recorder/Inspector UI) with the
  // BUNDLED, version-matched Chromium — NOT playwright-core + system Chrome, which causes
  // the recorder window to stay blank/spinning then close when the Chrome version doesn't
  // match. Bundled Chromium is already installed and matched to the playwright version.
  const PW_CLI = path.join(APP_ROOT, 'node_modules', 'playwright', 'cli.js');
  // Open codegen directly at the app URL so the user never has to paste it. Fall back to
  // APP_BASE_URL. Only pass a URL arg when we have one (an empty arg opens about:blank).
  const launchUrl = (baseUrl || process.env.APP_BASE_URL || '').trim();
  const codegenArgs = [
    PW_CLI, 'codegen',
    '--target', 'playwright-test',
    '-o', tmpFile,
  ];
  if (launchUrl) codegenArgs.push(launchUrl);
  const proc = spawn('node', codegenArgs, {
    cwd:   APP_ROOT,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],   // capture stderr for error reporting
    env:   { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  });

  let stderrBuf = '';
  if (proc.stderr) proc.stderr.on('data', d => {
    const txt = d.toString();
    stderrBuf += txt;
    // Stream codegen diagnostics live so a launch/navigation failure is visible.
    txt.split('\n').forEach(l => l.trim() && bc({ type: 'pw_lib_codegen_log', text: l.trim().slice(0, 300) }));
  });
  bc({ type: 'pw_lib_codegen_log', text: launchUrl ? `Opening codegen at ${launchUrl}` : 'Opening codegen (no start URL — blank page)' });

  proc.on('error', err => {
    bc({ type: 'pw_lib_codegen_done', success: false, error: `Failed to launch codegen: ${err.message}` });
  });

  proc.on('close', code => {
    // Read the output file written by codegen on browser close
    let script = '';
    try {
      if (fs.existsSync(tmpFile)) {
        script = fs.readFileSync(tmpFile, 'utf8').trim();
        fs.unlinkSync(tmpFile);
      }
    } catch {}

    if (!script) {
      const errMsg = stderrBuf.trim().slice(0, 300) || 'No script recorded — close Playwright Codegen only after recording your steps.';
      bc({ type: 'pw_lib_codegen_done', success: false, error: errMsg });
      return;
    }

    // Wrap in a named test() block if codegen produced raw statements
    if (!script.includes('test(') && !script.includes('test.describe(')) {
      script = `const { test, expect } = require('@playwright/test');\n\ntest('${tcTitle}', async ({ page }) => {\n${
        script.split('\n').map(l => '  ' + l).join('\n')
      }\n});\n`;
    }

    const id    = db.savePwScript({ tcId: tcId || null, tcTitle, module: mod || '', script, jiraTestKey, executionKey, tenantId: req.tenantId || 'default' });
    const saved = db.getPwScript(id, req.tenantId || 'default');

    bc({ type: 'pw_lib_codegen_done', success: true, script: saved });
  });
});

// ── PUT /api/pw-scripts/:id ───────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const { script } = req.body;
  if (!script) return res.status(400).json({ error: 'script content required' });
  const T = req.tenantId || 'default';
  const row = db.getPwScript(req.params.id, T);
  if (!row) return res.status(404).json({ error: 'Script not found' });
  db.updatePwScript(req.params.id, script, T);
  res.json({ success: true });
});

// ── DELETE /api/pw-scripts/:id ────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  db.deletePwScript(req.params.id, req.tenantId || 'default');
  res.json({ success: true });
});

// ── POST /api/pw-scripts/:id/run ─────────────────────────────────────────────
// Both the spec file and the throw-away config are written inside APP_ROOT so
// that require('@playwright/test') resolves against the local node_modules.
// The temp sub-folder .pwlib-runs/ is created on first use and cleaned after
// each run.
router.post('/:id/run', (req, res) => {
  const { id } = req.params;
  const { clientId = 'anon' } = req.body;

  const row = db.getPwScript(id, req.tenantId || 'default');
  if (!row) return res.status(404).json({ error: 'Script not found' });

  // Write files inside APP_ROOT so require('@playwright/test') resolves correctly
  const ts      = Date.now();
  const runDir  = path.join(APP_ROOT, '.pwlib-runs');
  fs.mkdirSync(runDir, { recursive: true });

  const specFile = path.join(runDir, `pwlib-${id.slice(0, 8)}-${ts}.spec.js`);
  const cfgFile  = path.join(runDir, `pwlib-cfg-${ts}.js`);
  const PW_CLI   = path.join(APP_ROOT, 'node_modules', '@playwright', 'test', 'cli.js');

  // Screenshots go directly into this flat directory (no subdirs)
  const screenshotDir = path.join(runDir, `screenshots-${id.slice(0,8)}-${ts}`);
  fs.mkdirSync(screenshotDir, { recursive: true });

  // Inject page.screenshot() after every action in the script
  const injectedScript = injectScreenshots(row.script, screenshotDir);
  fs.writeFileSync(specFile, injectedScript, 'utf8');

  // Minimal config — no screenshot:'on' needed since we inject calls directly
  const runDirFwd = runDir.replace(/\\/g, '/');
  fs.writeFileSync(cfgFile,
    `const { defineConfig } = require('@playwright/test');\n` +
    `module.exports = defineConfig({\n` +
    `  testDir:  '${runDirFwd}',\n` +
    `  testMatch: '${path.basename(specFile)}',\n` +
    `  timeout:  90000,\n` +
    `  use: {\n` +
    `    channel:  'chrome',\n` +
    `    headless: false,\n` +
    `  },\n` +
    `});\n`,
    'utf8'
  );

  res.json({ success: true, message: 'Run started — watch the terminal below' });

  const bc   = msg  => global.broadcastTo(clientId, msg);
  const line = (text, level = 'output') => bc({ type: 'pw_lib_line', scriptId: id, level, text });

  const cleanup = () => {
    try { fs.unlinkSync(specFile); } catch {}
    try { fs.unlinkSync(cfgFile);  } catch {}
  };

  setImmediate(async () => {
    // Count injected screenshot steps
    const ssSteps = (injectedScript.match(/page\.screenshot\(/g) || []).length;
    line(`▶  Running: ${row.tc_title}`, 'info');
    line(`   📸 ${ssSteps} screenshot step${ssSteps !== 1 ? 's' : ''} injected into script`, 'info');
    line('', 'output');

    const proc = spawn('node', [PW_CLI, 'test', '--config', cfgFile, '--reporter=line'], {
      cwd:   APP_ROOT,
      shell: false,
      env:   { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', FORCE_COLOR: '0' },
    });

    proc.stdout.on('data', d =>
      d.toString().split('\n').forEach(l => l.trim() && line(l)));
    proc.stderr.on('data', d =>
      d.toString().split('\n').forEach(l => l.trim() && line(l, 'error')));

    proc.on('close', async code => {
      cleanup();
      const ok = code === 0;
      line('', 'output');
      line(ok ? '✅  All tests passed!' : `❌  Tests failed (exit ${code})`, ok ? 'success' : 'error');

      // Generate PDF from screenshots
      line('📄  Generating PDF report from screenshots…', 'info');
      const pdfPath = await buildPdf(id, screenshotDir, row.tc_title);

      // Clean up screenshot dir
      try { fs.rmSync(screenshotDir, { recursive: true, force: true }); } catch {}

      if (pdfPath) {
        _pdfCache.set(id, pdfPath);
        line(`📄  PDF ready — click Download PDF to save`, 'success');
        bc({ type: 'pw_lib_done', scriptId: id, success: ok, exitCode: code, hasPdf: true });
      } else {
        line('⚠  No screenshots captured — PDF not generated', 'warn');
        bc({ type: 'pw_lib_done', scriptId: id, success: ok, exitCode: code, hasPdf: false });
      }
    });

    proc.on('error', err => {
      cleanup();
      line(`❌  Spawn error: ${err.message}`, 'error');
      bc({ type: 'pw_lib_done', scriptId: id, success: false, error: err.message });
    });
  });
});

// ── GET /api/pw-scripts/:id/report — download the latest PDF report ──────────
router.get('/:id/report', (req, res) => {
  let pdfPath = _pdfCache.get(req.params.id);

  // If not in cache (e.g. after restart), try to find it on disk
  if (!pdfPath || !fs.existsSync(pdfPath)) {
    try {
      const files = fs.readdirSync(REPORTS_DIR)
        .filter(f => f.startsWith(req.params.id) && f.endsWith('.pdf'))
        .sort()
        .reverse(); // latest first
      if (files.length) {
        pdfPath = path.join(REPORTS_DIR, files[0]);
        _pdfCache.set(req.params.id, pdfPath);
      }
    } catch {}
  }

  if (!pdfPath || !fs.existsSync(pdfPath)) {
    return res.status(404).json({ error: 'No PDF report available — run the script first.' });
  }
  const row = db.getPwScript(req.params.id, req.tenantId || 'default');
  const name = (row?.tc_title || 'playwright-report').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-report.pdf"`);
  fs.createReadStream(pdfPath).pipe(res);
});

// ── POST /api/pw-scripts/:id/convert — convert a recorded script into repo format ──
// Runs the same repo-conversion the Agentic Automate flow uses, but on a saved codegen
// script. Merges into the per-module page/spec/data files in the connected repo.
router.post('/:id/convert', (req, res) => {
  const row = db.getPwScript(req.params.id, req.tenantId || 'default');
  if (!row) return res.status(404).json({ error: 'Script not found' });

  const clientId = req.body.clientId || 'anon';
  const repoPath = req.body.repoPath;
  if (repoPath) repoCtx.setRepoPath(repoPath);
  if (!repoCtx.repoExists(repoPath || repoCtx.getRepoPath())) {
    return res.status(400).json({ error: 'No automation repo connected — set the Codebase Path and Connect first' });
  }

  res.json({ success: true, message: 'Converting recorded script into repo format…' });

  const bc   = (msg) => global.broadcastTo(clientId, msg);
  const emit = (level, text) => bc({ type: 'agent_action', level, text });
  const aiOpts = {
    provider:        req.body.provider,
    model:           req.body.model,
    anthropicApiKey: req.body.anthropicApiKey,
    openaiApiKey:    req.body.openaiApiKey,
    geminiApiKey:    req.body.geminiApiKey,
    copilotToken:    req.body.copilotToken,
  };
  const testcase = {
    title:  row.tc_title,
    tc_id:  row.tc_id || row.tc_title,
    module: row.module || '',
    steps:  [],
    expected_result: '',
  };
  // No fixed credentials — recorded scripts carry their own login interactions; the data
  // columns are left for the project to fill. Keeps conversion project-agnostic.
  const creds      = { username: '', password: '' };
  const spIdentity = '';

  emit('start', `🛠 Converting recorded script "${row.tc_title}" into repo format…`);
  emit('progress', '   This is one AI code-gen call (page object + spec + data) — it can take 30–90s.');
  setImmediate(async () => {
    // Heartbeat so the run is visibly alive during the single long AI call.
    const t0 = Date.now();
    const hb = setInterval(() => emit('progress', `   ⏳ still generating… ${Math.round((Date.now() - t0) / 1000)}s`), 12000);
    try {
      const result = await convertRecordingToRepoScripts({
        testcase, rawScript: row.script, baseUrl: process.env.APP_BASE_URL || '',
        aiOpts, emit, creds, spIdentity, loginType: '',
      });
      clearInterval(hb);
      bc({ type: 'pw_lib_convert_done', scriptId: row.id, success: !!result,
           saved: result?.saved || [], repoPath: result?.repoPath || null });
    } catch (e) {
      clearInterval(hb);
      emit('error', `✗ Convert failed: ${e.message}`);
      bc({ type: 'pw_lib_convert_done', scriptId: row.id, success: false, error: e.message });
    }
  });
});

module.exports = router;
