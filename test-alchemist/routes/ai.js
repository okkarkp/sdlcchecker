const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { callAI, MODELS } = require('../providers');
const { parseFile } = require('../parsers');
const refLib          = require('../lib/reference-library');
const testStd         = require('../lib/testing-standards');
const autoRef         = require('../lib/auto-reference');
const sessionStore    = require('../lib/session-store');
const hGuard          = require('../lib/hallucination-guard');
const db              = require('../lib/db');
const { getAppMapContext } = require('../lib/app-crawler');
const { getFigmaContext }  = require('../lib/figma-parser');

const upload = multer({ dest: process.env.UPLOAD_DIR || 'uploads/', limits: { fileSize: 50 * 1024 * 1024 } });

// ── Helpers ────────────────────────────────────────────────────────────────────
function fileType(filename) {
  const map = { '.pdf': 'pdf', '.xlsx': 'excel', '.xls': 'excel',
    '.docx': 'word', '.doc': 'word', '.pptx': 'pptx', '.ppt': 'pptx',
    '.txt': 'text', '.md': 'markdown', '.csv': 'csv' };
  return map[path.extname(filename).toLowerCase()] || 'text';
}

// Extract AI provider opts from any request body
function extractAiOpts(body) {
  return {
    provider:        body.provider,
    model:           body.model,
    anthropicApiKey: body.anthropicApiKey,
    openaiApiKey:    body.openaiApiKey,
    geminiApiKey:    body.geminiApiKey,
    copilotToken:    body.copilotToken,
    // Custom / OpenAI-compatible endpoint (gateway · local · Azure)
    customBaseUrl:   body.customBaseUrl,
    customApiKey:    body.customApiKey,
    customApiVersion: body.customApiVersion,
  };
}

