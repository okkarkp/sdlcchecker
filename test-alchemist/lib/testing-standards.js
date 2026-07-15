/**
 * Testing Standards — mandatory test coverage checklist injected into every
 * AI generation prompt. Loaded from data/testing-standards.json.
 */
const fs   = require('fs');
const path = require('path');

// Allow each project to supply its own standards file via env; default to the
// bundled neutral checklist under data/.
const STD_PATH = process.env.TESTING_STANDARDS_PATH
  ? path.resolve(process.env.TESTING_STANDARDS_PATH)
  : path.join(__dirname, '../data/testing-standards.json');

function getStandards() {
  try {
    if (!fs.existsSync(STD_PATH)) return null;
    return JSON.parse(fs.readFileSync(STD_PATH, 'utf-8'));
  } catch { return null; }
}

function saveStandards(data) {
  fs.writeFileSync(STD_PATH, JSON.stringify(data, null, 2));
}

/**
 * Returns the formatted standards block to inject into AI prompts.
 */
function getStandardsContext() {
  try {
    const std = getStandards();
    if (!std?.mandatoryAreas?.length) return '';

    const lines = [
      '\n━━━ MANDATORY TESTING STANDARDS (apply to EVERY generation) ━━━',
    ];

    if (std.namingConvention) lines.push(`TC Naming  : ${std.namingConvention}`);
    if (std.descriptionPattern) lines.push(`Description: ${std.descriptionPattern}`);
    if (std.companyTypes?.length) lines.push(`Company types to cover: ${std.companyTypes.join(' | ')}`);
    if (std.keyActors?.length) lines.push(`Key actors: ${std.keyActors.join(', ')}`);

    lines.push('\nMandatory coverage — generate TCs for EACH area applicable to the feature:');
    std.mandatoryAreas.forEach(area => {
      lines.push(`\n[${area.area.toUpperCase()}]`);
      area.checks.forEach(c => lines.push(`  • ${c}`));
    });

    lines.push('\n━━━ END MANDATORY TESTING STANDARDS ━━━\n');
    return lines.join('\n');
  } catch { return ''; }
}

/**
 * Short version for TC generation — just naming/format reminders.
 * The full checklist is only needed at scenario generation time; TC generation
 * just needs to know how to name and structure the output.
 */
function getStandardsContextShort() {
  try {
    const std = getStandards();
    if (!std) return '';
    const lines = ['\n━━━ TC STANDARDS (format & naming) ━━━'];
    if (std.namingConvention) lines.push(`Naming   : ${std.namingConvention}`);
    if (std.descriptionPattern) lines.push(`Title fmt: ${std.descriptionPattern}`);
    if (std.jiraIdFormat) lines.push(`Jira ID  : ${std.jiraIdFormat}`);
    if (std.companyTypes?.length) lines.push(`Company types to cover per scenario: ${std.companyTypes.join(', ')}`);
    lines.push('Ensure each TC covers its scenario acceptance criteria end-to-end.');
    lines.push('━━━ END TC STANDARDS ━━━\n');
    return lines.join('\n');
  } catch { return ''; }
}

module.exports = { getStandards, saveStandards, getStandardsContext, getStandardsContextShort, STD_PATH };
