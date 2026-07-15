#!/usr/bin/env node
/**
 * scripts/init.js — one-command project bootstrap for a fresh deployment.
 *
 * Turns "unzip -> hand-edit ~40 env vars -> start" into a short guided setup.
 * Creates .env from .env.example (if missing) and fills in the values that
 * change per project: app name, port, one AI key, the app-under-test URL, and
 * (optionally) Jira / GitLab. Everything else keeps the template defaults and
 * can still be edited later in .env or live in the ⚙ Settings modal.
 *
 * Non-destructive: existing .env values are shown as defaults; press Enter to keep.
 *
 * Usage:  npm run init   (or)   node scripts/init.js
 */
'use strict';

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const ROOT         = path.join(__dirname, '..');
const ENV_PATH     = path.join(ROOT, '.env');
const EXAMPLE_PATH = path.join(ROOT, '.env.example');
const CFG_PATH     = path.join(ROOT, 'project.config.json');
const CFG_EXAMPLE  = path.join(ROOT, 'project.config.example.json');

// Values in .env.example are dummy placeholders — don't offer them as real defaults.
// Match only the template dummies (every one has an "xxxx" run or is a known
// example string); NEVER match a real credential by its prefix (real Anthropic
// keys start "sk-ant-", Gemini "AIza", GitLab "glpat-", Figma "figd_").
const PLACEHOLDER = [
  /x{4,}/i,
  /yourorg\.atlassian\.net/,
  /your\.email@example\.com/,
  /^12345678$/,
];
const cleanDefault = (v) => (v && PLACEHOLDER.some((re) => re.test(v)) ? '' : (v || ''));

// ── Read current .env (or the example as seed) into a key→value map ────────────
function loadEnv() {
  const src = fs.existsSync(ENV_PATH) ? ENV_PATH
            : fs.existsSync(EXAMPLE_PATH) ? EXAMPLE_PATH
            : null;
  const map = {};
  if (!src) return map;
  for (const line of fs.readFileSync(src, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

// Identity keys owned by project.config.json — must NOT carry a value in .env,
// or the .env template default would shadow the profile (higher priority).
// Keep in sync with FIELD_MAP in lib/project-config.js.
const CONFIG_OWNED = new Set([
  'APP_NAME', 'PORT', 'APP_BASE_URL', 'AUTOMATION_REPO_PATH',
  'JIRA_BASE_URL', 'JIRA_PROJECT_KEY', 'JIRA_TEST_ISSUE_TYPE',
  'GITLAB_URL', 'GITLAB_PROJECT_ID', 'GITLAB_DEFAULT_BRANCH',
  'CONFLUENCE_BASE_URL',
]);

// ── Write answers back into .env, preserving comments/structure ────────────────
function writeEnv(answers) {
  // Start from existing .env, else from the example template.
  let lines;
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  } else if (fs.existsSync(EXAMPLE_PATH)) {
    lines = fs.readFileSync(EXAMPLE_PATH, 'utf8').split(/\r?\n/);
  } else {
    lines = [];
  }

  const remaining = { ...answers };
  const updated = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) return line;
    const key = m[1];
    if (key in remaining) {
      const val = remaining[key];
      delete remaining[key];
      return `${key}=${val}`;
    }
    // Blank identity keys so the template default can't shadow project.config.json.
    if (CONFIG_OWNED.has(key)) return `${key}=`;
    return line;
  });

  // Append any keys not already present in the template.
  const extras = Object.entries(remaining);
  if (extras.length) {
    updated.push('', '# ─── Added by init ───');
    for (const [k, v] of extras) updated.push(`${k}=${v}`);
  }

  fs.writeFileSync(ENV_PATH, updated.join('\n'));
}

// ── project.config.json (non-secret project identity) ──────────────────────────
// Load the current profile (or the example template) so re-runs show real defaults.
function loadCfg() {
  const src = fs.existsSync(CFG_PATH) ? CFG_PATH
            : fs.existsSync(CFG_EXAMPLE) ? CFG_EXAMPLE
            : null;
  if (!src) return {};
  try { return JSON.parse(fs.readFileSync(src, 'utf8')); }
  catch { return {}; }
}

// Set a dotted path (e.g. "jira.baseUrl") on an object, creating nesting as needed.
function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  let o = obj;
  while (keys.length > 1) {
    const k = keys.shift();
    if (typeof o[k] !== 'object' || o[k] === null) o[k] = {};
    o = o[k];
  }
  o[keys[0]] = value;
}

// Merge identity answers into project.config.json, preserving any existing keys
// (including the _comment). Only writes fields the user actually provided.
function writeCfg(cfgAnswers) {
  const cfg = loadCfg();
  for (const [dotted, val] of Object.entries(cfgAnswers)) {
    if (val === undefined || val === '') continue;
    setPath(cfg, dotted, dotted === 'port' ? Number(val) || val : val);
  }
  fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2) + '\n');
}

