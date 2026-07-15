const express = require('express');
const router  = express.Router();

/**
 * GET /api/config/defaults
 * Returns all non-secret defaults from .env for the frontend to pre-populate.
 * This is a local-tool endpoint — tokens are included since the server is
 * running on the user's own machine.
 */
router.get('/defaults', (req, res) => {
  res.json({
    // ── Jira ────────────────────────────────────────────────────────────────
    jiraUrl:        process.env.JIRA_BASE_URL           || '',
    jiraEmail:      process.env.JIRA_EMAIL              || '',
    jiraToken:      process.env.JIRA_API_TOKEN          || '',
    jiraProjectKey: process.env.JIRA_PROJECT_KEY        || '',
    jiraTestType:   process.env.JIRA_TEST_ISSUE_TYPE    || 'Manual',
    jiraTestPath:   process.env.JIRA_TEST_PATH          || '',

    // ── GitLab ──────────────────────────────────────────────────────────────
    glUrl:          process.env.GITLAB_URL              || '',
    glToken:        process.env.GITLAB_TOKEN            || '',
    glProjectId:    process.env.GITLAB_PROJECT_ID       || '',
    glTriggerToken: process.env.GITLAB_TRIGGER_TOKEN    || '',

    // ── AI ──────────────────────────────────────────────────────────────────
    anthropicKey:   process.env.ANTHROPIC_API_KEY       || '',
    openaiKey:      process.env.OPENAI_API_KEY          || '',
    geminiKey:      process.env.GEMINI_API_KEY          || '',

    // ── Xray Cloud ──────────────────────────────────────────────────────────
    xrayClientId:     process.env.XRAY_CLIENT_ID        || '',
    xrayClientSecret: process.env.XRAY_CLIENT_SECRET    || '',

    // ── Misc ────────────────────────────────────────────────────────────────
    figmaToken:     process.env.FIGMA_ACCESS_TOKEN      || '',
    appName:        process.env.APP_NAME                || 'Test Alchemist',
    appBaseUrl:     process.env.APP_BASE_URL            || '',

    // ── Confluence ──────────────────────────────────────────────────────────
    confluenceBaseUrl: process.env.CONFLUENCE_BASE_URL  || '',

    // ── Automation Repo ─────────────────────────────────────────────────────
    autoRepoPath:   process.env.AUTOMATION_REPO_PATH    || '',
  });
});

module.exports = router;
