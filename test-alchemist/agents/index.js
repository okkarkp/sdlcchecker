const orchestrator  = require('./orchestrator');
const inputParser   = require('./sub-agents/input-parser');
const scenarioGen   = require('./sub-agents/scenario-gen');
const testcaseGen   = require('./sub-agents/testcase-gen');
const playwrightGen = require('./sub-agents/playwright-gen');
const pipeline      = require('./sub-agents/pipeline');
const jiraAgent     = require('./sub-agents/jira');
const verify        = require('./sub-agents/verify');
const perfforge     = require('./sub-agents/perfforge');

const subAgents = [inputParser, scenarioGen, testcaseGen, playwrightGen, pipeline, jiraAgent, verify, perfforge];

module.exports = { orchestrator, subAgents, inputParser, scenarioGen, testcaseGen, playwrightGen, pipeline, jiraAgent, verify, perfforge };
