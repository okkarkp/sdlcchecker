/**
 * lib/repo-context.js
 * Reads an automation repo's prompt/instruction files and key templates, then
 * builds a rich context string to inject into Playwright test generation.
 *
 * Everything is configurable so the tool works against any project's repo:
 *   AUTOMATION_REPO_PATH — path to the automation repo (empty = not connected)
 *   PAGE_OBJECTS_DIR     — folder holding page objects   (default: pages)
 *   SPECS_DIR            — folder holding test specs      (default: tests)
 *   PROMPT_FILE          — instructions/prompt file, repo-relative
 *                          (default: .github/copilot-instructions.md)
 *   LEARNINGS_FILE       — UI patterns/learnings file, repo-relative (optional)
 *   SEED_SPEC            — seed spec to base tests on, specs-dir-relative
 *                          (default: seed.spec.js)
 *   LOGIN_PAGE           — login page object, page-objects-dir-relative
 *                          (default: loginPage.js)
 */
'use strict';

const fs   = require('fs');
const path = require('path');

// No hardcoded project path — default to empty (treated as "not connected").
const DEFAULT_REPO_PATH = process.env.AUTOMATION_REPO_PATH || '';

const PAGE_OBJECTS_DIR = process.env.PAGE_OBJECTS_DIR || 'pages';
const SPECS_DIR        = process.env.SPECS_DIR        || 'tests';
const PROMPT_FILE      = process.env.PROMPT_FILE      || path.join('.github', 'copilot-instructions.md');
const LEARNINGS_FILE   = process.env.LEARNINGS_FILE   || '';
const SEED_SPEC        = process.env.SEED_SPEC        || 'seed.spec.js';
const LOGIN_PAGE       = process.env.LOGIN_PAGE       || 'loginPage.js';

// Allow runtime override (set via API)
let REPO_PATH = DEFAULT_REPO_PATH;

function setRepoPath(p) {
  if (p && typeof p === 'string' && p.trim()) {
    REPO_PATH = p.trim();
  }
}

function getRepoPath()       { return REPO_PATH; }
function getSpecsDir()       { return SPECS_DIR; }

// Well-known folder names that commonly hold page objects.
const PAGE_OBJECT_DIR_CANDIDATES = ['pages', 'page-objects', 'pageobjects', 'pageObjects', 'pom', 'poms', 'po'];

function isPageObjectFile(f) {
  return f.endsWith('.js') && !f.endsWith('.spec.js') && !f.startsWith('Excel') && !f.startsWith('Api');
}

function countPageObjects(dirAbs) {
  try { return fs.readdirSync(dirAbs).filter(isPageObjectFile).length; }
  catch { return 0; }
}

/**
 * Resolve the page-objects directory (repo-relative) for a given repo.
 * Works regardless of the folder name so it adapts to any project:
 *   1. the configured PAGE_OBJECTS_DIR, if it holds page objects
 *   2. well-known candidate names (top level and under src/)
 *   3. heuristic — the top-level/src folder with the most page-object .js files
 * Falls back to the configured default when nothing is found.
 */
function resolvePageObjectsDir(repoPath) {
  const rp = repoPath || REPO_PATH;
  if (!rp) return PAGE_OBJECTS_DIR;

  // 1 + 2. Configured name first, then common candidate names (top level + src/)
  for (const name of [PAGE_OBJECTS_DIR, ...PAGE_OBJECT_DIR_CANDIDATES]) {
    for (const base of ['', 'src']) {
      const rel = base ? path.join(base, name) : name;
      if (countPageObjects(path.join(rp, rel)) > 0) return rel;
    }
  }

  // 3. Heuristic — scan top-level and src/ directories, pick the one with the
  //    most page-object .js files (excluding the specs dir / node_modules).
  let best = null, bestCount = 0;
  for (const base of ['', 'src']) {
    const baseAbs = base ? path.join(rp, base) : rp;
    let entries = [];
    try { entries = fs.readdirSync(baseAbs, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name === SPECS_DIR || e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = base ? path.join(base, e.name) : e.name;
      const c   = countPageObjects(path.join(rp, rel));
      if (c > bestCount) { best = rel; bestCount = c; }
    }
  }

  return best || PAGE_OBJECTS_DIR;
}

// Optional repoPath arg so callers can resolve against a specific repo; defaults
// to the active REPO_PATH.
function getPageObjectsDir(repoPath) { return resolvePageObjectsDir(repoPath); }

function getFiles(repoPath) {
  const rp       = repoPath || REPO_PATH;
  const pagesDir = resolvePageObjectsDir(rp);
  return {
    prompt:     path.join(rp, PROMPT_FILE),
    learnings:  LEARNINGS_FILE ? path.join(rp, LEARNINGS_FILE) : null,
    seed:       path.join(rp, SPECS_DIR, SEED_SPEC),
    loginPage:  path.join(rp, pagesDir, LOGIN_PAGE),
  };
}

function readSafe(filePath, maxChars = 6000) {
  if (!filePath) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.length > maxChars ? content.slice(0, maxChars) + '\n... [truncated]' : content;
  } catch {
    return null;
  }
}

