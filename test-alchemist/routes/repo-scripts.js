'use strict';
/**
 * routes/repo-scripts.js — browse & run the EXISTING Playwright specs in the linked
 * automation repo, and locate per-test PDF evidence for the Jira upload.
 *
 *   GET  /api/repo-scripts?repoPath=…           — list spec files in the repo
 *   POST /api/repo-scripts/run                  — run one spec IN THE REPO (npx playwright
 *                                                 test, headed), streaming output over WS
 *   GET  /api/repo-scripts/evidence?…           — latest PDF in Executionscreenshots that
 *                                                 matches a test-case name
 *
 * Runs use the repo's OWN Playwright config / fixtures / node_modules (cwd = repo), so a
 * spec behaves exactly as it does in the user's suite.
 */
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { spawn } = require('child_process');
const router  = express.Router();

// Folder (repo-relative) where the suite drops per-test PDF evidence.
const EVIDENCE_DIR = process.env.EXECUTION_EVIDENCE_DIR || 'Executionscreenshots';

// Active runs per client so we don't launch two at once.
const runs = new Map();

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.pwlib-runs', '.pwlib-reports', 'Executionscreenshots']);

// Recursively collect *.spec.js / *.spec.ts (and *.test.*) under a repo, capped.
function listSpecs(repoRoot, max = 800) {
  const out = [];
  const walk = (dir) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) break;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(abs); continue; }
      if (/\.(spec|test)\.(js|ts|mjs)$/i.test(e.name)) {
        const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
        out.push({
          path: rel,
          name: e.name,
          module: e.name.replace(/\.(spec|test)\.(js|ts|mjs)$/i, ''),
          dir: path.dirname(rel),
        });
      }
    }
  };
  walk(repoRoot);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// Resolve a path and ensure it stays inside the repo (no traversal).
function safeInside(repoRoot, rel) {
  const root = path.resolve(repoRoot);
  const dest = path.resolve(root, rel);
  return (dest === root || dest.startsWith(root + path.sep)) ? dest : null;
}

// Newest PDF in <repo>/Executionscreenshots whose filename matches a test-case name.
// Matching is fuzzy (normalised contains, either direction); ties broken by mtime.
function findLatestEvidence(repoRoot, testName) {
  const dir = path.join(repoRoot, EVIDENCE_DIR);
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => /\.pdf$/i.test(f))
      .map(f => { const abs = path.join(dir, f); return { f, abs, mtime: fs.statSync(abs).mtimeMs }; });
  } catch { return null; }
  if (!files.length) return null;

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const key = norm(testName);
  let pool = files;
  if (key) {
    const matched = files.filter(x => { const n = norm(x.f); return n.includes(key) || key.includes(n.replace(/\.pdf$/, '')); });
    if (matched.length) pool = matched;
  }
  pool.sort((a, b) => b.mtime - a.mtime);   // latest first
  return pool[0] ? { path: pool[0].abs, filename: pool[0].f, rel: path.join(EVIDENCE_DIR, pool[0].f) } : null;
}

