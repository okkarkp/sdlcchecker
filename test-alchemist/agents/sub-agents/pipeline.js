const BaseAgent = require('../base-agent');
const axios = require('axios');

class PipelineAgent extends BaseAgent {
  constructor() {
    super('pipeline', 'Pipeline Trigger', 'Triggers a GitLab CI/CD pipeline via trigger token', '🚀');
  }

  async execute({ gitlabUrl, projectId, triggerToken, branch = 'main', variables = {} }) {
    const gl  = gitlabUrl    || process.env.GITLAB_URL          || 'https://gitlab.com';
    const pid = projectId    || process.env.GITLAB_PROJECT_ID;
    const tt  = triggerToken || process.env.GITLAB_TRIGGER_TOKEN;

    if (!pid || !tt) throw new Error('Pipeline agent requires projectId and triggerToken');

    const url = `${gl}/api/v4/projects/${pid}/trigger/pipeline`;
    const params = new URLSearchParams({ token: tt, ref: branch });
    Object.entries(variables).forEach(([k, v]) => params.append(`variables[${k}]`, v));

    const { data } = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    global.broadcast?.({ type: 'pipeline_triggered', pipelineId: data.id, status: data.status });
    return { pipeline: data, pipelineId: data.id, status: data.status, webUrl: data.web_url };
  }
}

module.exports = new PipelineAgent();