function repoExists(repoPath) {
  const rp = repoPath || REPO_PATH;
  return !!rp && fs.existsSync(rp);
}

function listExistingPageObjects(repoPath) {
  try {
    const rp  = repoPath || REPO_PATH;
    const dir = path.join(rp, resolvePageObjectsDir(rp));
    return fs.readdirSync(dir)
      .filter(isPageObjectFile)
      .map(f => f.replace('.js', ''))
      .sort();
  } catch { return []; }
}

function listExistingTests(repoPath) {
  try {
    const dir = path.join(repoPath || REPO_PATH, SPECS_DIR);
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.spec.js'))
      .map(f => f.replace('.spec.js', ''))
      .sort();
  } catch { return []; }
}

/**
 * Build the full context string to prepend to the Playwright generation prompt.
 */
function buildPlaywrightContext(repoPath) {
  const rp = repoPath || REPO_PATH;
  if (!repoExists(rp)) {
    return ''; // silently skip if repo not found
  }

  const FILES = getFiles(rp);
  const parts = [];

  parts.push('# Automation Repository Context');
  parts.push(`Repo: ${rp}`);
  parts.push('');
  parts.push(`## Existing Page Objects (in ${PAGE_OBJECTS_DIR}/)`);
  parts.push(listExistingPageObjects(rp).map(p => `- ${p}`).join('\n'));
  parts.push('');
  parts.push(`## Existing Test Specs (in ${SPECS_DIR}/)`);
  parts.push(listExistingTests(rp).map(t => `- ${t}.spec.js`).join('\n'));
  parts.push('');

  // Seed template — most important reference
  const seed = readSafe(FILES.seed);
  if (seed) {
    parts.push(`## Seed Template (${SEED_SPEC}) — BASE every generated test on this:`);
    parts.push('```javascript');
    parts.push(seed);
    parts.push('```');
    parts.push('');
  }

  // Login page — always needed
  const login = readSafe(FILES.loginPage);
  if (login) {
    parts.push(`## ${LOGIN_PAGE} (reference for login steps):`);
    parts.push('```javascript');
    parts.push(login);
    parts.push('```');
    parts.push('');
  }

  // Instructions / framework rules
  const prompt = readSafe(FILES.prompt, 4000);
  if (prompt) {
    parts.push('## Framework Rules (instructions file):');
    parts.push(prompt);
    parts.push('');
  }

  // Learnings — critical UI patterns and quirks (optional)
  const learnings = readSafe(FILES.learnings, 5000);
  if (learnings) {
    parts.push('## Live UI Patterns & Quirks (learnings file):');
    parts.push(learnings);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Returns the compact version for prompt injection (to control token usage).
 * Focused on the patterns most critical for correct code generation.
 */
function buildCompactContext(repoPath) {
  const rp = repoPath || REPO_PATH;
  if (!repoExists(rp)) return '';

  const FILES = getFiles(rp);
  const seed      = readSafe(FILES.seed);
  const login     = readSafe(FILES.loginPage, 2500);
  const learnings = readSafe(FILES.learnings, 3000);

  const lines = [
    '=== AUTOMATION REPO CONTEXT — follow these patterns EXACTLY ===',
    '',
    `Repo path: ${rp}`,
    `Existing page objects: ${listExistingPageObjects(rp).slice(0, 20).join(', ')}`,
    '',
    `--- ${SEED_SPEC} (MANDATORY template — all tests must follow this structure) ---`,
    seed || '(not found)',
    '',
    `--- ${LOGIN_PAGE} (reuse for login) ---`,
    login || '(not found)',
    '',
    '--- Critical UI patterns from learnings ---',
    learnings || '(not found)',
    '',
    '=== END REPO CONTEXT ===',
  ];

  return lines.join('\n');
}

// Just the instructions/conversion prompt file content (e.g. .github/CONVERSION_PROMPT.md).
function getPromptFile(repoPath, maxChars = 5000) {
  return readSafe(getFiles(repoPath).prompt, maxChars);
}

// Extract the REAL login locators from the repo's login page-object so the Browser
// Agent can reuse the suite's proven selectors instead of guessing. Parses common
// Playwright patterns: page.locator('…'), getByRole('button',{name:'…'}), getByLabel,
// getByPlaceholder, getByTestId, and raw selector literals (#id, [name=…], input[…]).
// Heuristic but additive — the agent falls back to deep-DOM auto-login if none resolve.
function getLoginHints(repoPath) {
  const src = readSafe(getFiles(repoPath).loginPage, 12000) || '';
  if (!src) return null;
  const css = new Set(), labels = new Set(), placeholders = new Set(), testIds = new Set(), roleNames = [];

  for (const m of src.matchAll(/(?:locator|\$\$?|querySelector(?:All)?)\(\s*([`'"])([^`'"]+?)\1/g)) css.add(m[2]);
  for (const m of src.matchAll(/getByRole\(\s*[`'"]([a-z]+)[`'"]\s*,\s*\{[^}]*?name\s*:\s*([`'"\/])([^`'"\/]+)\2/gi)) roleNames.push({ role: m[1].toLowerCase(), name: m[3] });
  for (const m of src.matchAll(/getByLabel\(\s*([`'"])([^`'"]+?)\1/g))        labels.add(m[2]);
  for (const m of src.matchAll(/getByPlaceholder\(\s*([`'"])([^`'"]+?)\1/g))  placeholders.add(m[2]);
  for (const m of src.matchAll(/getByTestId\(\s*([`'"])([^`'"]+?)\1/g))       testIds.add(m[2]);
  for (const m of src.matchAll(/([`'"])(#[\w:.\-]+|\[[^\]]+\]|(?:input|button|select|textarea)[^`'"]*)\1/g)) css.add(m[2]);

  const out = { css: [...css], labels: [...labels], placeholders: [...placeholders], testIds: [...testIds], roleNames };
  const total = out.css.length + out.labels.length + out.placeholders.length + out.testIds.length + out.roleNames.length;
  return total ? out : null;
}

// Lean context for converting a recording → repo scripts: the prompt file +
// compact seed/login patterns. Much smaller than buildPlaywrightContext, so it's
// faster through the CLI while still following the repo conventions.
function buildConversionContext(repoPath) {
  const rp = repoPath || REPO_PATH;
  if (!repoExists(rp)) return '';
  const FILES   = getFiles(rp);
  const prompt  = readSafe(FILES.prompt, 4000);
  const seed    = readSafe(FILES.seed, 3500);
  const login   = readSafe(FILES.loginPage, 2500);
  const parts = [];
  if (prompt) { parts.push('=== CONVERSION INSTRUCTIONS (follow EXACTLY) ===', prompt, ''); }
  parts.push(`Existing page objects (${PAGE_OBJECTS_DIR}/): ${listExistingPageObjects(rp).slice(0, 25).join(', ') || '(none)'}`, '');
  if (seed)  { parts.push(`--- ${SEED_SPEC} (base every spec on this) ---`, seed, ''); }
  if (login) { parts.push(`--- ${LOGIN_PAGE} (reuse for login) ---`, login, ''); }
  return parts.join('\n');
}

module.exports = {
  buildPlaywrightContext, buildCompactContext, buildConversionContext, getPromptFile, getLoginHints, repoExists,
  setRepoPath, getRepoPath, getPageObjectsDir, getSpecsDir,
  REPO_PATH: DEFAULT_REPO_PATH,
};
