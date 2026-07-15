const express = require('express');
const router = express.Router();
const axios = require('axios');

function gitlabApi(req) {
  const base = req.body.gitlabUrl || process.env.GITLAB_URL || 'https://gitlab.com';
  const token = req.body.gitlabToken || process.env.GITLAB_TOKEN;
  return axios.create({
    baseURL: `${base}/api/v4`,
    headers: { 'PRIVATE-TOKEN': token },
  });
}

// ── POST /api/gitlab/trigger ───────────────────────────────────────────────────
// Triggers a GitLab CI pipeline via a trigger token.
router.post('/trigger', async (req, res) => {
  try {
    const {
      gitlabUrl = process.env.GITLAB_URL || 'https://gitlab.com',
      projectId = process.env.GITLAB_PROJECT_ID,
      triggerToken = process.env.GITLAB_TRIGGER_TOKEN,
      branch = process.env.GITLAB_DEFAULT_BRANCH || 'main',
      variables = {},
    } = req.body;

    const url = `${gitlabUrl}/api/v4/projects/${projectId}/trigger/pipeline`;
    const params = new URLSearchParams({ token: triggerToken, ref: branch });
    Object.entries(variables).forEach(([k, v]) => params.append(`variables[${k}]`, v));

    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    global.broadcast({ type: 'pipeline_triggered', pipelineId: response.data.id, status: response.data.status });
    res.json({ success: true, pipeline: response.data });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(500).json({ error: msg });
  }
});

// ── GET /api/gitlab/pipeline/:id ──────────────────────────────────────────────
router.get('/pipeline/:id', async (req, res) => {
  try {
    const projectId = req.query.projectId || process.env.GITLAB_PROJECT_ID;
    const api = gitlabApi({ body: { gitlabUrl: req.query.gitlabUrl, gitlabToken: req.query.gitlabToken } });
    const { data } = await api.get(`/projects/${projectId}/pipelines/${req.params.id}`);
    global.broadcast({ type: 'pipeline_status', pipelineId: data.id, status: data.status });
    res.json({ success: true, pipeline: data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/gitlab/pipeline/:id/jobs ─────────────────────────────────────────
router.get('/pipeline/:id/jobs', async (req, res) => {
  try {
    const projectId = req.query.projectId || process.env.GITLAB_PROJECT_ID;
    const api = gitlabApi({ body: { gitlabUrl: req.query.gitlabUrl, gitlabToken: req.query.gitlabToken } });
    const { data } = await api.get(`/projects/${projectId}/pipelines/${req.params.id}/jobs`);
    res.json({ success: true, jobs: data });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/gitlab/projects ───────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  try {
    const api = gitlabApi({ body: { gitlabUrl: req.query.gitlabUrl, gitlabToken: req.query.gitlabToken } });
    const { data } = await api.get('/projects', { params: { membership: true, per_page: 50 } });
    res.json({ success: true, projects: data.map((p) => ({ id: p.id, name: p.name_with_namespace, web_url: p.web_url })) });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
