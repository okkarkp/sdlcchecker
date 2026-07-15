/**
 * Hallucination guardrails — prompt injection text and post-generation structural validation.
 */

function getAntiHallucinationPrompt() {
  return `
━━━ ANTI-HALLUCINATION RULES (MANDATORY) ━━━
• Generate ONLY from content explicitly present in the requirements above.
• Do NOT invent URLs, field names, API endpoints, or business rules not stated.
• Do NOT assume generic web-app behaviour (login, CRUD, navigation) unless mentioned.
• Module names must come directly from the requirements text.
• If a requirement is ambiguous, note it as [UNCLEAR: reason] in the description field.
• Do NOT add scenarios for integrations or features not traceable to the provided input.
━━━ END ANTI-HALLUCINATION RULES ━━━
`;
}

const SC_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);
const SC_TYPES      = new Set(['functional', 'regression', 'integration', 'e2e', 'negative', 'performance']);
const TC_PRIORITIES = new Set(['Critical', 'High', 'Medium', 'Low']);
const TC_TYPES      = new Set(['Functional', 'Regression', 'Integration', 'E2E', 'Negative']);

/**
 * Validates generated scenarios structurally.
 * Returns { valid: Scenario[], warnings: string[] }
 */
function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios)) return { valid: [], warnings: ['AI did not return a scenarios array'] };

  const warnings = [];
  const seenIds  = new Set();
  const valid    = [];

  for (const sc of scenarios) {
    const id = sc.id || '?';

    if (!sc.title?.trim()) { warnings.push(`${id}: missing title — skipped`); continue; }

    if (!sc.module?.trim())
      warnings.push(`${id}: missing module — verify it is not hallucinated`);

    if (sc.priority && !SC_PRIORITIES.has(sc.priority.toLowerCase()))
      warnings.push(`${id}: unexpected priority "${sc.priority}" (expected critical|high|medium|low)`);

    if (sc.type && !SC_TYPES.has(sc.type.toLowerCase()))
      warnings.push(`${id}: unexpected type "${sc.type}"`);

    if (!sc.acceptance_criteria?.length)
      warnings.push(`${id}: no acceptance criteria — traceability may be weak`);

    if (seenIds.has(id)) {
      warnings.push(`Duplicate scenario ID "${id}" — suffixed`);
      sc.id = `${id}_${seenIds.size}`;
    }
    seenIds.add(sc.id);
    valid.push(sc);
  }

  return { valid, warnings };
}

/**
 * Validates generated test cases structurally.
 * Returns { valid: TestCase[], warnings: string[] }
 */
function validateTestCases(testcases) {
  if (!Array.isArray(testcases)) return { valid: [], warnings: ['AI did not return a testcases array'] };

  const warnings = [];
  const seenIds  = new Set();
  const valid    = [];

  for (const tc of testcases) {
    const id = tc.id || '?';

    if (!tc.title?.trim())  { warnings.push(`${id}: missing title — skipped`); continue; }
    if (!tc.steps?.length)  { warnings.push(`${id}: no steps — skipped`);      continue; }

    if (tc.steps.length > 25)
      warnings.push(`${id}: ${tc.steps.length} steps is unusually high — review for hallucination`);

    const emptyActions = tc.steps.filter(s => !s.action?.trim()).length;
    if (emptyActions)
      warnings.push(`${id}: ${emptyActions} step(s) have empty action text`);

    if (!tc.expected_result?.trim())
      warnings.push(`${id}: missing overall expected result`);

    if (tc.priority && !TC_PRIORITIES.has(tc.priority))
      warnings.push(`${id}: unexpected priority "${tc.priority}"`);

    if (tc.type && !TC_TYPES.has(tc.type))
      warnings.push(`${id}: unexpected type "${tc.type}"`);

    if (seenIds.has(id)) {
      warnings.push(`Duplicate TC ID "${id}" — suffixed`);
      tc.id = `${id}_${seenIds.size}`;
    }
    seenIds.add(tc.id);
    valid.push(tc);
  }

  return { valid, warnings };
}

module.exports = { getAntiHallucinationPrompt, validateScenarios, validateTestCases };