// ── POST /api/ai/parse-inputs ──────────────────────────────────────────────────
router.post('/parse-inputs', upload.array('files', 10), async (req, res) => {
  try {
    const inputs = [];
    const { userStory, requirements, rules, codebaseContext, codebaseModule } = req.body;
    if (userStory)    inputs.push({ type: 'user_story',    content: userStory });
    if (requirements) inputs.push({ type: 'requirements', content: requirements });
    if (rules)        inputs.push({ type: 'rules',        content: rules });
    if (codebaseContext) inputs.push({ type: 'source_code', module: codebaseModule || '', content: codebaseContext });

    for (const file of req.files || []) {
      try {
        const content = await parseFile(file);
        inputs.push({ type: fileType(file.originalname), filename: file.originalname, content });
      } catch (e) {
        inputs.push({ type: 'error', filename: file.originalname, content: e.message });
      } finally {
        try { fs.unlinkSync(file.path); } catch {}
      }
    }

    const clientId = req.body.clientId || 'anon';
    global.broadcastTo(clientId, { type: 'exec:step', event: 'done', stepKey: 'inputs', name: 'Input Parser' });
    global.broadcast({ type: 'inputs_parsed', count: inputs.length });
    res.json({ success: true, inputs });
  } catch (err) {
    global.broadcastTo(req.body.clientId || 'anon', { type: 'exec:step', event: 'error', stepKey: 'inputs', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/generate-scenarios ───────────────────────────────────────────
router.post('/generate-scenarios', async (req, res) => {
  try {
    const { inputs, applicationName = 'Web Application', applicationContext = '' } = req.body;
    const clientId = req.body.clientId || 'anon';
    const aiOpts   = extractAiOpts(req.body);
    aiOpts.broadcastFn = msg => global.broadcastTo(clientId, { ...msg, logStep: 3 });
    global.broadcastTo(clientId, { type: 'progress', step: 'scenarios', status: 'generating' });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'start', stepKey: 'scenarios', name: 'Scenario Agent' });

    const combined = inputs
      .filter((i) => i.type !== 'error')
      .map((i) => `[${i.type.toUpperCase()}${i.filename ? ` – ${i.filename}` : ''}]\n${i.content}`)
      .join('\n\n---\n\n');

    // ── Inject relevant knowledge entries ────────────────────────────────────
    const module = inputs?.[0]?.module || applicationName;
    const kwTokens = combined.split(/\s+/).filter(w => w.length > 5).slice(0, 20);
    const knowledgeEntries = clientId !== 'anon'
      ? db.getRelevantKnowledge(clientId, module, kwTokens, 12)
      : [];

    // Separate FRD requirements from rules/guidance
    const frdEntries  = knowledgeEntries.filter(k => k.kind === 'requirement');
    const ruleEntries = knowledgeEntries.filter(k => k.kind !== 'requirement');

    const frdCtx = frdEntries.length
      ? '\n\nFUNCTIONAL REQUIREMENTS (from Confluence FRD — use this to understand the full functional flow):\n' +
        frdEntries.map(k => `[${k.trigger_text || 'FRD'}]\n${k.guidance}`).join('\n\n') + '\n'
      : '';
    const knowledgeCtx = ruleEntries.length
      ? '\n\nLearned guidance from previous sessions — apply these rules:\n' +
        ruleEntries.map(k => `• ${k.guidance}`).join('\n') + '\n'
      : '';

    const refCtx  = refLib.getReferenceContext();
    const stdCtx  = testStd.getStandardsContext();
    const ahCtx   = hGuard.getAntiHallucinationPrompt();

    // Check if source code context was included in inputs
    const codeInputs = inputs.filter(i => i.type === 'source_code');
    const codeCtx = codeInputs.length
      ? '\n\nSOURCE CODE CONTEXT (use this to identify testable endpoints, validations, error handling, and edge cases):\n' +
        codeInputs.map(i => i.content).join('\n\n') + '\n'
      : '';

    // App Map context (from Figma or live crawl)
    let appMapCtx = '';
    try {
      const appMapEntries = db.listKnowledge(clientId).filter(k => k.kind === 'app_map');
      if (appMapEntries.length) {
        const appMap = JSON.parse(appMapEntries[0].guidance);
        appMapCtx = appMap.source?.includes('figma')
          ? getFigmaContext(appMap)
          : getAppMapContext(appMap);
      }
    } catch (_) {}

    const prompt  = `You are a senior QA architect. Analyse the requirements below and generate comprehensive test scenarios.

Application: ${applicationName}
Context: ${applicationContext}${frdCtx}${knowledgeCtx}${codeCtx}${appMapCtx}
${refCtx}${stdCtx}${ahCtx}
REQUIREMENTS:
${combined}

Return JSON with this exact shape:
{
  "scenarios": [
    {
      "id": "TS-001",
      "title": "Scenario title",
      "module": "Module / Feature name",
      "description": "One-line description",
      "type": "functional|regression|integration|e2e|negative|performance",
      "priority": "critical|high|medium|low",
      "tags": ["smoke", "regression"],
      "acceptance_criteria": ["AC-1", "AC-2"]
    }
  ]
}

Rules:
• Cover the full spectrum — do not stop at the happy path. Explicitly include, where applicable:
  – Boundary & limits: min/max length, zero, empty, whitespace-only, very large values, off-by-one.
  – Invalid input: wrong format/type, special characters, injection-like payloads, malformed data.
  – Negative & error paths: rejected actions, validation messages, failed dependencies, timeouts/network errors.
  – State & concurrency: unauthenticated/expired session, insufficient permissions, duplicate/concurrent submits, back-navigation, refresh mid-flow.
  – Integration & data: upstream/downstream API failures, empty result sets, pagination edges.
• Prefer breadth of realistic edge cases over many near-duplicate happy-path variants.
• Group by module/feature.
• Tag scenarios with smoke, regression, e2e as appropriate.
• id MUST use TS-### format (e.g. TS-001, TS-002). NEVER use TC in the id.
• title MUST be a short readable phrase (e.g. "Valid search returns matching results"). NEVER embed TC###, TS###, or any ID code inside the title string.
• Return ONLY the JSON, no surrounding text.`;

    const data = await callAI(prompt, 8192, aiOpts);
    const { valid: scenarios, warnings } = hGuard.validateScenarios(data.scenarios);

    // Grounding nudge — generation is far more accurate when grounded in a crawled
    // Digital Twin (real routes/elements/APIs). Warn (don't block) when there is none.
    try {
      const twinPages = db.db.prepare("SELECT COUNT(*) AS n FROM twin_pages WHERE deleted_at IS NULL").get()?.n || 0;
      if (!twinPages) {
        warnings.push('No Digital Twin crawled — scenarios are ungrounded. Crawl the target app (Reference Library → Digital Twin) for higher accuracy.');
      }
    } catch (_) {}

    // Persist to session
    if (clientId !== 'anon') {
      sessionStore.saveSession(clientId, { scenarios, applicationName });
    }

    global.broadcastTo(clientId, { type: 'scenarios_generated', count: scenarios.length });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'done', stepKey: 'scenarios', name: 'Scenario Agent' });

    // ── Persist generation + scenarios to SQLite ─────────────────────────────
    let generationId = null;
    if (clientId !== 'anon' && scenarios.length) {
      try {
        const firstInput = inputs?.[0] || {};
        // Use the user-provided name (mandatory field in UI) as the title
        const userTitle = req.body.generationName?.trim();
        const title = userTitle
          || (applicationName !== 'Web Application' ? applicationName : null)
          || firstInput.filename?.replace(/\+/g, ' ').replace(/\.[^.]+$/, '')
          || firstInput.content?.slice(0, 60)
          || 'Generated scenarios';
        generationId = db.saveGeneration({
          clientId,
          title,
          sourceType: firstInput.type === 'jira' ? 'jira' : firstInput.filename ? 'file' : 'text',
          sourceRef: firstInput.filename || null,
          appName: applicationName,
          module: scenarios[0]?.module || null,
          requirementText: combined.slice(0, 4000),
        });
        db.saveScenarios(generationId, clientId, scenarios);
        db.updateGenerationCounts(generationId, scenarios.length, 0);
        global.broadcastTo(clientId, { type: 'generation_saved', generationId, scenarioCount: scenarios.length });
      } catch (dbErr) {
        console.warn('[DB] Failed to persist generation:', dbErr.message);
      }
    }

    res.json({ success: true, scenarios, generationId, warnings: warnings.length ? warnings : undefined });
  } catch (err) {
    global.broadcastTo(req.body.clientId || 'anon', { type: 'exec:step', event: 'error', stepKey: 'scenarios', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/generate-testcases ───────────────────────────────────────────
const TC_BATCH_SIZE  = 3;   // scenarios per AI call (smaller = fuller steps, less truncation)
const TC_CONCURRENCY = 3;   // max parallel AI calls

// Build authoritative App Flow context for the MODULE(s) being generated in this batch.
// The App Flow Map holds clear, ordered step sequences per module — the TC steps for that
// module MUST follow its flow. Scoped strictly to the batch's module(s): a flow is only
// included when its module matches a scenario's module. No module match → no flow context
// (we never dump unrelated flows into the prompt).
function getAppFlowContext(clientId, scenarios) {
  if (!clientId || clientId === 'anon') return '';
  let flows = [];
  try { flows = db.getAppFlows(clientId); } catch { return ''; }
  if (!flows.length) return '';

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const scenMods = [...new Set((scenarios || []).map(s => norm(s.module)).filter(Boolean))];
  if (!scenMods.length) return '';   // can't scope to a module → don't inject any flow

  // A flow is identified by its module (fall back to its name). Prefer an EXACT module
  // match; only if there are none, allow containment (e.g. "Login" vs "User Login").
  const flowKey = (f) => norm(f.module) || norm(f.name);
  const exact = flows.filter(f => { const k = flowKey(f); return k && scenMods.includes(k); });
  const fuzzy = flows.filter(f => { const k = flowKey(f); return k && !scenMods.includes(k) && scenMods.some(sm => sm.includes(k) || k.includes(sm)); });
  const use = (exact.length ? exact : fuzzy).slice(0, 4);
  if (!use.length) return '';

  const lines = ['=== DOCUMENTED APP FLOW(S) FOR THIS MODULE (authoritative — base the test steps on these) ==='];
  for (const f of use) {
    lines.push(`\nFlow: ${f.name}${f.module ? ` [module: ${f.module}]` : ''}${f.description ? ` — ${f.description}` : ''}`);
    (f.steps || []).forEach((s, i) => {
      lines.push(`  ${i + 1}. ${s.title || ''}${s.description ? ` — ${s.description}` : ''}${s.rule ? ` (rule: ${s.rule})` : ''}`);
    });
  }
  lines.push('\nFor any test case in this module, the steps MUST follow the flow\'s step order above — expand each flow step into a concrete Action + Expected Result. Do NOT invent a different navigation path.');
  lines.push('=== END APP FLOW ===');
  return lines.join('\n');
}

async function generateTcBatch(scenarios, applicationName, baseUrl, aiOpts, appMapCtx = '', appFlowCtx = '') {
  const scenTitles = scenarios.map(s => s.title || s.id).join(', ');
  aiOpts?.broadcastFn?.({ type: 'ai_log', logStep: 4,
    message: `Batch: ${scenarios.length} scenario(s) → ${scenTitles.substring(0, 80)}${scenTitles.length > 80 ? '…' : ''}` });

  const refCtx = refLib.getReferenceContext();
  const stdCtx = testStd.getStandardsContextShort();
  const ahCtx  = hGuard.getAntiHallucinationPrompt();
  const prompt = `Generate detailed, automation-ready test cases for the scenarios below using Jira/Xray format.

Application: ${applicationName}  Base URL: ${baseUrl}
${refCtx}${stdCtx}${ahCtx}${appMapCtx ? '\n' + appMapCtx : ''}${appFlowCtx ? '\n' + appFlowCtx : ''}
SCENARIOS:
${JSON.stringify(scenarios, null, 2)}

CRITICAL: The "scenario_id" in each test case MUST exactly match the "id" field of the scenario it belongs to from the list above (e.g. if the scenario has "id": "TS-050", use "scenario_id": "TS-050"). Do NOT renumber or reset scenario IDs.

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
        { "step_number": 1, "action": "Navigate to the application URL", "test_data": "${baseUrl}", "expected_result": "Home page is displayed" },
        { "step_number": 2, "action": "Perform the next action", "test_data": "", "expected_result": "Expected outcome" }
      ],
      "expected_result": "Overall outcome of the entire test case",
      "status": "Not Executed",
      "automation_notes": "selector hints",
      "labels": ["regression"],
      "jira_fields": { "issue_type": "", "priority": "High", "labels": [], "components": [] }
    }
  ]
}

RULES FOR TEST STEPS — MANDATORY:
- Every test case MUST be 100% self-contained and independently executable from scratch.
- NEVER reference other test cases (e.g. do NOT write "as in TC001", "continue from TC002", "see previous test", "after completing login test").
- NEVER assume any prior state from another test case. Each test case starts fresh.
- The FIRST step of EVERY test case must be navigating to the application entry point (e.g. "Launch the application URL" or "Navigate to the login page").
- If the test requires a logged-in user, include the login steps explicitly within this test case as the first 2-3 steps.
- Include ALL intermediate steps — do not skip steps that are obvious or repetitive. A tester should be able to execute this test case with zero prior knowledge.
- Each step must have a clear, specific Action and a verifiable Expected Result.
- Minimum 4 steps per test case; complex flows should have 6-10+ steps.
- Steps must flow logically from start (open app) to end (verify final outcome).

RULES FOR PRECONDITIONS:
- List only meaningful business/functional prerequisites (e.g. "User must have an active account", "Feature flag X must be enabled").
- Do NOT include the test environment, application name, base URL, or any reference to where the test is run.
- Do NOT generate lines like "Test environment is … on https://…" or "Application is accessible at …".

CRITICAL: Write EVERY test case COMPLETELY in full. Do NOT abbreviate, truncate, summarise steps, or write "// ... more steps". Every step must be written out in full detail. Return ONLY valid JSON — no text outside the JSON.`;

  const data = await callAI(prompt, 16000, aiOpts);
  return data.testcases || [];
}

router.post('/generate-testcases', async (req, res) => {
  try {
    const { scenarios, applicationName = 'Web Application', baseUrl = 'https://your-app.com' } = req.body;
    const tcOffset = parseInt(req.body.tcOffset, 10) || 0; // continue numbering from existing TCs
    const clientId = req.body.clientId || 'anon';

    // Derive TC prefix from reference library naming convention
    const lib = refLib.getLibrary();
    let tcPrefix = 'TC';
    let tcPadding = 3; // default zero-padding width
    if (lib?.analysis?.existing_tc_ids?.length) {
      // Extract prefix from the most common ID pattern (e.g. "PROJ-182065" → "PROJ", "TC-001" → "TC")
      const ids = lib.analysis.existing_tc_ids;
      const prefixes = ids
        .map(id => id.replace(/[-_]?\d+$/, ''))
        .filter(Boolean);
      if (prefixes.length) {
        // Use most frequent prefix
        const freq = {};
        prefixes.forEach(p => { freq[p] = (freq[p] || 0) + 1; });
        tcPrefix = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
      }
      // Determine padding from existing IDs with this prefix
      const matchingIds = ids.filter(id => id.startsWith(tcPrefix));
      const nums = matchingIds.map(id => {
        const m = id.match(/(\d+)$/);
        return m ? m[1].length : 3;
      });
      if (nums.length) tcPadding = Math.max(...nums);
    }

    const aiOpts   = extractAiOpts(req.body);
    aiOpts.broadcastFn = msg => global.broadcastTo(clientId, { ...msg, logStep: 4 });
    global.broadcastTo(clientId, { type: 'progress', step: 'testcases', status: 'starting…' });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'start', stepKey: 'testcases', name: 'TC Generator' });

    // Load app map context for TC generation (pages, forms, navigation)
    let appMapCtx = '';
    try {
      const appMapEntries = db.listKnowledge(clientId).filter(k => k.kind === 'app_map');
      if (appMapEntries.length) {
        const appMap = JSON.parse(appMapEntries[0].guidance);
        appMapCtx = appMap.source?.includes('figma')
          ? getFigmaContext(appMap)
          : getAppMapContext(appMap);
      }
    } catch (_) {}

    // Split into batches
    const batches = [];
    for (let i = 0; i < scenarios.length; i += TC_BATCH_SIZE) {
      batches.push(scenarios.slice(i, i + TC_BATCH_SIZE));
    }

    // Process in parallel waves (TC_CONCURRENCY at a time) for speed
    const rawTcs    = [];
    const batchErrs = [];

    for (let g = 0; g < batches.length; g += TC_CONCURRENCY) {
      const wave = batches.slice(g, g + TC_CONCURRENCY);
      const groupNum   = Math.floor(g / TC_CONCURRENCY) + 1;
      const totalGroups = Math.ceil(batches.length / TC_CONCURRENCY);
      global.broadcastTo(clientId, {
        type: 'progress', step: 'testcases',
        status: `group ${groupNum} of ${totalGroups}`,
      });
      global.broadcastTo(clientId, {
        type: 'exec:progress', stepKey: 'testcases',
        pct: Math.min(0.95, (g / batches.length)),
      });

      const results = await Promise.allSettled(
        wave.map(batch => generateTcBatch(batch, applicationName, baseUrl, aiOpts, appMapCtx, getAppFlowContext(clientId, batch)))
      );

      results.forEach((r, idx) => {
        if (r.status === 'fulfilled') rawTcs.push(...r.value);
        else {
          const msg = r.reason?.message || 'unknown error';
          console.error(`[TC batch ${g + idx + 1}]`, msg);
          batchErrs.push(`Batch ${g + idx + 1} failed: ${msg}`);
        }
      });
    }

    // Re-number IDs sequentially after parallel merge (continue from existing count)
    // Also fix scenario_id to match actual scenarios sent
    const scenIdList = scenarios.map(s => s.id);
    const renumbered = rawTcs.map((tc, i) => {
      // Fix scenario_id: if the AI hallucinated a wrong ID, map it back
      let scenId = tc.scenario_id;
      if (!scenIdList.includes(scenId)) {
        // Try to match by index pattern (e.g. AI wrote TS-001 but actual is TS-050)
        const idxMatch = scenId?.match(/(\d+)$/);
        const idx = idxMatch ? parseInt(idxMatch[1], 10) - 1 : i;
        scenId = scenIdList[Math.min(idx, scenIdList.length - 1)] || scenIdList[0];
      }
      return {
        ...tc,
        id: `${tcPrefix}-${String(tcOffset + i + 1).padStart(tcPadding, '0')}`,
        scenario_id: scenId,
      };
    });

    const { valid: testcases, warnings } = hGuard.validateTestCases(renumbered);
    const allWarnings = [...batchErrs, ...warnings];

    if (clientId !== 'anon') {
      sessionStore.saveSession(clientId, { testcases, applicationName, baseUrl });
    }

    global.broadcastTo(clientId, { type: 'testcases_generated', count: testcases.length });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'done', stepKey: 'testcases', name: 'TC Generator' });

    // ── Persist test cases to SQLite ─────────────────────────────────────────
    let savedGenerationId = req.body.generationId || null;
    const userTitle = req.body.generationName?.trim();
    if (clientId !== 'anon' && testcases.length) {
      try {
        // Reuse the scenario generation row if a generationId was passed,
        // otherwise create a new row using the user's entered name
        if (!savedGenerationId) {
          savedGenerationId = db.saveGeneration({
            clientId,
            title: userTitle || (applicationName !== 'Web Application' ? applicationName : `TC run ${new Date().toLocaleTimeString()}`),
            sourceType: 'text',
            appName: applicationName,
            requirementText: '',
          });
        } else {
          // Update tc_count on the existing generation row
          const gen = db.getGeneration(savedGenerationId, clientId);
          if (!gen) savedGenerationId = null; // generation belongs to different client — make a new one
        }
        if (savedGenerationId) {
          // Build scenarioMap: AI-generated sc_id (e.g. "TS-001") → DB scenario UUID
          // so test_case.scenario_id gets the real FK value, not null
          const scenarioMap = {};
          try {
            const dbScens = db.getScenariosForGeneration(savedGenerationId);
            dbScens.forEach(s => { if (s.sc_id) scenarioMap[s.sc_id] = s.id; });
          } catch (_) {}
          db.saveTestCases(savedGenerationId, clientId, testcases, scenarioMap);
          // Increment tc_count rather than overwrite — handles multiple TC runs on the same generation
          db.incrementTcCount(savedGenerationId, testcases.length);
          global.broadcastTo(clientId, { type: 'tcs_saved', generationId: savedGenerationId, tcCount: testcases.length });
        }
      } catch (dbErr) {
        console.warn('[DB] Failed to persist test cases:', dbErr.message);
      }
    }

    res.json({
      success: true,
      testcases,
      generationId: savedGenerationId,
      count: testcases.length,
      warnings: allWarnings.length ? allWarnings : undefined,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/generate-playwright ──────────────────────────────────────────
const repoCtx = require('../lib/repo-context');

// Shared rules that make generated Playwright resilient instead of flaky.
const PW_RESILIENCE_RULES = `
RESILIENT LOCATOR & STABILITY RULES (write tests that don't flake):
• Prefer user-facing locators, in this order: page.getByRole(role, { name }) → getByLabel → getByPlaceholder → getByText → getByTestId ([data-testid]).
  Use CSS only as a last resort and NEVER nth-child, absolute XPath, or auto-generated/hashed class names.
• Use web-first, auto-waiting assertions: await expect(locator).toBeVisible() / toHaveText() / toHaveValue(). Do NOT assert on ElementHandles or raw booleans.
• NEVER use page.waitForTimeout() or hard sleeps — rely on Playwright auto-waiting and expect() retries. Use expect(...).toBeVisible() to wait for state.
• await every action and assertion. Keep all locators as Page Object fields; read credentials/data by field name, never hardcode secrets.
• Scope locators to a container when a name is ambiguous (e.g., getByRole within a section) to avoid strict-mode violations.`;

router.post('/generate-playwright', async (req, res) => {
  try {
    const { testcases, baseUrl = process.env.APP_BASE_URL || '', applicationName = process.env.APP_NAME || 'the application' } = req.body;
    const clientId = req.body.clientId || 'anon';
    const aiOpts   = extractAiOpts(req.body);
    aiOpts.broadcastFn = msg => global.broadcastTo(clientId, { ...msg, logStep: 5 });
    global.broadcastTo(clientId, { type: 'progress', step: 'playwright', status: 'generating' });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'start', stepKey: 'playwright', name: 'Playwright Builder' });

    // Lock in the connected automation repo for this run (same path the Automate flow
    // uses) so Step 6 generation follows the repo's conventions instead of falling back
    // to a generic prompt. Without this, usingRepo was always false unless the env var
    // AUTOMATION_REPO_PATH was set — which is why generated scripts didn't match the repo.
    const repoPath = req.body.repoPath;
    if (repoPath) repoCtx.setRepoPath(repoPath);

    // Inject automation repo context when available
    const repoContext = repoCtx.buildCompactContext(repoPath);
    const usingRepo   = repoCtx.repoExists(repoPath);
    const pagesDir    = repoCtx.getPageObjectsDir(repoPath);
    const specsDir    = repoCtx.getSpecsDir();
    global.broadcastTo(clientId, { type: 'ai_log', logStep: 5,
      message: usingRepo ? `📁 Using connected repo conventions (${pagesDir}/, ${specsDir}/)` : '⚠ No automation repo connected — generating generic POM scripts' });

    const prompt = usingRepo ? `
${repoContext}

You are generating Playwright automation tests for ${applicationName}.
Follow the repo patterns shown above EXACTLY — match the existing seed spec structure,
the page object conventions, and the framework's module/import style.

Application: ${applicationName}
Base URL: ${baseUrl}

TEST CASES TO AUTOMATE:
${JSON.stringify(testcases, null, 2)}

Generate the following files (mirror the conventions in the repo context above):
1. One Page Object file in ${pagesDir}/ per module (e.g., ${pagesDir}/<Module>Page)
   - Follow the existing page object pattern (class, constructor(page), locators, methods)
   - Wrap actions in try-catch-finally and capture screenshots the same way existing pages do

2. One spec file in ${specsDir}/ (e.g., ${specsDir}/<Module>.spec.js)
   - Follow the seed spec structure shown above exactly (same imports, fixtures, data loading)
   - Drive the page object methods for each test case

3. Test data template — list the column/field names the spec needs to read.
   Derive them from the test cases (e.g., TestCaseName, URL, and any feature-specific fields).
${PW_RESILIENCE_RULES}

Return ONLY valid JSON:
{
  "files": [
    { "path": "${pagesDir}/PageName.js", "type": "page", "content": "// full JS page object" },
    { "path": "${specsDir}/TestName.spec.js", "type": "spec", "content": "// full JS spec" },
    { "path": "data/TestName-columns.md", "type": "data", "content": "// data column list" }
  ]
}
` : `Generate production-ready Playwright JavaScript tests using the Page Object Model pattern.

Application: ${applicationName}
Base URL: ${baseUrl}

TEST CASES:
${JSON.stringify(testcases, null, 2)}

Return JSON:
{
  "files": [
    { "path": "pages/LoginPage.js",  "type": "page", "content": "// full JS POM" },
    { "path": "tests/login.spec.js", "type": "spec", "content": "// full JS spec" }
  ]
}

Rules:
• Use @playwright/test with JavaScript (ES6 modules).
• One POM class per module.
• Each test case maps to one test() block.
${PW_RESILIENCE_RULES}
• Return ONLY the JSON.`;

    const data = await callAI(prompt, 16000, aiOpts);

    // Playwright files are intentionally NOT persisted to the session —
    // they are ephemeral and should be generated fresh each time.

    global.broadcastTo(clientId, { type: 'playwright_generated', count: data.files?.length ?? 0 });
    global.broadcastTo(clientId, { type: 'exec:step', event: 'done', stepKey: 'playwright', name: 'Playwright Builder' });
    res.json({ success: true, ...data });
  } catch (err) {
    global.broadcastTo(clientId, { type: 'exec:step', event: 'error', stepKey: 'playwright', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/export-jira-csv ───────────────────────────────────────────────
// One row per step so the file is re-importable via the Import CSV/Excel feature.
// Format matches the downloadTcTemplate() in app.js:
//   TC ID | Title | Module | Priority | Preconditions | Expected Result |
//   Step No | Action | Test Data | Step Expected Result
router.post('/export-jira-csv', (req, res) => {
  try {
    const { testcases } = req.body;
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

    const header = [
      'TC ID', 'Title', 'Module', 'Priority', 'Preconditions', 'Expected Result',
      'Step No', 'Action', 'Test Data', 'Step Expected Result',
    ].map(q).join(',');

    const dataRows = [];
    for (const tc of testcases) {
      const steps = tc.steps && tc.steps.length ? tc.steps : [];

      if (!steps.length) {
        // No steps — emit one row with TC header info only
        dataRows.push([
          q(tc.id), q(tc.title), q(tc.module || ''),
          q(tc.priority), q((tc.preconditions || []).join('; ')), q(tc.expected_result || ''),
          q(''), q(''), q(''), q(''),
        ].join(','));
      } else {
        steps.forEach((s, idx) => {
          if (idx === 0) {
            // First step row: include all TC header columns
            dataRows.push([
              q(tc.id), q(tc.title), q(tc.module || ''),
              q(tc.priority), q((tc.preconditions || []).join('; ')), q(tc.expected_result || ''),
              q(s.step_number), q(s.action || ''), q(s.test_data || ''), q(s.expected_result || ''),
            ].join(','));
          } else {
            // Subsequent step rows: blank TC header columns
            dataRows.push([
              q(''), q(''), q(''), q(''), q(''), q(''),
              q(s.step_number), q(s.action || ''), q(s.test_data || ''), q(s.expected_result || ''),
            ].join(','));
          }
        });
      }
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="testcases-export.csv"');
    res.send([header, ...dataRows].join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/reference-library ─────────────────────────────────────────────
router.get('/reference-library', (req, res) => {
  const lib = refLib.getLibrary();
  if (!lib) return res.json({ success: true, exists: false });
  res.json({ success: true, exists: true, lastUpdated: lib.lastUpdated, analysis: lib.analysis });
});

// ── POST /api/ai/reference-library — upload & analyse TC dump ─────────────────
// Saves the file to data/reference-source/ (persists across sessions) then
// re-analyses ALL source files together so multiple uploads accumulate.
router.post('/reference-library', upload.single('file'), async (req, res) => {
  try {
    const aiOpts = extractAiOpts(req.body);
    const autoRef = require('../lib/auto-reference');
    const SOURCE_DIR = path.join(__dirname, '../data/reference-source');

    if (req.file) {
      // Save file to the persistent source directory
      fs.mkdirSync(SOURCE_DIR, { recursive: true });
      const dest = path.join(SOURCE_DIR, req.file.originalname || req.file.filename);
      fs.copyFileSync(req.file.path, dest);
      try { fs.unlinkSync(req.file.path); } catch {}
    } else if (req.body.content) {
      // Plain-text paste — save as a .txt file
      fs.mkdirSync(SOURCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(SOURCE_DIR, `pasted-${Date.now()}.txt`), req.body.content, 'utf8');
    }

    // Re-analyse ALL source files combined
    refLib.deleteLibrary();
    await autoRef.autoLoad(aiOpts);
    const lib = refLib.getLibrary();
    if (!lib?.analysis) return res.status(500).json({ error: 'Analysis produced no output.' });

    global.broadcast?.({ type: 'reference_library_updated', tcCount: lib.analysis.tc_count });
    res.json({ success: true, analysis: lib.analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/ai/reference-library/sources/:filename — remove one source file
router.delete('/reference-library/sources/:filename', async (req, res) => {
  try {
    const autoRef   = require('../lib/auto-reference');
    const SOURCE_DIR = path.join(__dirname, '../data/reference-source');
    const name = req.params.filename.replace(/\.\./g, '');  // prevent path traversal
    const dest = path.join(SOURCE_DIR, name);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    // Re-analyse remaining files
    const aiOpts = extractAiOpts(req.body);
    const sources = autoRef.getSourceFiles();
    if (sources.length) {
      refLib.deleteLibrary();
      await autoRef.autoLoad(aiOpts);
      const lib = refLib.getLibrary();
      return res.json({ success: true, analysis: lib?.analysis || null, remaining: sources.length });
    }
    // No files left — clear the library
    refLib.deleteLibrary();
    res.json({ success: true, analysis: null, remaining: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/reference-library/update — append newly generated TCs ─────────
router.post('/reference-library/update', async (req, res) => {
  try {
    const { testcases = [] } = req.body;
    const aiOpts = extractAiOpts(req.body);
    const lib = refLib.getLibrary();
    if (!lib) return res.status(404).json({ error: 'No reference library found. Upload a TC dump first.' });

    const prompt = `Update the existing test case library analysis by incorporating these new test cases.

CURRENT ANALYSIS:
${JSON.stringify(lib.analysis, null, 2)}

NEW TEST CASES ADDED (${testcases.length}):
${JSON.stringify(testcases.map(tc => ({ id: tc.id, title: tc.title, module: tc.module, type: tc.type })), null, 2)}

Return the UPDATED analysis JSON using the same shape as the input (all same fields).
Increment tc_count, merge modules, update existing_tc_ids, update tc_types_distribution.
Return ONLY JSON.`;

    const updatedAnalysis = await callAI(prompt, 4096, aiOpts);
    refLib.saveLibrary({ lastUpdated: new Date().toISOString(), analysis: updatedAnalysis });
    global.broadcast?.({ type: 'reference_library_updated', tcCount: updatedAnalysis.tc_count });
    res.json({ success: true, analysis: updatedAnalysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/ai/reference-library — clear the library ─────────────────────
router.delete('/reference-library', (req, res) => {
  try {
    refLib.deleteLibrary();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/reference-library/sources — list files in data/reference-source
router.get('/reference-library/sources', (req, res) => {
  const sources = autoRef.getSourceFiles();
  const stale   = autoRef.isLibraryStale(sources);
  res.json({ success: true, sources: sources.map(s => s.name), stale });
});

// ── POST /api/ai/reference-library/reanalyze — re-run analysis from source files
router.post('/reference-library/reanalyze', async (req, res) => {
  try {
    const aiOpts = extractAiOpts(req.body);
    const sources = autoRef.getSourceFiles();
    if (!sources.length) return res.status(404).json({ error: 'No source files found in data/reference-source/' });
    // Force stale so autoLoad runs
    refLib.deleteLibrary();
    await autoRef.autoLoad(aiOpts);
    const lib = refLib.getLibrary();
    res.json({ success: true, analysis: lib?.analysis });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/models ─────────────────────────────────────────────────────────
router.get('/models', (req, res) => res.json({ success: true, models: MODELS }));

// ── GET /api/ai/test-cli — verify Claude Code CLI is available ────────────────
router.get('/test-cli', async (req, res) => {
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execAsync = promisify(execFile);
  try {
    const { stdout } = await execAsync('claude', ['--version'], {
      timeout: 10000, shell: true,
    });
    res.json({ ok: true, version: stdout.trim() });
  } catch (err) {
    const msg = err.code === 'ENOENT' || /not found|not recognized/i.test(err.message)
      ? 'Claude Code CLI not found. Install it from claude.ai/code'
      : err.message;
    res.json({ ok: false, error: msg });
  }
});

// ── POST /api/ai/test-copilot — verify GitHub Copilot connectivity ────────────
router.post('/test-copilot', async (req, res) => {
  const token = req.body.token || process.env.GITHUB_TOKEN;

  // Mode 1: Bridge (no token — uses local VS Code extension)
  if (!token) {
    try {
      const response = await fetch('http://127.0.0.1:3939/health');
      if (response.ok) {
        const data = await response.json();
        const modelCount = data.models?.length || 0;
        res.json({ ok: true, message: `VS Code Copilot Bridge connected (${modelCount} models available)`, mode: 'bridge' });
      } else {
        res.json({ ok: false, error: 'Bridge responded with error. Restart it via Ctrl+Shift+P → "Test Alchemist: Start Copilot Bridge"' });
      }
    } catch (err) {
      res.json({ ok: false, error: 'Copilot Bridge not running. In VS Code: Ctrl+Shift+P → "Test Alchemist: Start Copilot Bridge"' });
    }
    return;
  }

  // Mode 2: Direct GitHub token
  try {
    const response = await fetch('https://models.github.ai/inference/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Reply with just "ok"' }],
      }),
    });
    if (response.ok) {
      res.json({ ok: true, message: 'GitHub Copilot API connected', mode: 'token' });
    } else {
      const text = await response.text().catch(() => '');
      res.json({ ok: false, error: `HTTP ${response.status}: ${text.slice(0, 200)}` });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ── POST /api/ai/test-custom — verify a custom / OpenAI-compatible endpoint ────
router.post('/test-custom', async (req, res) => {
  try {
    const text = await callAI('Reply with just: ok', 16, {
      provider:         'custom',
      model:            req.body.model,
      customBaseUrl:    req.body.customBaseUrl,
      customApiKey:     req.body.customApiKey,
      customApiVersion: req.body.customApiVersion,
      rawText:          true,
    });
    res.json({ ok: true, message: `Endpoint reachable — model replied (${String(text).trim().slice(0, 40)})` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

module.exports = router;
