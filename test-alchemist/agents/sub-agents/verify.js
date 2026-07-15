const BaseAgent = require('../base-agent');
const { callAI } = require('../../providers');

class VerifyAgent extends BaseAgent {
  constructor() {
    super('verify', 'Coverage Verifier', 'Cross-checks requirement coverage and test type distribution across all test scenarios and cases', '🔍');
  }

  async execute({ inputs = [], scenarios = [], testcases = [], applicationName = 'App' }, opts = {}) {
    const reqText = inputs
      .filter(i => i.type !== 'error')
      .map(i => `[${i.type.toUpperCase()}${i.filename ? ` – ${i.filename}` : ''}]\n${i.content}`)
      .join('\n\n---\n\n') || '(no raw requirements provided)';

    const prompt = `You are a senior QA verification specialist. Analyse whether the generated test scenarios and test cases adequately cover all requirements and include all required test types.

Application: ${applicationName}

ORIGINAL REQUIREMENTS:
${reqText.slice(0, 6000)}

GENERATED SCENARIOS (${scenarios.length}):
${JSON.stringify(scenarios.slice(0, 50), null, 2)}

GENERATED TEST CASES (${testcases.length}):
${JSON.stringify(testcases.slice(0, 30).map(tc => ({
  id: tc.id, title: tc.title, type: tc.type, priority: tc.priority,
  module: tc.module, stepsCount: tc.steps?.length
})), null, 2)}

Perform a thorough quality analysis:
1. Requirements Coverage — identify which functional requirements are tested and which are missing
2. Test Type Distribution — count each type: Positive, Negative, Boundary Value, Edge Case, Integration, E2E, Performance, Security
3. Module Coverage — identify any modules with insufficient coverage
4. Gaps — specific missing scenarios or test case types

Return ONLY this JSON (no markdown, no extra text):
{
  "overall_score": 82,
  "summary": "One-sentence executive summary of coverage quality",
  "coverage": {
    "covered_count": 8,
    "total_requirements": 10,
    "coverage_pct": 80,
    "covered": ["Requirement 1 description", "..."],
    "uncovered": ["Uncovered requirement description", "..."]
  },
  "type_distribution": {
    "Positive": 10,
    "Negative": 5,
    "Boundary Value": 3,
    "Edge Case": 2,
    "Integration": 4,
    "E2E": 3,
    "Performance": 0,
    "Security": 1
  },
  "module_coverage": [
    { "module": "Login", "scenario_count": 4, "tc_count": 8, "status": "good" },
    { "module": "Payment", "scenario_count": 1, "tc_count": 2, "status": "low" }
  ],
  "gaps": [
    {
      "area": "Password Reset",
      "issue": "No scenario found for this requirement",
      "test_types_missing": ["Negative", "Boundary Value"],
      "suggested_scenario": "Verify password reset with expired OTP returns appropriate error"
    }
  ],
  "recommendations": [
    "Add boundary value tests for all numeric input fields",
    "Add negative tests for invalid API token handling"
  ]
}`;

    const data = await callAI(prompt, 8192, opts);
    return {
      overall_score:      data.overall_score      ?? 0,
      summary:            data.summary             ?? '',
      coverage:           data.coverage            ?? {},
      type_distribution:  data.type_distribution   ?? {},
      module_coverage:    data.module_coverage     ?? [],
      gaps:               data.gaps                ?? [],
      recommendations:    data.recommendations     ?? [],
    };
  }
}

module.exports = new VerifyAgent();
