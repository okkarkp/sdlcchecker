/**
 * Upload the built frontend (dist/) to an S3 bucket.
 *
 * Prerequisites:
 *   npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
 *   aws configure   (or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION)
 *
 * Usage:
 *   node scripts/upload-s3.js --bucket my-qa-hub-frontend [--region us-east-1]
 */

const fs   = require('fs');
const path = require('path');

const args   = process.argv.slice(2);
const getArg = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const BUCKET = getArg('--bucket') || process.env.S3_BUCKET;
const REGION = getArg('--region') || process.env.AWS_REGION || 'us-east-1';
const DIST   = path.join(__dirname, '..', 'dist');

if (!BUCKET) {
  console.error('\nUsage: node scripts/upload-s3.js --bucket my-bucket-name [--region us-east-1]\n');
  process.exit(1);
}

if (!fs.existsSync(DIST)) {
  console.error('\n❌  dist/ not found. Run: node scripts/build-s3.js --api https://... first\n');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff2':'font/woff2',
};

function allFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(full, base));
    else out.push({ full, key: path.relative(base, full).replace(/\\/g, '/') });
  }
  return out;
}

(async () => {
  let S3Client, PutObjectCommand;
  try {
    ({ S3Client, PutObjectCommand } = require('@aws-sdk/client-s3'));
  } catch {
    console.error('\n❌  AWS SDK not installed. Run:\n   npm install @aws-sdk/client-s3\n');
    process.exit(1);
  }

  const s3 = new S3Client({ region: REGION });
  const files = allFiles(DIST);

  console.log(`\nUploading ${files.length} files to s3://${BUCKET}/\n`);

  let ok = 0, err = 0;
  for (const { full, key } of files) {
    const ext         = path.extname(key);
    const ContentType = MIME[ext] || 'application/octet-stream';
    // Cache static assets for 1 year; HTML no-cache so updates are instant
    const CacheControl = ext === '.html' ? 'no-cache, no-store' : 'public, max-age=31536000, immutable';

    try {
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: fs.readFileSync(full),
        ContentType,
        CacheControl,
      }));
      console.log(`  ✅  ${key}`);
      ok++;
    } catch (e) {
      console.error(`  ❌  ${key} — ${e.message}`);
      err++;
    }
  }

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`  Uploaded: ${ok}   Errors: ${err}`);
  console.log(`${'═'.repeat(50)}`);

  if (err === 0) {
    console.log(`
  🌐  Frontend live at:
      http://${BUCKET}.s3-website-${REGION}.amazonaws.com

  (Point CloudFront at this bucket for HTTPS + CDN)
`);
  } else {
    process.exit(1);
  }
})();
