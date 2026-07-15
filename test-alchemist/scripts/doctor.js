#!/usr/bin/env node
/**
 * scripts/doctor.js — preflight health check.
 *
 * Turns silent setup failures into a clear checklist: Node version, the native
 * SQLite module, Playwright's browser, and which AI provider is configured.
 * Run before first use or when something isn't working:  npm run doctor
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let problems = 0, warnings = 0;

const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => { warnings++; console.log(`  \x1b[33m⚠\x1b[0m ${m}`); };
const bad  = (m) => { problems++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };

console.log('\n⚗️  Test Alchemist — doctor\n');

// 1. Node version
const major = Number(process.versions.node.split('.')[0]);
major >= 18 ? ok(`Node ${process.version}`) : bad(`Node ${process.version} — needs 18+`);

// 2. Dependencies installed
fs.existsSync(path.join(ROOT, 'node_modules'))
  ? ok('node_modules present')
  : bad('node_modules missing — run: npm install');

// 3. better-sqlite3 native module loads
try {
  require(path.join(ROOT, 'node_modules', 'better-sqlite3'));
  ok('better-sqlite3 native module loads');
} catch (e) {
  bad(`better-sqlite3 failed to load — run: npm rebuild better-sqlite3  (${String(e.message).slice(0, 60)})`);
}

// 4. Playwright browser (Chromium) installed
try {
  const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
  const exe = chromium.executablePath();
  fs.existsSync(exe)
    ? ok('Playwright Chromium installed')
    : warn('Playwright Chromium not installed — run: npm run install:playwright (needed for the browser agent)');
} catch {
  warn('Playwright not resolved — run: npm run install:playwright');
}

// 5. AI provider configured (env-level; the app also supports CLI/bridge at runtime)
require('dotenv').config({ path: path.join(ROOT, '.env') });
try { require(path.join(ROOT, 'lib', 'project-config')).loadProjectConfig(); } catch {}
const providers = [];
if (process.env.ANTHROPIC_API_KEY) providers.push('Claude (API key)');
if (process.env.OPENAI_API_KEY)    providers.push('OpenAI');
if (process.env.GEMINI_API_KEY)    providers.push('Gemini');
if (process.env.GITHUB_TOKEN)      providers.push('Copilot (token)');
if (process.env.CUSTOM_AI_BASE_URL) providers.push('Custom endpoint');
if (providers.length) {
  ok(`AI provider(s) configured: ${providers.join(', ')}`);
} else {
  warn('No AI provider configured in .env — set a key, use the ⚙ Settings modal, ' +
       'the Claude CLI (keyless), or the VS Code Copilot bridge before generating');
}

// 6. Auth status
try {
  const auth = require(path.join(ROOT, 'lib', 'auth'));
  auth.isAuthEnabled()
    ? ok(`Authentication ENABLED (${auth.readUsers().length} user(s))`)
    : warn('Authentication OPEN — fine locally; enable it (AUTH_ADMIN_*) for a shared deploy');
} catch {}

console.log('');
if (problems)      { console.log(`\x1b[31m✗ ${problems} problem(s) to fix before the app will run.\x1b[0m\n`); process.exit(1); }
else if (warnings) { console.log(`\x1b[33m⚠ Ready, with ${warnings} optional item(s) above.\x1b[0m\n`); }
else               { console.log('\x1b[32m✓ All checks passed — ready to go.\x1b[0m\n'); }