// ── GET /api/repo-scripts — list specs in the linked repo ─────────────────────
router.get('/', (req, res) => {
  const repoPath = req.query.repoPath || process.env.AUTOMATION_REPO_PATH || '';
  if (!repoPath) return res.status(400).json({ error: 'repoPath required — link the automation repo first' });
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: `Repo path not found: ${repoPath}` });
  try {
    const scripts = listSpecs(repoPath);
    res.json({ success: true, repoPath, count: scripts.length, scripts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/repo-scripts/evidence — latest PDF matching a test name ──────────
router.get('/evidence', (req, res) => {
  const { repoPath, testName } = req.query;
  if (!repoPath) return res.status(400).json({ error: 'repoPath required' });
  const ev = findLatestEvidence(repoPath, testName || '');
  res.json({ success: true, evidence: ev });
});

// ── POST /api/repo-scripts/run — run a spec in the repo (headed), stream output ─
router.post('/run', (req, res) => {
  const { repoPath, specPath, clientId = 'anon', testName = '' } = req.body;
  if (!repoPath || !specPath) return res.status(400).json({ error: 'repoPath and specPath required' });
  if (!fs.existsSync(repoPath)) return res.status(404).json({ error: `Repo path not found: ${repoPath}` });

  const specAbs = safeInside(repoPath, specPath);
  if (!specAbs || !fs.existsSync(specAbs)) return res.status(400).json({ error: `Spec not found in repo: ${specPath}` });

  if (runs.get(clientId)) return res.status(409).json({ error: 'A script is already running — wait for it to finish or Stop it' });
  runs.set(clientId, { stopping: false });   // placeholder until the proc is created

  res.json({ success: true, message: 'Run started — watch the terminal below' });

  const bc   = (msg) => global.broadcastTo(clientId, msg);
  const line = (text, level = 'output') => bc({ type: 'repo_run_line', specPath, level, text });

  setImmediate(() => {
    line(`▶  Running ${specPath} in ${repoPath} (headed)`, 'info');
    // Use the repo's own Playwright via npx (its config, fixtures, node_modules).
    // Force HEADED several ways so it shows regardless of how the repo configures it:
    //   --headed                → overrides config `use.headless` for the test runner
    //   HEADLESS=false / HEADED=1 / PWHEADED=1 → for repos that launch the browser
    //                             themselves in a fixture and read these env vars
    //   CI unset, workers=1      → avoid CI-mode forcing headless; one visible window
    const proc = spawn('npx', ['playwright', 'test', specPath, '--headed', '--workers=1', '--reporter=line'], {
      cwd:   repoPath,
      shell: true,   // needed so npx(.cmd) resolves on Windows
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        HEADLESS:   'false',
        HEADED:     '1',
        PWHEADED:   '1',
        PLAYWRIGHT_HEADED: '1',
        CI: '',          // some configs force headless when CI is set
      },
    });
    runs.set(clientId, { proc, specPath, stopping: false });

    proc.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && line(l)));
    proc.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && line(l, 'error')));

    proc.on('close', (code) => {
      const wasStopped = runs.get(clientId)?.stopping;
      runs.delete(clientId);
      if (wasStopped) {
        line('⏹  Stopped by user', 'warn');
        bc({ type: 'repo_run_done', specPath, success: false, stopped: true });
        return;
      }
      const ok = code === 0;
      line('', 'output');
      line(ok ? '✅  Spec passed' : `❌  Spec failed (exit ${code})`, ok ? 'success' : 'error');
      const evidence = findLatestEvidence(repoPath, testName || path.basename(specPath));
      if (evidence) line(`📄  Evidence PDF: ${evidence.rel}`, 'success');
      else line(`⚠  No matching PDF found in ${EVIDENCE_DIR}/`, 'warn');
      bc({ type: 'repo_run_done', specPath, success: ok, exitCode: code, evidence });
    });

    proc.on('error', (err) => {
      runs.delete(clientId);
      line(`❌  Spawn error: ${err.message}`, 'error');
      bc({ type: 'repo_run_done', specPath, success: false, error: err.message });
    });
  });
});

// Kill the whole process tree. npx is spawned via a shell, which then spawns node +
// the browser, so proc.kill() alone often leaves children running — use taskkill /T on
// Windows; a negative-pid signal isn't reliable without detached, so fall back to kill.
function killTree(proc) {
  if (!proc || proc.killed) return;
  if (process.platform === 'win32' && proc.pid) {
    try { spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: false }); return; } catch {}
  }
  try { proc.kill('SIGKILL'); } catch {}
}

// ── POST /api/repo-scripts/stop — stop the running spec for this client ───────
router.post('/stop', (req, res) => {
  const clientId = req.body.clientId || 'anon';
  const run = runs.get(clientId);
  if (!run || !run.proc) return res.json({ success: true, stopped: false, message: 'Nothing running' });
  run.stopping = true;             // flagged so the close handler reports "Stopped by user"
  killTree(run.proc);
  res.json({ success: true, stopped: true });
});

module.exports = router;
