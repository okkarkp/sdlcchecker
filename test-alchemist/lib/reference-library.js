/**
 * Reference Library — persists and loads the AI's understanding of the
 * existing test suite so every generation stays consistent and non-duplicate.
 */
const fs   = require('fs');
const path = require('path');

const LIB_PATH = path.join(__dirname, '../data/reference-library.json');

function getLibrary() {
  try {
    if (!fs.existsSync(LIB_PATH)) return null;
    return JSON.parse(fs.readFileSync(LIB_PATH, 'utf-8'));
  } catch { return null; }
}

function saveLibrary(data) {
  const dir = path.dirname(LIB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LIB_PATH, JSON.stringify(data, null, 2));
}

function deleteLibrary() {
  if (fs.existsSync(LIB_PATH)) fs.unlinkSync(LIB_PATH);
}

/**
 * Returns a formatted string to inject into AI prompts.
 * Returns empty string when no library exists.
 */
function getReferenceContext() {
  try {
    const lib = getLibrary();
    if (!lib?.analysis) return '';
    const a = lib.analysis;
    const lines = [
      '\n━━━ REFERENCE LIBRARY (your existing test suite) ━━━',
      `Summary        : ${a.summary || ''}`,
      `Total TCs      : ${a.tc_count || 0}`,
      `Modules        : ${(a.modules || []).join(', ')}`,
      `Naming style   : ${a.naming_convention || 'N/A'}`,
      `Step format    : ${a.step_format || 'N/A'}`,
      `Coverage areas : ${(a.coverage_areas || []).join(', ')}`,
    ];
    if (a.patterns?.length) {
      lines.push('Patterns:');
      a.patterns.forEach(p => lines.push(`  • ${p}`));
    }
    if (a.gaps_identified?.length) {
      lines.push(`Known gaps     : ${a.gaps_identified.join(' | ')}`);
    }
    if (a.existing_tc_ids?.length) {
      lines.push(`Existing IDs   : ${a.existing_tc_ids.join(', ')}`);
      lines.push('↑ Do NOT generate test cases with these IDs or duplicate their coverage.');
    }
    lines.push('━━━ END REFERENCE LIBRARY ━━━\n');
    return lines.join('\n');
  } catch { return ''; }
}

module.exports = { getReferenceContext, getLibrary, saveLibrary, deleteLibrary, LIB_PATH };
