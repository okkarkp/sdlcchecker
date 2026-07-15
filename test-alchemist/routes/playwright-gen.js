const express = require('express');
const router = express.Router();
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const repoCtx = require('../lib/repo-context');

// ── GET /api/playwright/repo-status ───────────────────────────────────────────
// Returns whether the automation repo is accessible and what it contains
router.get('/repo-status', (req, res) => {
  // Accept dynamic repo path from query or use configured default
  const repoPath = req.query.repoPath || repoCtx.getRepoPath();

  // Update the module-level path if a new one was provided
  if (req.query.repoPath) {
    repoCtx.setRepoPath(req.query.repoPath);
  }

  const exists = repoCtx.repoExists(repoPath);
  if (!exists) {
    return res.json({ connected: false, path: repoPath });
  }
  try {
    // Auto-detect the page-objects folder so any project layout works.
    const pagesDirRel = repoCtx.getPageObjectsDir(repoPath);
    const specsDirRel = repoCtx.getSpecsDir();
    const pagesDir = path.join(repoPath, pagesDirRel);
    const testsDir = path.join(repoPath, specsDirRel);
    const promptFile = process.env.PROMPT_FILE || path.join('.github', 'copilot-instructions.md');
    const pageObjects = fs.existsSync(pagesDir)
      ? fs.readdirSync(pagesDir).filter(f => f.endsWith('.js') && !f.endsWith('.spec.js')).length
      : 0;
    const specs = fs.existsSync(testsDir) ? fs.readdirSync(testsDir).filter(f => f.endsWith('.spec.js')).length : 0;
    const hasPrompts = fs.existsSync(path.join(repoPath, promptFile));
    res.json({
      connected: true,
      path: repoPath,
      pageObjects,
      pageObjectsDir: pagesDirRel,
      specs,
      specsDir: specsDirRel,
      hasPrompts,
      message: `${pageObjects} page objects (${pagesDirRel}/) · ${specs} specs (${specsDirRel}/) · prompts ${hasPrompts ? 'loaded' : 'missing'}`,
    });
  } catch (err) {
    res.json({ connected: true, path: repoPath, error: err.message });
  }
});

// ── POST /api/playwright/download ─────────────────────────────────────────────
// Receives generated file objects and streams a ZIP back to the client.
router.post('/download', (req, res) => {
  try {
    const { files = [], projectName = 'playwright-tests' } = req.body;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${projectName}.zip"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(res);

    // Add the base playwright config if not already in the file list
    const hasCfg = files.some((f) => f.path.includes('playwright.config'));
    if (!hasCfg) {
      archive.append(playwrightConfigContent(), { name: 'playwright.config.ts' });
    }

    archive.append(basePageContent(), { name: 'pages/BasePage.ts' });
    archive.append(baseFixtureContent(), { name: 'fixtures/base.ts' });

    for (const file of files) {
      archive.append(file.content, { name: file.path });
    }

    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/playwright/save ──────────────────────────────────────────────────
// Saves generated files to the local playwright-tests/ directory.
router.post('/save', (req, res) => {
  try {
    const { files = [] } = req.body;
    const base = path.join(__dirname, '..', 'playwright-tests', 'generated');
    fs.mkdirSync(base, { recursive: true });

    const saved = [];
    for (const file of files) {
      const fullPath = path.join(base, file.path);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, file.content, 'utf-8');
      saved.push(file.path);
    }

    res.json({ success: true, saved, directory: 'playwright-tests/generated/' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/playwright/run ──────────────────────────────────────────────────
// Saves generated files to the automation repo and runs them.
// Streams stdout/stderr back via WebSocket as pw_run_line events.
router.post('/run', (req, res) => {
  const { files = [], clientId = 'anon' } = req.body;
  if (!files.length) return res.status(400).json({ error: 'No files to run' });

  const repoPath = repoCtx.getRepoPath();
  const repoOk   = repoCtx.repoExists(repoPath);

  // Where to save & run from
  const baseDir = repoOk ? repoPath : path.join(__dirname, '..', 'playwright-tests', 'generated');

  res.json({ success: true, message: 'Run started — watch the terminal below' });

  const bc = (msg) => global.broadcastTo(clientId, msg);
  const line = (text, level = 'output') => bc({ type: 'pw_run_line', level, text });

  setImmediate(async () => {
    const specPaths = [];

    try {
      line('📁 Saving files…', 'info');
      for (const f of files) {
        if (!f.path || !f.content) continue;
        const dest = path.join(baseDir, f.path);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, f.content, 'utf8');
        line(`  ✓ saved: ${f.path}`, 'info');
        if (f.path.match(/\.spec\.(js|ts)$/)) specPaths.push(f.path);
      }

      if (!specPaths.length) {
        line('⚠  No .spec.js files found to run', 'warn');
        bc({ type: 'pw_run_done', success: false, error: 'No spec files' });
        return;
      }

      const cmd  = 'npx';
      const args = ['playwright', 'test', ...specPaths, '--project=chromium', '--reporter=line'];
      line(`\n▶  ${cmd} ${args.join(' ')}\n`, 'info');

      const child = spawn(cmd, args, {
        cwd: baseDir,
        shell: true,
        env: { ...process.env, NODE_TLS_REJECT_UNAUTHORIZED: '0', FORCE_COLOR: '0' },
      });

      child.stdout.on('data', d => d.toString().split('\n').forEach(l => l.trim() && line(l)));
      child.stderr.on('data', d => d.toString().split('\n').forEach(l => l.trim() && line(l, 'error')));

      child.on('close', code => {
        const ok = code === 0;
        line(ok ? '\n✅  All tests passed!' : `\n❌  Tests failed (exit ${code})`, ok ? 'success' : 'error');
        bc({ type: 'pw_run_done', success: ok, exitCode: code, specPaths });
      });

      child.on('error', err => {
        line(`❌  Spawn error: ${err.message}`, 'error');
        bc({ type: 'pw_run_done', success: false, error: err.message });
      });

    } catch (err) {
      line(`❌  ${err.message}`, 'error');
      bc({ type: 'pw_run_done', success: false, error: err.message });
    }
  });
});

// ── Template helpers ───────────────────────────────────────────────────────────
function playwrightConfigContent() {
  return `import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || 'https://your-app.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  ],
});
`;
}

function basePageContent() {
  return `import { Page, Locator, expect } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async navigate(path = '') {
    await this.page.goto(path);
  }

  async waitForPageLoad() {
    await this.page.waitForLoadState('networkidle');
  }

  async getTitle() {
    return this.page.title();
  }

  async clickElement(locator: string | Locator) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.waitFor({ state: 'visible' });
    await el.click();
  }

  async fillInput(locator: string | Locator, value: string) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await el.waitFor({ state: 'visible' });
    await el.fill(value);
  }

  async expectVisible(locator: string | Locator) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await expect(el).toBeVisible();
  }

  async expectText(locator: string | Locator, text: string) {
    const el = typeof locator === 'string' ? this.page.locator(locator) : locator;
    await expect(el).toContainText(text);
  }

  async expectUrl(urlPattern: string | RegExp) {
    await expect(this.page).toHaveURL(urlPattern);
  }

  async takeScreenshot(name: string) {
    await this.page.screenshot({ path: \`test-results/screenshots/\${name}.png\`, fullPage: true });
  }
}
`;
}

function baseFixtureContent() {
  return `import { test as base } from '@playwright/test';

type TestFixtures = {
  // Add shared fixtures here
};

export const test = base.extend<TestFixtures>({});
export { expect } from '@playwright/test';
`;
}

module.exports = router;
