const BaseAgent = require('../base-agent');
const { callAI } = require('../../providers');
const { getReferenceContext } = require('../../lib/reference-library');
const { getStandardsContext } = require('../../lib/testing-standards');
const { getAntiHallucinationPrompt, validateScenarios } = require('../../lib/hallucination-guard');
const { twinPromptForHint } = require('../../lib/twin/context');

class ScenarioGenAgent extends BaseAgent {
  constructor() {
    super('scenario-gen', 'Scenario Generator', 'Generates structured test scenarios from requirements using AI', '🎯');
  }

  async execute({ inputs, applicationName = 'Web Application', applicationContext = '' }, opts = {}) {
    const combined = inputs
      .filter(i => i.type !== 'error')
      .map(i => `[${i.type.toUpperCase()}${i.filename ? ` – ${i.filename}` : ''}]\n${i.content}`)
      .join('\n\n---\n\n');

    const refCtx = getReferenceContext();
    const stdCtx = getStandardsContext();
    const ahCtx  = getAntiHallucinationPrompt();
    // Digital Twin grounding — best-effort match from app context/name (no-ops if none).
    const twinCtx = twinPromptForHint(applicationContext || applicationName);
    const prompt = `You are a senior QA architect. Analyse the requirements below and generate comprehensive test scenarios.

Application: ${applicationName}
Context: ${applicationContext}
${refCtx}${stdCtx}${ahCtx}${twinCtx}
REQUIREMENTS:
${combined}

Return JSON:
{
  "scenarios": [
    {
      "id": "TS-001",
      "title": "Scenario title",
      "module": "Module name",
      "description": "One-line description",
      "type": "functional|regression|integration|e2e|negative|performance",
      "priority": "critical|high|medium|low",
      "tags": ["smoke"],
      "acceptance_criteria": ["AC-1"]
    }
  ]
}

Rules: cover happy path, negative, edge cases, boundary conditions. Group by module. Return ONLY JSON.`;

    const data = await callAI(prompt, 8192, opts);
    const { valid: scenarios, warnings } = validateScenarios(data.scenarios);
    return { scenarios, count: scenarios.length, warnings };
  }
}

module.exports = new ScenarioGenAgent();
