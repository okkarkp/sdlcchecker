const BaseAgent = require('../base-agent');
const axios = require('axios');

class JiraAgent extends BaseAgent {
  constructor() {
    super('jira', 'Jira Integration', 'Creates test case issues and uploads results to Jira', '🎫');
  }

  async execute({ testcases, projectKey, jiraUrl, jiraEmail, jiraToken }) {
    const base  = jiraUrl   || process.env.JIRA_BASE_URL;
    const email = jiraEmail || process.env.JIRA_EMAIL;
    const token = jiraToken || process.env.JIRA_API_TOKEN;
    const pk    = projectKey || process.env.JIRA_PROJECT_KEY;

    if (!base || !email || !token || !pk) {
      throw new Error('Jira agent requires jiraUrl, jiraEmail, jiraToken, and projectKey');
    }

    const api = axios.create({
      baseURL: `${base}/rest/api/3`,
      auth: { username: email, password: token },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    const created = [];
    const errors  = [];

    for (const tc of testcases) {
      try {
        const steps = (tc.steps || [])
          .map((s) => `Step ${s.step_number}: ${s.action} → ${s.expected_result}`)
          .join('\n');
        const { data } = await api.post('/issue', {
          fields: {
            project:     { key: pk },
            summary:     `[${tc.id}] ${tc.title}`,
            issuetype:   { name: tc.jira_fields?.issue_type || 'Test' },
            priority:    { name: tc.priority },
            labels:      tc.labels || [],
            description: {
              type: 'doc', version: 1,
              content: [{ type: 'paragraph', content: [{ type: 'text', text: steps }] }],
            },
          },
        });
        created.push({ tcId: tc.id, jiraKey: data.key });
        global.broadcast?.({ type: 'jira_ticket_created', tcId: tc.id, jiraKey: data.key });
      } catch (e) {
        errors.push({ tcId: tc.id, error: e.response?.data?.errorMessages?.[0] || e.message });
      }
    }

    return { created, errors, count: created.length };
  }
}

module.exports = new JiraAgent();
