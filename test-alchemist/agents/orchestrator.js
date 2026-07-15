/**
 * QA Orchestrator — chains all sub-agents in sequence.
 * Each step is optional based on available inputs/config.
 */
const inputParser   = require('./sub-agents/input-parser');
const scenarioGen   = require('./sub-agents/scenario-gen');
const testcaseGen   = require('./sub-agents/testcase-gen');
const playwrightGen = require('./sub-agents/playwright-gen');
const pipelineAgent = require('./sub-agents/pipeline');
const jiraAgent     = require('./sub-agents/jira');

class Orchestrator {
  constructor() {
    this.id          = 'orchestrator';
    this.name        = 'QA Orchestrator';
    this.description = 'Chains all sub-agents end-to-end: inputs → scenarios → test cases → Playwright → pipeline → Jira';
    this.icon        = '🧠';
    this.status      = 'idle';
    this.startedAt   = null;
    this.finishedAt  = null;
    this.log         = [];
    this.lastResult  = null;
    this.lastError   = null;
  }

  _log(msg) {
    const entry = `[${new Date().toISOString()}] ${msg}`;
    this.log.push(entry);
    global.broadcast?.({ type: 'orchestrator_log', message: msg });
  }

  async run(input, opts = {}) {
    this.status     = 'running';
    this.startedAt  = Date.now();
    this.finishedAt = null;
    this.log        = [];
    this.lastError  = null;
    const result    = {};

    global.broadcast?.({ type: 'agent_status', agent: this.id, status: 'running' });

    try {
      // ── Step 1: Parse inputs ─────────────────────────────────────────────
      const hasRawInput = input.files?.length || input.userStory || input.requirements || input.rules;
      if (hasRawInput && !input.inputs?.length) {
        this._log('Step 1/6 — Parsing inputs…');
        const parsed = await inputParser.run(input, opts);
        result.inputs     = parsed.inputs;
        result.inputCount = parsed.count;
        input = { ...input, inputs: parsed.inputs };
      } else if (input.inputs?.length) {
        result.inputs     = input.inputs;
        result.inputCount = input.inputs.length;
      }

      // ── Step 2: Generate scenarios ───────────────────────────────────────
      if (input.inputs?.length && !input.scenarios?.length) {
        this._log('Step 2/6 — Generating test scenarios…');
        const scen = await scenarioGen.run({
          inputs:             input.inputs,
          applicationName:    input.applicationName,
          applicationContext: input.applicationContext,
        }, opts);
        result.scenarios     = scen.scenarios;
        result.scenarioCount = scen.count;
        input = { ...input, scenarios: scen.scenarios };
      } else if (input.scenarios?.length) {
        result.scenarios     = input.scenarios;
        result.scenarioCount = input.scenarios.length;
      }

      // ── Step 3: Generate test cases ──────────────────────────────────────
      if (input.scenarios?.length && !input.testcases?.length) {
        this._log('Step 3/6 — Generating test cases…');
        const tcs = await testcaseGen.run({
          scenarios:       input.scenarios,
          applicationName: input.applicationName,
          baseUrl:         input.baseUrl,
        }, opts);
        result.testcases     = tcs.testcases;
        result.testcaseCount = tcs.count;
        input = { ...input, testcases: tcs.testcases };
      } else if (input.testcases?.length) {
        result.testcases     = input.testcases;
        result.testcaseCount = input.testcases.length;
      }

      // ── Step 4: Generate Playwright scripts (optional) ──────────────────
      const skipPlaywright = input.skipPlaywright === true || input.generatePlaywright === false;
      if (input.testcases?.length && !skipPlaywright) {
        this._log('Step 4/6 — Generating Playwright scripts…');
        const pw = await playwrightGen.run({
          testcases:       input.testcases,
          baseUrl:         input.baseUrl,
          applicationName: input.applicationName,
        }, opts);
        result.playwrightFiles = pw.files;
        result.playwrightCount = pw.count;
      } else if (skipPlaywright) {
        this._log('Step 4/6 — Playwright generation skipped');
      }

      // ── Step 5: Trigger pipeline (optional) ──────────────────────────────
      if (input.triggerPipeline && input.projectId && input.triggerToken) {
        this._log('Step 5/6 — Triggering GitLab pipeline…');
        const pipe = await pipelineAgent.run({
          gitlabUrl:    input.gitlabUrl,
          projectId:    input.projectId,
          triggerToken: input.triggerToken,
          branch:       input.branch,
          variables:    input.variables,
        }, opts);
        result.pipeline   = pipe.pipeline;
        result.pipelineId = pipe.pipelineId;
      } else {
        this._log('Step 5/6 — Pipeline trigger skipped (not configured)');
      }

      // ── Step 6: Create Jira tickets (optional) ───────────────────────────
      if (input.createJiraTickets && input.testcases?.length && input.jiraUrl) {
        this._log('Step 6/6 — Creating Jira tickets…');
        const jira = await jiraAgent.run({
          testcases:   input.testcases,
          projectKey:  input.jiraProjectKey,
          jiraUrl:     input.jiraUrl,
          jiraEmail:   input.jiraEmail,
          jiraToken:   input.jiraToken,
        }, opts);
        result.jiraCreated = jira.created;
        result.jiraErrors  = jira.errors;
      } else {
        this._log('Step 6/6 — Jira ticket creation skipped (not configured)');
      }

      this.status     = 'done';
      this.finishedAt = Date.now();
      this.lastResult = result;
      result.durationMs = this.finishedAt - this.startedAt;
      this._log(`Orchestration complete in ${Math.round(result.durationMs / 1000)}s`);
      global.broadcast?.({ type: 'agent_status', agent: this.id, status: 'done', durationMs: result.durationMs });
      return { success: true, ...result, log: this.log };
    } catch (err) {
      this.status     = 'error';
      this.finishedAt = Date.now();
      this.lastError  = err.message;
      this._log(`Error: ${err.message}`);
      global.broadcast?.({ type: 'agent_status', agent: this.id, status: 'error', error: err.message });
      throw err;
    }
  }

  toJSON() {
    return {
      id:          this.id,
      name:        this.name,
      description: this.description,
      icon:        this.icon,
      status:      this.status,
      lastError:   this.lastError,
      startedAt:   this.startedAt,
      finishedAt:  this.finishedAt,
      durationMs:  this.finishedAt && this.startedAt ? this.finishedAt - this.startedAt : null,
    };
  }
}

module.exports = new Orchestrator();
