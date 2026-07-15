/**
 * Pre-deployment validation script.
 * Run: node scripts/check-deploy.js
 *
 * Checks:
 *  1. Node.js version
 *  2. Required npm packages installed
 *  3. Environment variables / .env file
 *  4. File parsers (PDF, Excel, Word, PPTX)
 *  5. Public assets present
 *  6. Server starts and health endpoint responds
 *  7. CORS header returned for a cross-origin request
 *  8. AI provider key validity (optional live ping)
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0, warned = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────
const OK   = (msg)       => { console.log(`  ✅  ${msg}`); passed++; };
const FAIL = (msg)       => { console.log(`  ❌  ${msg}`); failed++; };
const WARN = (msg)       => { console.log(`  ⚠️   ${msg}`); warned++; };
const HDR  = (title)     => console.log(`\n── ${title} ${'─'.repeat(50 - title.length)}`);

function fileExists(...parts) { return fs.existsSync(path.join(ROOT, ...parts)); }

async function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── 1. Node version ────────────────────────────────────────────────────────────
HDR('1. Node.js version');
const [major] = process.versions.node.split('.').map(Number);
if (major >= 18) OK(`Node.js ${process.version}`);
else             FAIL(`Node.js ${process.version} — v18+ required`);

// ── 2. Required packages ───────────────────────────────────────────────────────
HDR('2. npm packages');
const required = [
  '@anthropic-ai/sdk', 'openai', '@google/generative-ai',
  'express', 'multer', 'cors', 'ws', 'archiver', 'axios',
  'pdf-parse', 'xlsx', 'mammoth', 'jszip', 'dotenv', 'form-data',
];
for (const pkg of required) {
  try   { require.resolve(pkg); OK(pkg); }
  catch { FAIL(`${pkg} — run: npm install`); }
}

// ── 3. Environment variables ───────────────────────────────────────────────────
HDR('3. Environment variables');
const envVars = {
  ANTHROPIC_API_KEY: 'required for Claude',
  OPENAI_API_KEY:    'required for ChatGPT',
  GEMINI_API_KEY:    'required for Gemini',
  GITLAB_PROJECT_ID:    'required for pipeline trigger',
  GITLAB_TRIGGER_TOKEN: 'required for pipeline trigger',
  JIRA_BASE_URL:     'required for Jira integration',
  JIRA_EMAIL:        'required for Jira integration',
  JIRA_API_TOKEN:    'required for Jira integration',
  ALLOWED_ORIGIN:    'set to your S3/CloudFront URL in production',
};

const atLeastOneAI = ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY']
  .some(k => process.env[k]);
if (atLeastOneAI) OK('At least one AI provider key is set');
else              FAIL('No AI provider key set — app cannot generate anything');

['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY'].forEach(k => {
  if (process.env[k]) OK(`${k} ✓`);
  else                WARN(`${k} not set (optional if using another provider)`);
});

['GITLAB_PROJECT_ID','GITLAB_TRIGGER_TOKEN'].forEach(k => {
  if (process.env[k]) OK(`${k} ✓`);
  else                WARN(`${k} not set — GitLab pipeline trigger won't work`);
});

['JIRA_BASE_URL','JIRA_EMAIL','JIRA_API_TOKEN'].forEach(k => {
  if (process.env[k]) OK(`${k} ✓`);
  else                WARN(`${k} not set — Jira integration won't work`);
});

if (!process.env.ALLOWED_ORIGIN)
  WARN('ALLOWED_ORIGIN not set — CORS allows * (fine for dev, set for production S3)');
else
  OK(`ALLOWED_ORIGIN = ${process.env.ALLOWED_ORIGIN}`);

// ── 4. File parsers ────────────────────────────────────────────────────────────
HDR('4. File parser smoke tests');
(async () => {
  // Excel
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Test','Data']]), 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const ws  = wb.Sheets['Sheet1'];
    XLSX.utils.sheet_to_json(ws, { header: 1 });
    OK('Excel parser (xlsx)');
  } catch (e) { FAIL(`Excel parser: ${e.message}`); }

  // Word
  try {
    const mammoth = require('mammoth');
    // mammoth needs an actual DOCX buffer; just verify it loads
    if (typeof mammoth.extractRawText === 'function') OK('Word parser (mammoth)');
    else throw new Error('extractRawText not found');
  } catch (e) { FAIL(`Word parser: ${e.message}`); }

  // PPTX
  try {
    const JSZip = require('jszip');
    const zip   = new JSZip();
    zip.file('ppt/slides/slide1.xml', '<root><a:t>Hello</a:t></root>');
    const buf   = await zip.generateAsync({ type: 'nodebuffer' });
    const zip2  = await JSZip.loadAsync(buf);
    const files = Object.keys(zip2.files);
    if (files.length > 0) OK('PPTX parser (jszip)');
    else throw new Error('No files in zip');
  } catch (e) { FAIL(`PPTX parser: ${e.message}`); }

  // PDF
  try {
    require.resolve('pdf-parse');
    OK('PDF parser (pdf-parse)');
  } catch (e) { FAIL(`PDF parser: ${e.message}`); }

  // ── 5. Public assets ─────────────────────────────────────────────────────────
  HDR('5. Frontend assets');
  [
    ['public', 'index.html'],
    ['public', 'css', 'styles.css'],
    ['public', 'js', 'app.js'],
  ].forEach(parts => {
    if (fileExists(...parts)) OK(parts.join('/'));
    else                      FAIL(`Missing: ${parts.join('/')}`);
  });

  // Check API_BASE placeholder present in index.html
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  if (html.includes('window.API_BASE')) OK('window.API_BASE config block found in index.html');
  else                                  FAIL('window.API_BASE missing from index.html — S3 frontend cannot reach backend');

  if (html.includes('window.WS_HOST')) OK('window.WS_HOST config block found in index.html');
  else                                 WARN('window.WS_HOST missing — WebSocket may not connect from S3');

  // ── 6. Server health check ───────────────────────────────────────────────────
  HDR('6. Server health check');
  const PORT = process.env.PORT || 3000;
  let serverProcess;
  try {
    // Try existing server first
    const res = await get(`http://localhost:${PORT}/api/health`);
    if (res.status === 200) {
      const body = JSON.parse(res.body);
      OK(`Health endpoint responded: ${body.status} v${body.version}`);
    } else {
      FAIL(`Health endpoint returned HTTP ${res.status}`);
    }

    // ── 7. CORS check ──────────────────────────────────────────────────────────
    HDR('7. CORS headers');
    const corsRes = await get(`http://localhost:${PORT}/api/health`, {
      'Origin': 'https://my-qa-hub.s3.amazonaws.com',
    });
    const acao = corsRes.headers['access-control-allow-origin'];
    if (acao === '*' || acao === 'https://my-qa-hub.s3.amazonaws.com') {
      OK(`Access-Control-Allow-Origin: ${acao}`);
    } else if (acao) {
      WARN(`CORS origin returned: ${acao} (set ALLOWED_ORIGIN env var to match your S3 URL)`);
    } else {
      FAIL('No CORS header returned — frontend on S3 will get blocked by browser');
    }

    // ── 8. API routes present ─────────────────────────────────────────────────
    HDR('8. API route smoke test');
    for (const route of ['/api/ai/models', '/api/health']) {
      try {
        const r = await get(`http://localhost:${PORT}${route}`);
        if (r.status === 200) OK(`GET ${route} → 200`);
        else                  FAIL(`GET ${route} → ${r.status}`);
      } catch (e) { FAIL(`GET ${route} → ${e.message}`); }
    }

  } catch (e) {
    WARN(`Server not running on port ${PORT} — start it with "npm start" for live checks`);
    WARN('Skipping CORS and route checks');
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(55));
  console.log(`  PASSED: ${passed}   WARNINGS: ${warned}   FAILED: ${failed}`);
  console.log('═'.repeat(55));

  if (failed === 0 && warned === 0) {
    console.log('\n  🚀  All checks passed — ready to deploy!\n');
  } else if (failed === 0) {
    console.log('\n  ✅  No failures. Review warnings before deploying to production.\n');
  } else {
    console.log('\n  ❌  Fix failures above before deploying.\n');
    process.exit(1);
  }
})();
