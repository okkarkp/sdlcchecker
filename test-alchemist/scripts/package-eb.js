/**
 * Package the backend for AWS Elastic Beanstalk deployment.
 *
 * Creates qa-hub-backend.zip (excludes node_modules, dist, uploads, .env)
 * Upload the ZIP via the EB console or CLI:
 *   eb deploy  (if EB CLI is configured)
 *
 * Usage: node scripts/package-eb.js
 */

const fs      = require('fs');
const path    = require('path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const OUT  = path.join(ROOT, 'qa-hub-backend.zip');

const EXCLUDE = new Set([
  'node_modules', 'dist', 'uploads', '.env',
  'playwright-tests/generated', 'playwright-report', 'test-results',
  'qa-hub-backend.zip',
]);

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const output  = fs.createWriteStream(OUT);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.pipe(output);

function addDir(dir, baseInZip = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name)) continue;
    const fullPath  = path.join(dir, entry.name);
    const zipPath   = baseInZip ? `${baseInZip}/${entry.name}` : entry.name;
    if (entry.isDirectory()) addDir(fullPath, zipPath);
    else archive.file(fullPath, { name: zipPath });
  }
}

addDir(ROOT);
archive.finalize();

output.on('close', () => {
  const mb = (archive.pointer() / 1024 / 1024).toFixed(2);
  console.log(`
✅  qa-hub-backend.zip created (${mb} MB)

Deploy to Elastic Beanstalk:
  1. AWS Console → Elastic Beanstalk → Create Application
     Platform: Node.js
     Upload: qa-hub-backend.zip

  2. Environment properties (Configuration → Software):
     NODE_ENV        = production
     PORT            = 8080
     ALLOWED_ORIGIN  = https://YOUR_CLOUDFRONT_URL
     UPLOAD_DIR      = /tmp
     ANTHROPIC_API_KEY = ...
     (add all keys from .env.example)

  3. Once deployed, copy the EB URL and re-run:
     node scripts/build-s3.js --api https://YOUR_EB_URL

  EB CLI shortcut (if configured):
     eb init && eb create qa-hub-prod && eb deploy
`);
});

archive.on('error', (e) => { console.error(e); process.exit(1); });
