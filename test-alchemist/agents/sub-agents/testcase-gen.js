const BaseAgent = require('../base-agent');
const { callAI } = require('../../providers');
const { getReferenceContext } = require('../../lib/reference-library');
const { getStandardsContextShort } = require('../../lib/testing-standards');
const { getAntiHallucinationPrompt, validateTestCases } = require('../../lib/hallucination-guard');
const { twinPromptForHint } = require('../../lib/twin/context');

const BATCH_SIZE   = 5; // scenarios per AI call
const CONCURRENCY  = 3; // parallel AI calls

class TestCaseGenAgent extends BaseAgent {
  constructor() {
    super('testcase-gen', 'Test Case Generator', 'Generates Jira-format test cases from scenarios using AI', '📋');
  }

  async execute({ scenarios, applicationName = 'Web Application', baseUrl = 'https://your-app.com' }, opts = {}) {
    // Split into batches
    const batches = [];
    for (let i = 0; i < scenarios.length; i += BATCH_SIZE) {
      batches.push(scenarios.slice(i, i + BATCH_SIZE));
    }

    // Process in parallel waves (CONCURRENCY at a time)
    const rawTcs = [];
    for (let g = 0; g < batches.length; g += CONCURRENCY) {
      const wave = batches.slice(g, g + CONCURRENCY);
      global.broadcast?.({
        type: 'progress', step: 'testcases',
        status: `group ${Math.floor(g / CONCURRENCY) + 1} of ${Math.ceil(batches.length / CONCURRENCY)}`,
      });

      const results = await Promise.allSettled(
        wave.map(batch => this._callBatch(batch, applicationName, baseUrl, opts))
      );
      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') rawTcs.push(...r.value);
        else console.error(`[TC agent batch ${g + idx + 1}]`, r.reason?.message);
      });
    }

    // Re-number IDs sequentially after parallel merge
    const renumbered = rawTcs.map((tc, i) => ({
      ...tc,
      id: `TC-${String(i + 1).padStart(3, '0')}`,
    }));

    const { valid: testcases } = validateTestCases(renumbered);
    return { testcases, count: testcases.length };
  }

  async _callBatch(scenarios, applicationName, baseUrl, opts) {
    const refCtx = getReferenceContext();
    const stdCtx = getStandardsContextShort();
    const ahCtx  = getAntiHallucinationPrompt();
    // Digital Twin grounding: match this batch's module/title to a crawled route.
    const hint    = scenarios[0]?.module || scenarios[0]?.route || scenarios[0]?.title || '';
    const twinCtx = twinPromptForHint(hint);
    const prompt = `Generate detailed, automation-ready test cases for the scenarios below using Jira/Xray format.

Application: ${applicationName}  Base URL: ${baseUrl}
${refCtx}${stdCtx}${ahCtx}${twinCtx}
SCENARIOS:
${JSON.stringify(scenarios, null, 2)}

Return JSON:
{
  "testcases": [
    {
      "id": "TC-001",
      "scenario_id": "TS-001",
      "title": "Test case title",
      "module": "Module name",
      "priority": "Critical|High|Medium|Low",
      "type": "Functional|Regression|Integration|E2E|Negative",
      "preconditions": [],
      "test_data": {},
      "steps": [
        { "step_number": 1, "action": "Navigate to login page", "test_data": "", "expected_result": "Login page displayed" }
      ],
      "expected_result": "Overall outcome",
      "status": "Not Executed",
      "automation_notes": "selector hints",
      "labels": ["regression"],
      "jira_fields": { "issue_type": "Test", "priority": "High", "labels": [], "components": [] }
    }
  ]
}

CRITICAL: Write out EVERY test case in full. Do NOT abbreviate, truncate, or write "// ... N more". Return ONLY valid JSON.`;

    const data = await callAI(prompt, 8192, opts);
    return data.testcases || [];
  }
}

module.exports = new TestCaseGenAgent();
