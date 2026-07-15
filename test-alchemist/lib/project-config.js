/**
 * lib/project-config.js — declarative per-project profile loader.
 *
 * Makes Test Alchemist project-agnostic: a single `project.config.json` at the
 * repo root describes WHICH project this deployment targets (app name, base URL,
 * Jira/GitLab project identity). It carries NO secrets — API keys and tokens
 * stay in `.env`. This split lets a project profile be shared/committed safely
 * while credentials remain local.
 *
 * Values are applied as *fallbacks* onto process.env: anything already set in
 * `.env` wins, so existing deployments keep working unchanged. Because every
 * route already reads `req.body.X || process.env.X`, no route code changes.
 *
 * Load order (highest priority first):
 *   1. per-request values from the ⚙ Settings modal (req.body / req.query)
 *   2. .env                      (secrets + any explicit overrides)
 *   3. project.config.json       (this file — non-secret project identity)
 *   4. built-in code defaults
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'project.config.json');

// Map of project.config.json paths → environment variable names.
// Only non-secret identity fields belong here; secrets live in .env.
const FIELD_MAP = [
  ['appName',                 'APP_NAME'],
  ['port',                    'PORT'],
  ['appBaseUrl',              'APP_BASE_URL'],
  ['automationRepoPath',      'AUTOMATION_REPO_PATH'],
  ['jira.baseUrl',            'JIRA_BASE_URL'],
  ['jira.projectKey',         'JIRA_PROJECT_KEY'],
  ['jira.testIssueType',      'JIRA_TEST_ISSUE_TYPE'],
  ['gitlab.url',              'GITLAB_URL'],
  ['gitlab.projectId',        'GITLAB_PROJECT_ID'],
  ['gitlab.defaultBranch',    'GITLAB_DEFAULT_BRANCH'],
  ['confluence.baseUrl',      'CONFLUENCE_BASE_URL'],
];

function getPath(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/**
 * Load project.config.json (if present) and apply its non-secret identity fields
 * as fallbacks onto process.env. Safe to call once at server boot.
 * @returns {object|null} the parsed config, or null if no file / parse error.
 */
function loadProjectConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return null;

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn(`[project-config] Ignoring project.config.json — invalid JSON: ${err.message}`);
    return null;
  }

  let applied = 0;
  for (const [field, envVar] of FIELD_MAP) {
    const val = getPath(cfg, field);
    if (val === undefined || val === null || val === '') continue;
    // Fallback only — never clobber an explicit .env value.
    if (process.env[envVar] === undefined || process.env[envVar] === '') {
      process.env[envVar] = String(val);
      applied++;
    }
  }

  console.log(`[project-config] Loaded profile "${cfg.appName || 'unnamed'}" (${applied} field(s) applied).`);
  return cfg;
}

module.exports = { loadProjectConfig, CONFIG_PATH, FIELD_MAP };
