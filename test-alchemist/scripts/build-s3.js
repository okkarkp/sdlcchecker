/**
 * Build the frontend for S3 static hosting.
 *
 * Usage:
 *   node scripts/build-s3.js --api https://api.your-domain.com --ws api.your-domain.com
 *
 * What it does:
 *  1. Copies public/ → dist/
 *  2. Injects API_BASE and WS_HOST into dist/index.html
 *  3. Prints the S3 sync command to run next
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC  = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

// ── Parse CLI args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const API_BASE = get('--api') || process.env.API_BASE || '';
const WS_HOST  = get('--ws')  || process.env.WS_HOST  || '';

if (!API_BASE) {
  console.error('\nUsage: node scripts/build-s3.js --api https://api.your-domain.com [--ws api.your-domain.com]\n');
  process.exit(1);
}

// ── Copy public/ → dist/ ──────────────────────────────────────────────────────
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (fs.existsSync(DIST)) fs.rmSync(DIST, { recursive: true });
copyDir(SRC, DIST);
console.log('✅  Copied public/ → dist/');

// ── Inject config into dist/index.html ────────────────────────────────────────
const htmlPath = path.join(DIST, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

html = html.replace(
  /window\.API_BASE\s*=\s*'[^']*'/,
  `window.API_BASE = '${API_BASE}'`
).replace(
  /window\.WS_HOST\s*=\s*'[^']*'/,
  `window.WS_HOST  = '${WS_HOST || new URL(API_BASE).host}'`
);

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`✅  Injected API_BASE="${API_BASE}" into dist/index.html`);
console.log(`✅  Injected WS_HOST="${WS_HOST || new URL(API_BASE).host}" into dist/index.html`);

// ── Instructions ──────────────────────────────────────────────────────────────
console.log(`
${'═'.repeat(60)}
  Build complete → dist/

  Next steps:

  1. Upload frontend to S3:
     aws s3 sync dist/ s3://YOUR_BUCKET_NAME --delete

  2. Enable static website hosting on the bucket:
     aws s3 website s3://YOUR_BUCKET_NAME \\
       --index-document index.html \\
       --error-document index.html

  3. Deploy the backend (Express server) — choose one:
     a) Elastic Beanstalk:  node scripts/package-eb.js
     b) EC2:                scp -r . user@your-ec2:~/qa-hub && npm start
     c) Docker:             docker build -t qa-hub . && docker push

  4. Point your CloudFront distribution at the S3 bucket.
     Set the backend ALB/EC2 as a second origin for /api/* paths.
${'═'.repeat(60)}
`);
