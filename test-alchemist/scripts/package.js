#!/usr/bin/env node
/**
 * scripts/package.js — cross-platform handoff packager (Mac/Windows/Linux).
 *
 * Produces a clean, shareable zip of Test Alchemist for a new project/team.
 * Cross-platform replacement for the old PowerShell make-handoff-zip.ps1.
 *
 *   EXCLUDES: secrets (.env), runtime data (data/), node_modules, logs, dev config.
 *   INCLUDES: source, .env.example, docs, package.json/lock, start/stop scripts.
 *
 * Usage (from anywhere):
 *   npm run package
 *   node scripts/package.js               -> test-alchemist-handoff.zip
 *   node scripts/package.js my-name.zip   -> custom output name
 */
'use strict';

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');

const ROOT     = path.join(__dirname, '..');            // project root (this script lives in scripts/)
const OUT_NAME = process.argv[2] || 'test-alchemist-handoff.zip';
const OUT_PATH = path.isAbsolute(OUT_NAME) ? OUT_NAME : path.join(ROOT, OUT_NAME);

// Directory names excluded anywhere in the tree.
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.claude', '.vscode', 'vscode-bridge',
  'data', '.pwlib-runs', '.pwlib-reports', 'test-results', 'uploads',
  'playwright-report', 'generated',
]);

// File patterns excluded anywhere. Secrets and runtime artifacts never ship.
const EXCLUDE_FILES = [
  /^\.env$/,                     // ship .env.example, never .env
  /^project\.config\.json$/,     // ship project.config.example.json, not a target profile
  /^ip-whitelist\.txt$/,
  /\.log$/, /\.err$/, /\.zip$/,
];

function isExcludedFile(name) {
  return EXCLUDE_FILES.some((re) => re.test(name));
}

// Recursively collect files to ship, applying the exclusion rules.
function collect(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? path.posix.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out.push(...collect(abs, relPath));
    } else if (entry.isFile()) {
      if (isExcludedFile(entry.name)) continue;
      out.push({ abs, relPath });
    }
  }
  return out;
}

async function main() {
  console.log(`Project root : ${ROOT}`);

  // Remove a previous zip so its size can't be included in the new one.
  if (fs.existsSync(OUT_PATH)) fs.rmSync(OUT_PATH);

  const files = collect(ROOT);

  await new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(OUT_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.on('error', reject);

    archive.pipe(output);
    for (const f of files) archive.file(f.abs, { name: f.relPath });
    archive.finalize();
  });

  const sizeMB = (fs.statSync(OUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log('');
  console.log(`Created: ${OUT_PATH}  (${sizeMB} MB, ${files.length} files)`);
  console.log('Shipped .env.example (NOT .env).');
  console.log('Recipient steps:  npm install  ->  npm run init  ->  npm start');
}

main().catch((err) => {
  console.error('Packaging failed:', err.message);
  process.exit(1);
});