const getPath = (obj, dotted) =>
  dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// ── Prompt helpers ─────────────────────────────────────────────────────────────
// Buffer 'line' events into a queue so sequential prompts work for BOTH an
// interactive TTY (lines arrive as typed) and piped/bulk input (all lines arrive
// at once — rl.question would otherwise drop the buffered lines).
function makeAsk(rl) {
  const queue   = [];   // lines received but not yet consumed
  const waiters = [];   // resolvers waiting for the next line
  let closed = false;

  rl.on('line', (line) => {
    if (waiters.length) waiters.shift()(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });

  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  return async (question, def = '') => {
    const hint = def ? ` [${def}]` : '';
    process.stdout.write(`${question}${hint}: `);
    const line = await nextLine();
    return (line == null ? '' : line).trim() || def;
  };
}
const isYes = (v) => /^y(es)?$/i.test((v || '').trim());

async function main() {
  if (!fs.existsSync(EXAMPLE_PATH) && !fs.existsSync(ENV_PATH)) {
    console.error('Cannot find .env.example — run this from a Test Alchemist checkout.');
    process.exit(1);
  }

  const cur = loadEnv();   // current .env values (secrets + legacy identity)
  const cfg = loadCfg();   // current project.config.json (identity)
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = makeAsk(rl);

  const env = {};   // secrets → .env
  const pc  = {};   // identity → project.config.json (dotted keys)

  // Prefer an existing project.config value, then a legacy .env value, as the default.
  const cfgDef = (dotted, envKey) => {
    const fromCfg = getPath(cfg, dotted);
    if (fromCfg !== undefined && fromCfg !== '') return String(fromCfg);
    return cleanDefault(cur[envKey]);
  };

  console.log('\n⚗️  Test Alchemist — project setup\n');
  console.log('This points the tool at ONE project. Identity → project.config.json,');
  console.log('secrets → .env. Press Enter to keep a shown default; all values can be');
  console.log('changed later in those files or in the ⚙ Settings modal.\n');

  // ── Application identity → project.config.json ───────────────────────────────
  pc.appName    = await ask('App / project name', getPath(cfg, 'appName') || cur.APP_NAME || 'Test Alchemist');
  pc.port       = await ask('Server port', String(getPath(cfg, 'port') || cur.PORT || '3000'));
  pc.appBaseUrl = await ask('Base URL of the app under test (optional)', cfgDef('appBaseUrl', 'APP_BASE_URL'));

  // ── AI provider key → .env (secret) ──────────────────────────────────────────
  console.log('\nAI provider — pick the one you have a key for.');
  const provider = (await ask('Provider (claude / openai / gemini)', 'claude')).toLowerCase();
  const keyVar = provider === 'openai' ? 'OPENAI_API_KEY'
               : provider === 'gemini' ? 'GEMINI_API_KEY'
               : 'ANTHROPIC_API_KEY';
  env[keyVar] = await ask(`${keyVar}`, cleanDefault(cur[keyVar]));

  // ── Jira: identity → config, credentials → .env ──────────────────────────────
  console.log('');
  if (isYes(await ask('Configure Jira now? (y/N)', 'N'))) {
    pc['jira.baseUrl']    = await ask('  Jira base URL', cfgDef('jira.baseUrl', 'JIRA_BASE_URL'));
    env.JIRA_EMAIL        = await ask('  Jira email', cleanDefault(cur.JIRA_EMAIL));
    env.JIRA_API_TOKEN    = await ask('  Jira API token', cleanDefault(cur.JIRA_API_TOKEN));
    pc['jira.projectKey'] = await ask('  Jira project key', cfgDef('jira.projectKey', 'JIRA_PROJECT_KEY') || 'QA');
  }

  // ── GitLab: identity → config, token → .env ──────────────────────────────────
  console.log('');
  if (isYes(await ask('Configure GitLab now? (y/N)', 'N'))) {
    pc['gitlab.url']       = await ask('  GitLab URL', cfgDef('gitlab.url', 'GITLAB_URL') || 'https://gitlab.com');
    env.GITLAB_TOKEN       = await ask('  GitLab token', cleanDefault(cur.GITLAB_TOKEN));
    pc['gitlab.projectId'] = await ask('  GitLab project ID', cfgDef('gitlab.projectId', 'GITLAB_PROJECT_ID'));
  }

  rl.close();
  writeEnv(env);
  writeCfg(pc);

  console.log('\n✔ Wrote project.config.json (project identity)');
  console.log('✔ Wrote .env (secrets)');
  if (!env[keyVar]) {
    console.log(`⚠ No ${keyVar} set — add it to .env before generating (or use the Settings modal).`);
  }
  console.log('\nNext:');
  console.log('  npm install     (if you have not already)');
  console.log('  npm start       ->  http://localhost:' + pc.port + '\n');
}

main().catch((err) => {
  console.error('Init failed:', err.message);
  process.exit(1);
});
