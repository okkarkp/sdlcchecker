#!/usr/bin/env node
/**
 * scripts/eval.js — measure generation QUALITY against a golden set.
 *
 * The honest answer to "is the AI output good enough?" is a number, not a vibe.
 * This runs each golden requirement through the real generation endpoint and
 * scores how much of the *expected coverage* the model actually produced, plus
 * volume and validation warnings. Point it at your configured model and track
 * the score as you tune prompts/models.
 *
 * Prereqs: the server must be running with a working AI provider.
 *   npm start                     # in one terminal (configure a provider first)
 *   npm run eval                  # in another
 *
 * Config (env, all optional):
 *   EVAL_BASE_URL   server base (default http://localhost:3000)
 *   EVAL_GOLDENSET  path to golden set (default scripts/eval-goldenset.json)
 *   EVAL_PROVIDER / EVAL_MODEL                     override provider + model
 *   EVAL_CUSTOM_BASE_URL / EVAL_CUSTOM_KEY / EVAL_CUSTOM_API_VERSION   for a custom endpoint
 *
 * NOTE: this measures *coverage* (did it hit the areas a good engineer would?),
 * a strong proxy for quality — not literal "survives review unedited". Extend the
 * golden set with your real requirements to make the number meaningful.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const BASE     = (process.env.EVAL_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const GS_PATH  = process.env.EVAL_GOLDENSET || path.join(__dirname, 'eval-goldenset.json');

function providerOpts() {
  const o = {};
  if (process.env.EVAL_PROVIDER) o.provider = process.env.EVAL_PROVIDER;
  if (process.env.EVAL_MODEL)    o.model    = process.env.EVAL_MODEL;
  if (process.env.EVAL_CUSTOM_BASE_URL)   o.customBaseUrl    = process.env.EVAL_CUSTOM_BASE_URL;
  if (process.env.EVAL_CUSTOM_KEY)        o.customApiKey     = process.env.EVAL_CUSTOM_KEY;
  if (process.env.EVAL_CUSTOM_API_VERSION) o.customApiVersion = process.env.EVAL_CUSTOM_API_VERSION;
  return o;
}

async function generate(item) {
  const res = await fetch(`${BASE}/api/ai/generate-scenarios`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'eval',
      applicationName: item.applicationName || 'App',
      inputs: [{ type: 'text', content: item.requirement }],
      ...providerOpts(),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

// Coverage = fraction of expected areas that appear anywhere in the scenario text.
function scoreItem(item, scenarios) {
  const hay = scenarios
    .map(s => `${s.title || ''} ${s.description || ''} ${(s.tags || []).join(' ')} ${(s.acceptance_criteria || []).join(' ')}`)
    .join(' ')
    .toLowerCase();
  const areas = item.expectAreas || [];
  const hit   = areas.filter(a => hay.includes(String(a).toLowerCase()));
  const missed = areas.filter(a => !hit.includes(a));
  return {
    count: scenarios.length,
    countOk: scenarios.length >= (item.expectMin || 1),
    coverage: areas.length ? hit.length / areas.length : 1,
    hit, missed,
  };
}

async function main() {
  let gs;
  try { gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf8')); }
  catch (e) { console.error(`Cannot read golden set at ${GS_PATH}: ${e.message}`); process.exit(1); }
  const items = gs.items || [];
  if (!items.length) { console.error('Golden set has no items.'); process.exit(1); }

  console.log(`\n⚗️  Test Alchemist — generation eval  (${items.length} items → ${BASE})\n`);

  const results = [];
  for (const item of items) {
    process.stdout.write(`• ${item.name} … `);
    try {
      const t0 = Date.now();
      const data = await generate(item);
      const scenarios = data.scenarios || [];
      const s = scoreItem(item, scenarios);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      results.push({ item, ...s, warnings: (data.warnings || []).length });
      const pct = Math.round(s.coverage * 100);
      console.log(`${s.count} scenarios · ${pct}% coverage${s.countOk ? '' : ' ⚠ under min'} · ${secs}s`);
      if (s.missed.length) console.log(`    missed: ${s.missed.join(', ')}`);
    } catch (e) {
      console.log(`FAILED — ${e.message}`);
      results.push({ item, count: 0, coverage: 0, countOk: false, missed: item.expectAreas || [], error: e.message });
    }
  }

  const avgCov  = results.reduce((a, r) => a + r.coverage, 0) / results.length;
  const totalSc = results.reduce((a, r) => a + r.count, 0);
  const failed  = results.filter(r => r.error || !r.countOk || r.coverage < 0.6);

  console.log('\n────────────────────────────────────────────');
  console.log(`Average coverage : ${Math.round(avgCov * 100)}%   (target ≥ 70%)`);
  console.log(`Total scenarios  : ${totalSc}`);
  console.log(`Items below bar  : ${failed.length}/${results.length}`);
  console.log('────────────────────────────────────────────');
  console.log(avgCov >= 0.7 && !failed.length
    ? '✓ Generation quality looks solid against this golden set.\n'
    : '⚠ Room to improve — inspect the "missed" areas above, then tune the prompt/model and re-run.\n');

  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('Eval failed:', e.message); process.exit(1); });
