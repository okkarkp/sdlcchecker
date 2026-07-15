/**
 * Auto-Reference Loader
 * On server startup, if reference-library.json is missing or stale,
 * reads all files from data/reference-source/, parses them, and runs
 * AI analysis — no manual upload needed.
 */
const fs   = require('fs');
const path = require('path');
const { parseFile }  = require('../parsers');
const { callAI }     = require('../providers');
const { getLibrary, saveLibrary } = require('./reference-library');

const SOURCE_DIR = path.join(__dirname, '../data/reference-source');
const MAX_CHARS  = 40000; // Keep prompt manageable

function getSourceFiles() {
  try {
    if (!fs.existsSync(SOURCE_DIR)) return [];
    return fs.readdirSync(SOURCE_DIR)
      .filter(f => /\.(csv|xlsx|xls|pdf|docx|doc|txt|md)$/i.test(f))
      .map(f => ({ name: f, path: path.join(SOURCE_DIR, f), mtime: fs.statSync(path.join(SOURCE_DIR, f)).mtimeMs }));
  } catch { return []; }
}

function isLibraryStale(sources) {
  const lib = getLibrary();
  if (!lib?.lastUpdated) return true;
  const libTime = new Date(lib.lastUpdated).getTime();
  return sources.some(s => s.mtime > libTime);
}

async function autoLoad(opts = {}) {
  const sources = getSourceFiles();
  if (!sources.length) return;
  if (!isLibraryStale(sources)) {
    console.log('[AutoRef] Reference library is up-to-date — skipping analysis');
    return;
  }

  console.log(`[AutoRef] Analysing ${sources.length} source file(s): ${sources.map(s => s.name).join(', ')}`);

  const parts = [];
  for (const src of sources) {
    try {
      const fake = { path: src.path, originalname: src.name };
      const text = await parseFile(fake);
      parts.push(`=== ${src.name} ===\n${text.slice(0, MAX_CHARS / sources.length)}`);
    } catch (e) {
      console.warn(`[AutoRef] Could not parse ${src.name}: ${e.message}`);
    }
  }

  if (!parts.length) return;
  const combined = parts.join('\n\n').slice(0, MAX_CHARS);

  const prompt = `You are a QA expert. Analyse this test case repository and extract patterns so future test case generation can follow the same conventions and avoid duplication.

TEST CASE DUMP:
${combined}

Return JSON with this exact shape:
{
  "summary": "One-line overview of this test suite",
  "tc_count": 0,
  "modules": ["Module A"],
  "naming_convention": "How test cases are named",
  "step_format": "How steps are written",
  "test_data_patterns": ["Pattern 1"],
  "coverage_areas": ["Area 1"],
  "existing_tc_ids": ["TC-001"],
  "tc_types_distribution": { "Functional": 60, "Regression": 25, "Integration": 15 },
  "patterns": ["Pattern 1"],
  "gaps_identified": ["Gap 1"]
}

Return ONLY the JSON.`;

  try {
    const analysis = await callAI(prompt, 8192, opts);
    saveLibrary({ lastUpdated: new Date().toISOString(), sourceFiles: sources.map(s => s.name), analysis });
    console.log(`[AutoRef] Library built — ${analysis.tc_count || '?'} TCs, ${(analysis.modules || []).length} modules`);
    global.broadcast?.({ type: 'reference_library_updated', tcCount: analysis.tc_count, auto: true });
  } catch (e) {
    console.warn(`[AutoRef] AI analysis failed: ${e.message}. Will retry next restart.`);
  }
}

module.exports = { autoLoad, getSourceFiles, isLibraryStale };
