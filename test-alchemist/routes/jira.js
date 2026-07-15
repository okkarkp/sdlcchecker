const express  = require('express');
const router   = express.Router();
const axios    = require('axios');
const https    = require('https');
const multer   = require('multer');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');

// multer: store in memory so we can forward the buffer to Jira
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Bypass self-signed / corporate-proxy certificates
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Returns the list of missing required Jira settings (empty = configured).
function missingJiraCfg(cfg = {}) {
  const missing = [];
  if (!(cfg.jiraUrl   || process.env.JIRA_BASE_URL))  missing.push('Jira Base URL');
  if (!(cfg.jiraEmail || process.env.JIRA_EMAIL))     missing.push('Email');
  if (!(cfg.jiraToken || process.env.JIRA_API_TOKEN)) missing.push('API Token');
  return missing;
}

function jiraClient(cfg = {}) {
  const base  = cfg.jiraUrl   || process.env.JIRA_BASE_URL;
  const email = cfg.jiraEmail || process.env.JIRA_EMAIL;
  const token = cfg.jiraToken || process.env.JIRA_API_TOKEN;
  return axios.create({
    baseURL: `${(base || '').replace(/\/$/, '')}/rest/api/3`,
    auth: { username: email, password: token },
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    httpsAgent,
  });
}

// ── GET /api/jira/test-connection ─────────────────────────────────────────────
router.get('/test-connection', async (req, res) => {
  const base  = req.query.jiraUrl   || process.env.JIRA_BASE_URL;
  const email = req.query.jiraEmail || process.env.JIRA_EMAIL;
  const token = req.query.jiraToken || process.env.JIRA_API_TOKEN;
  const pk    = req.query.jiraProjectKey || process.env.JIRA_PROJECT_KEY;

  const missing = [];
  if (!base)  missing.push('Jira Base URL');
  if (!email) missing.push('Email');
  if (!token) missing.push('API Token');
  if (missing.length) {
    return res.status(400).json({ success: false, error: `Missing: ${missing.join(', ')}` });
  }

  try {
    const api = axios.create({
      baseURL: `${(base || '').replace(/\/$/, '')}/rest/api/3`,
      auth:    { username: email, password: token },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      httpsAgent,
    });

    // 1. Verify credentials
    const { data: me } = await api.get('/myself');

    // 2. Verify project key (if provided)
    let project = null;
    if (pk) {
      try {
        const { data: proj } = await api.get(`/project/${pk}`);
        project = { key: proj.key, name: proj.name };
      } catch (pe) {
        return res.json({
          success: false,
          user: me.displayName,
          error: `Credentials OK but project "${pk}" not found or not accessible.`,
        });
      }
    }

    res.json({
      success: true,
      user:    me.displayName,
      email:   me.emailAddress,
      project,
      message: `Connected as ${me.displayName}${project ? ` · Project: ${project.name}` : ''}`,
    });
  } catch (err) {
    const status = err.response?.status;
    const hint   = status === 401 ? 'Invalid email or API token.'
                 : status === 403 ? 'API token lacks permission.'
                 : status === 404 ? 'Jira URL not found — check the base URL.'
                 : err.message;
    res.status(500).json({ success: false, error: hint });
  }
});

// ── GET /api/jira/fields ──────────────────────────────────────────────────────
// Returns all fields for a given project + issue type so we can identify
// Xray custom field IDs (test steps, repository folder, etc.)
router.get('/fields', async (req, res) => {
  const cfg = req.query;
  const base       = cfg.jiraUrl   || process.env.JIRA_BASE_URL;
  const email      = cfg.jiraEmail || process.env.JIRA_EMAIL;
  const token      = cfg.jiraToken || process.env.JIRA_API_TOKEN;
  const projectKey = cfg.projectKey || process.env.JIRA_PROJECT_KEY;
  const issueType  = cfg.issueType  || process.env.JIRA_TEST_ISSUE_TYPE || 'Test';

  if (!base || !email || !token) {
    return res.status(400).json({ error: 'Missing Jira credentials' });
  }

  try {
    const api = axios.create({
      baseURL: `${(base || '').replace(/\/$/, '')}/rest/api/3`,
      auth:    { username: email, password: token },
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      httpsAgent,
    });

    // 1. Get ALL fields on the instance
    const { data: allFields } = await api.get('/field');

    // 2. Get create-meta for this project + issue type to see which fields apply
    let typeFields = [];
    if (projectKey) {
      try {
        const { data: meta } = await api.get('/issue/createmeta', {
          params: {
            projectKeys:    projectKey,
            issuetypeNames: issueType,
            expand:         'projects.issuetypes.fields',
          },
        });
        const proj = meta.projects?.[0];
        const it   = proj?.issuetypes?.[0];
        typeFields = it?.fields
          ? Object.entries(it.fields).map(([id, f]) => ({
              id,
              name:     f.name,
              required: f.required,
              schema:   f.schema,
            }))
          : [];
      } catch (metaErr) {
        console.warn('[Jira] createmeta failed:', metaErr.response?.status, metaErr.message);
      }
    }

    // 3. Classify fields — highlight Xray-related ones
    const xrayKeywords = ['xray','test step','repository','test set','test plan','test exec','test type','gherkin','cucumber'];
    const classified = allFields.map(f => {
      const nameLc = (f.name || '').toLowerCase();
      const idLc   = (f.id   || '').toLowerCase();
      const isXray = xrayKeywords.some(k => nameLc.includes(k) || idLc.includes(k));
      const isCustom = (f.id || '').startsWith('customfield_');
      return {
        id:       f.id,
        name:     f.name,
        type:     f.schema?.type || '—',
        custom:   isCustom,
        xray:     isXray,
        inCreate: typeFields.some(tf => tf.id === f.id),
      };
    }).sort((a, b) => {
      // Xray fields first, then custom, then standard
      if (a.xray !== b.xray) return a.xray ? -1 : 1;
      if (a.inCreate !== b.inCreate) return a.inCreate ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });

    res.json({
      success:     true,
      totalFields: classified.length,
      xrayFields:  classified.filter(f => f.xray),
      createFields: typeFields,
      all:         classified,
    });
  } catch (err) {
    const status = err.response?.status;
    const hint   = status === 401 ? 'Invalid credentials'
                 : status === 403 ? 'Insufficient permissions'
                 : status === 404 ? 'Jira URL not found'
                 : err.message;
    res.status(500).json({ error: hint });
  }
});

// ── GET /api/jira/projects ─────────────────────────────────────────────────────
router.get('/projects', async (req, res) => {
  const missing = missingJiraCfg(req.query);
  if (missing.length) return res.status(400).json({ error: `Missing: ${missing.join(', ')}` });
  try {
    const api = jiraClient(req.query);
    const { data } = await api.get('/project/search', { params: { maxResults: 50 } });
    res.json({ success: true, projects: data.values.map((p) => ({ id: p.id, key: p.key, name: p.name })) });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.errorMessages?.[0] || err.message });
  }
});

// ── POST /api/jira/create-testcase ─────────────────────────────────────────────
// Creates a single test-case issue in Jira.
router.post('/create-testcase', async (req, res) => {
  try {
    const { testcase, projectKey, cfg = {} } = req.body;
    const api = jiraClient(cfg);
    const pk = projectKey || process.env.JIRA_PROJECT_KEY;

    const steps = testcase.steps
      .map((s) => `*Step ${s.step_number}:* ${s.action}${s.test_data ? `\n_Data:_ ${s.test_data}` : ''}\n_Expected:_ ${s.expected_result}`)
      .join('\n\n');

    const body = {
      fields: {
        project: { key: pk },
        summary: testcase.title,
        issuetype: { name: testcase.jira_fields?.issue_type || process.env.JIRA_TEST_ISSUE_TYPE || 'Test' },
        priority: { name: testcase.priority },
        labels: testcase.labels || [],
        description: {
          type: 'doc', version: 1,
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: `Preconditions: ${(testcase.preconditions || []).join(', ')}` }] },
            { type: 'paragraph', content: [{ type: 'text', text: steps }] },
            { type: 'paragraph', content: [{ type: 'text', text: `Expected Result: ${testcase.expected_result}` }] },
            { type: 'paragraph', content: [{ type: 'text', text: `Automation Notes: ${testcase.automation_notes || 'N/A'}` }] },
          ],
        },
      },
    };

    const { data } = await api.post('/issue', body);
    res.json({ success: true, issue: { id: data.id, key: data.key, url: `${process.env.JIRA_BASE_URL}/browse/${data.key}` } });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.errorMessages?.[0] || err.message });
  }
});

// ── Xray Cloud GraphQL helper ─────────────────────────────────────────────────
// Xray for Jira Cloud uses a separate GraphQL API at xray.cloud.getxray.app.
// The /rest/raven/1.0/ endpoints only exist on Xray Server/DC — they 404 on Cloud.
//
// Step 1: Authenticate with Xray Client ID + Secret → receive a JWT bearer token.
//         (These are found in Jira → Apps → Manage Apps → Xray → API Keys)
// Step 2: Use that token to call the GraphQL API for steps and folder assignment.

const XRAY_AUTH_URL = 'https://xray.cloud.getxray.app/api/v2/authenticate';
const XRAY_GQL_URL  = 'https://xray.cloud.getxray.app/api/v2/graphql';

async function getXrayToken(cfg = {}) {
  const clientId     = cfg.xrayClientId     || process.env.XRAY_CLIENT_ID;
  const clientSecret = cfg.xrayClientSecret || process.env.XRAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    const res = await axios.post(
      XRAY_AUTH_URL,
      JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      { headers: { 'Content-Type': 'application/json' }, httpsAgent }
    );
    // Xray returns the bare JWT string (not a JSON object)
    return typeof res.data === 'string' ? res.data.replace(/^"|"$/g, '') : res.data;
  } catch (e) {
    console.warn('[Xray] Auth failed:', e.response?.status, e.response?.data || e.message);
    return null;
  }
}

function xrayGql(token, query, variables = {}) {
  return axios.post(
    XRAY_GQL_URL,
    { query, variables },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, httpsAgent }
  );
}

// ── GET /api/jira/test-xray ───────────────────────────────────────────────────
// Verifies Xray Cloud credentials by authenticating and returning token metadata.
router.get('/test-xray', async (req, res) => {
  const clientId     = req.query.xrayClientId     || process.env.XRAY_CLIENT_ID;
  const clientSecret = req.query.xrayClientSecret || process.env.XRAY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(400).json({ success: false, error: 'Missing Xray Client ID or Client Secret' });
  }

  try {
    const authRes = await axios.post(
      XRAY_AUTH_URL,
      JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
      { headers: { 'Content-Type': 'application/json' }, httpsAgent }
    );

    // Xray returns the JWT as a bare quoted string, e.g. "eyJ..."
    const token = typeof authRes.data === 'string'
      ? authRes.data.replace(/^"|"$/g, '')
      : String(authRes.data);

    // Decode the payload (middle part of the JWT) to show client name / expiry
    let subject = '';
    let expiresAt = '';
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
      subject   = payload.sub || payload.client_id || '';
      expiresAt = payload.exp ? new Date(payload.exp * 1000).toLocaleString() : '';
    } catch {}

    res.json({
      success: true,
      message: `Xray authenticated ✅${subject ? ` — ${subject}` : ''}${expiresAt ? ` · Expires ${expiresAt}` : ''}`,
    });
  } catch (e) {
    const status = e.response?.status;
    const body   = e.response?.data;
    const hint   = status === 400 ? 'Invalid Client ID or Client Secret format.'
                 : status === 401 ? 'Wrong Client ID or Client Secret.'
                 : status === 403 ? 'Credentials valid but access denied — check Xray permissions.'
                 : typeof body === 'string' ? body.slice(0, 120)
                 : e.message;
    res.status(500).json({ success: false, error: hint });
  }
});

// ── POST /api/jira/bulk-create-testcases ──────────────────────────────────────
router.post('/bulk-create-testcases', async (req, res) => {
  try {
    const { testcases, projectKey, cfg = {} } = req.body;
    if (!testcases || !testcases.length) {
      return res.status(400).json({ error: 'No test cases provided' });
    }

    const api      = jiraClient(cfg);
    const pk       = projectKey || process.env.JIRA_PROJECT_KEY;
    // Default to the standard Jira "Test" issue type so plain Jira projects (no
    // Xray) work out of the box. Teams using Xray can set a different type.
    const testType = cfg.jiraTestType || process.env.JIRA_TEST_ISSUE_TYPE || 'Test';

    // Labels: only from UI input — never auto-generated
    const userLabels = (cfg.jiraLabels || '')
      .split(',')
      .map(l => l.trim().replace(/\s+/g, '_'))
      .filter(Boolean);

    if (!pk) return res.status(400).json({ error: 'Project Key is required' });

    // Xray test repository folder — normalise path
    const rawPath    = (cfg.jiraTestPath || process.env.JIRA_TEST_PATH || '').trim().replace(/\/+$/, '');
    const folderPath = rawPath ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : null;

    // Get Xray bearer token once — reused for every issue in this batch.
    // Token is null when no Xray credentials are configured; Xray ops are skipped silently.
    const xrayToken = await getXrayToken(cfg);
    if (xrayToken) {
      console.log('[Xray] Token obtained — steps and folder assignment active');
    } else {
      console.log('[Xray] No credentials — skipping step/folder upload');
    }

    const created = [];
    const errors  = [];

    for (const tc of testcases) {
      try {
        // Map priority — Jira standard: Highest/High/Medium/Low/Lowest
        const priorityMap = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };
        const jiraPriority = priorityMap[(tc.priority || '').toLowerCase()] || tc.priority || 'Medium';

        // ── Build ADF description ─────────────────────────────────────────────
        const adfContent = [];

        if (tc.module) {
          adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: `Module: ${tc.module}`, marks: [{ type: 'strong' }] }] });
        }

        if (tc.preconditions?.length) {
          adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: 'Preconditions:', marks: [{ type: 'strong' }] }] });
          tc.preconditions.forEach(p =>
            adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: `• ${p}` }] })
          );
        }

        if (tc.expected_result) {
          adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: 'Expected Result:', marks: [{ type: 'strong' }] }] });
          adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: tc.expected_result }] });
        }

        // When Xray is available the steps go into Xray's structured step panel
        // (below). Without Xray, embed the full numbered steps in the card
        // description so plain Jira projects keep the complete test case.
        if (!xrayToken && tc.steps?.length) {
          adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: 'Steps:', marks: [{ type: 'strong' }] }] });
          tc.steps.forEach((s, i) => {
            const num   = s.step_number || i + 1;
            const parts = [`${num}. ${s.action || ''}`];
            if (s.test_data)       parts.push(`\n   Data: ${s.test_data}`);
            if (s.expected_result) parts.push(`\n   Expected: ${s.expected_result}`);
            adfContent.push({ type: 'paragraph', content: [{ type: 'text', text: parts.join('') }] });
          });
        }

        const body = {
          fields: {
            project:     { key: pk },
            summary:     tc.title,
            issuetype:   { name: testType || tc.jira_fields?.issue_type },
            priority:    { name: jiraPriority },
            labels:      userLabels,
            description: {
              type: 'doc', version: 1,
              content: adfContent.length
                ? adfContent
                : [{ type: 'paragraph', content: [{ type: 'text', text: 'No description.' }] }],
            },
          },
        };

        const { data } = await api.post('/issue', body);
        const issueKey = data.key;
        // Xray GraphQL uses the numeric Jira internal ID, not the key string
        const issueId  = String(data.id);

        let stepsImported = false;
        let folderSet     = false;

        if (xrayToken) {
          // ── Set test repository folder ──────────────────────────────────────
          // Mutation: updateTestFolder(issueId: String!, folderPath: String!): String
          if (folderPath) {
            try {
              await xrayGql(xrayToken,
                `mutation UpdateFolder($issueId: String!, $folderPath: String!) {
                   updateTestFolder(issueId: $issueId, folderPath: $folderPath)
                 }`,
                { issueId, folderPath }
              );
              folderSet = true;
              console.log(`[Xray] Folder set for ${issueKey}: ${folderPath}`);
            } catch (fe) {
              const gqlErr = fe.response?.data?.errors?.[0]?.message || fe.message;
              console.warn(`[Xray] Set folder for ${issueKey}:`, gqlErr);
            }
          }

          // ── Import test steps ───────────────────────────────────────────────
          // Mutations: removeAllTestSteps  +  addTestStep (one call per step)
          if (tc.steps?.length) {
            try {
              // Wipe any pre-existing steps so re-uploads are idempotent
              await xrayGql(xrayToken,
                `mutation RemoveSteps($issueId: String!) { removeAllTestSteps(issueId: $issueId) }`,
                { issueId }
              );

              // Add each step in order
              for (const s of tc.steps) {
                await xrayGql(xrayToken,
                  `mutation AddStep($issueId: String!, $step: CreateStepInput!) {
                     addTestStep(issueId: $issueId, step: $step) { id }
                   }`,
                  {
                    issueId,
                    step: {
                      action: s.action          || '',
                      data:   s.test_data        || '',
                      result: s.expected_result  || '',
                    },
                  }
                );
              }

              stepsImported = true;
              console.log(`[Xray] ${tc.steps.length} step(s) imported for ${issueKey}`);
            } catch (se) {
              const gqlErr = se.response?.data?.errors?.[0]?.message || se.message;
              console.warn(`[Xray] Steps for ${issueKey}:`, gqlErr);
            }
          }
        }

        created.push({ tcId: tc.id, jiraKey: issueKey, stepsImported, folderSet });
        if (global.broadcast) global.broadcast({ type: 'jira_ticket_created', tcId: tc.id, jiraKey: issueKey });
      } catch (e) {
        const jiraMsg = e.response?.data?.errors
          ? Object.entries(e.response.data.errors).map(([k, v]) => `${k}: ${v}`).join('; ')
          : e.response?.data?.errorMessages?.[0] || e.message;
        errors.push({ tcId: tc.id, error: jiraMsg });
      }
    }

    res.json({ success: true, created, errors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/jira/create-bug ──────────────────────────────────────────────────
// Accepts multipart/form-data (with optional screenshot files) OR JSON.
// Extra fields from the modal: description, assignee, labels, priority.
router.post('/create-bug', upload.any(), async (req, res) => {
  try {
    // Parse fields — they come as strings in multipart, or objects in JSON
    let cfg = {};
    try { cfg = typeof req.body.cfg === 'string' ? JSON.parse(req.body.cfg) : (req.body.cfg || {}); } catch {}

    let failedTest = {};
    try { failedTest = typeof req.body.failedTest === 'string' ? JSON.parse(req.body.failedTest) : (req.body.failedTest || {}); } catch {}

    let labels = [];
    try { labels = typeof req.body.labels === 'string' ? JSON.parse(req.body.labels) : (req.body.labels || []); } catch {}

    const projectKey   = req.body.projectKey  || process.env.JIRA_PROJECT_KEY;
    const executionUrl = req.body.executionUrl || '';
    const summary      = req.body.summary      || `[BUG] ${failedTest.title || failedTest.id || 'Defect'}`;
    const description  = req.body.description  || failedTest.title || 'Defect found during automated execution';
    const assigneeId   = req.body.assignee     || '';
    const priority     = req.body.priority     || failedTest.priority || 'High';

    const api = jiraClient(cfg);

    // Build Atlassian Document Format description
    const descLines = description.split('\n').filter(Boolean);
    const descContent = descLines.map(text => ({
      type: 'paragraph',
      content: [{ type: 'text', text }],
    }));
    if (executionUrl) {
      descContent.push({ type: 'paragraph', content: [{ type: 'text', text: `Pipeline: ${executionUrl}` }] });
    }

    const issueBody = {
      fields: {
        project:     { key: projectKey },
        summary:     summary,
        issuetype:   { name: 'Bug' },
        priority:    { name: priority },
        labels:      [...new Set(['automated-failure', ...labels])],
        description: { type: 'doc', version: 1, content: descContent },
        ...(assigneeId ? { assignee: { id: assigneeId } } : {}),
      },
    };

    const { data } = await api.post('/issue', issueBody);
    const issueKey = data.key;

    // Attach screenshots if any were uploaded
    const screenshots = (req.files || []).filter(f => f.fieldname?.startsWith('screenshot_'));
    if (screenshots.length) {
      const base  = (cfg.jiraUrl || process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
      const email = cfg.jiraEmail || process.env.JIRA_EMAIL;
      const token = cfg.jiraToken || process.env.JIRA_API_TOKEN;
      for (const ss of screenshots) {
        const form = new FormData();
        form.append('file', ss.buffer, { filename: ss.originalname, contentType: ss.mimetype });
        await axios.post(`${base}/rest/api/3/issue/${issueKey}/attachments`, form, {
          auth: { username: email, password: token },
          headers: { ...form.getHeaders(), 'X-Atlassian-Token': 'no-check' },
          httpsAgent,
        }).catch(e => console.warn('[Jira attach]', e.message));
      }
    }

    res.json({ success: true, issue: { id: data.id, key: issueKey }, screenshotsAttached: screenshots.length });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.errorMessages?.[0] || err.message });
  }
});

// ── POST /api/jira/upload-attachment ─────────────────────────────────────────
// Accepts either:
//   A) multipart/form-data with a real 'file' field (user-selected file)
//   B) application/json with { issueKey, content, filename, cfg } (JSON export)
router.post('/upload-attachment', upload.single('file'), async (req, res) => {
  try {
    // cfg may come as a JSON string (multipart) or parsed object (JSON body)
    let cfg = {};
    if (req.body.cfg) {
      try { cfg = typeof req.body.cfg === 'string' ? JSON.parse(req.body.cfg) : req.body.cfg; } catch {}
    }

    const issueKey = req.body.issueKey;
    if (!issueKey) return res.status(400).json({ error: 'issueKey required' });

    const base  = cfg.jiraUrl   || process.env.JIRA_BASE_URL;
    const email = cfg.jiraEmail || process.env.JIRA_EMAIL;
    const token = cfg.jiraToken || process.env.JIRA_API_TOKEN;

    const form = new FormData();

    if (req.file) {
      // Real file uploaded via multipart
      form.append('file', req.file.buffer, {
        filename:    req.file.originalname || req.file.fieldname,
        contentType: req.file.mimetype || 'application/octet-stream',
      });
    } else {
      // JSON content string fallback
      const { content, filename } = req.body;
      if (!content) return res.status(400).json({ error: 'file or content required' });
      form.append('file', Buffer.from(content), { filename: filename || 'results.json' });
    }

    await axios.post(
      `${(base || '').replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/attachments`,
      form,
      {
        auth: { username: email, password: token },
        headers: { ...form.getHeaders(), 'X-Atlassian-Token': 'no-check' },
        httpsAgent,
      }
    );

    const attached = req.file ? req.file.originalname : (req.body.filename || 'results.json');
    res.json({ success: true, message: `Attached ${attached} to ${issueKey}` });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

// ── GET /api/jira/test-execution/:key — Fetch tests from a Test Execution ────
// Returns the list of test issues linked to the given Test Execution issue.
// Works with both Xray Cloud (GraphQL) and Jira REST (linked issues fallback).
router.get('/test-execution/:key', async (req, res) => {
  const executionKey = req.params.key;
  const cfg = {
    jiraUrl:          req.query.jiraUrl   || process.env.JIRA_BASE_URL,
    jiraEmail:        req.query.jiraEmail || process.env.JIRA_EMAIL,
    jiraToken:        req.query.jiraToken || process.env.JIRA_API_TOKEN,
    xrayClientId:     req.query.xrayClientId     || process.env.XRAY_CLIENT_ID,
    xrayClientSecret: req.query.xrayClientSecret || process.env.XRAY_CLIENT_SECRET,
  };

  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    return res.status(400).json({ error: 'Jira credentials required' });
  }

  try {
    const api = jiraClient(cfg);

    // Try Xray Cloud GraphQL first
    const xrayToken = await getXrayToken(cfg);
    console.log(`[Jira] Fetching tests for ${executionKey}, Xray token: ${xrayToken ? 'YES' : 'NO'}`);

    if (xrayToken) {
      try {
        // Xray Cloud GraphQL needs the Jira internal numeric ID, not the key
        // First resolve the key to internal ID via Jira REST
        let internalId = executionKey;
        try {
          const { data: issueData } = await api.get(`/issue/${executionKey}?fields=id`);
          internalId = issueData.id; // numeric string like "12345"
          console.log(`[Jira] Resolved ${executionKey} → internal ID: ${internalId}`);
        } catch (idErr) {
          console.warn(`[Jira] Could not resolve issue ID for ${executionKey}:`, idErr.message);
        }

        const gqlRes = await xrayGql(xrayToken, `
          query GetTestExecution($issueId: String!, $limit: Int!) {
            getTestExecution(issueId: $issueId) {
              issueId
              tests(limit: $limit) {
                total
                results {
                  issueId
                  jira(fields: ["key", "summary", "status"])
                  status { name color }
                  testType { name }
                }
              }
            }
          }
        `, { issueId: internalId, limit: 200 });

        console.log(`[Jira] Xray GraphQL response total:`, gqlRes.data?.data?.getTestExecution?.tests?.total ?? 'null');
        if (gqlRes.data?.errors) console.warn(`[Jira] Xray GraphQL errors:`, JSON.stringify(gqlRes.data.errors.slice(0, 2)));

        const tests = gqlRes.data?.data?.getTestExecution?.tests?.results || [];
        const mapped = tests.map(t => ({
          issueId:  t.issueId,
          key:      t.jira?.key || t.issueId,
          summary:  t.jira?.summary || '',
          status:   t.status?.name || 'TODO',
          testType: t.testType?.name || 'Manual',
        }));

        if (mapped.length) {
          console.log(`[Jira] Xray Cloud GraphQL: found ${mapped.length} tests in ${executionKey}`);
          return res.json({ success: true, executionKey, tests: mapped, source: 'xray-cloud' });
        }
      } catch (xErr) {
        const errDetail = xErr.response?.data?.errors?.[0]?.message || xErr.response?.data || xErr.message;
        console.warn('[Jira] Xray GraphQL test-execution failed:', errDetail);
      }
    }

    // Try Xray Server/DC REST API: /rest/raven/1.0/api/testexec/{key}/test
    const base = (cfg.jiraUrl || process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
    const email = cfg.jiraEmail || process.env.JIRA_EMAIL;
    const token = cfg.jiraToken || process.env.JIRA_API_TOKEN;
    try {
      const xrayRes = await axios.get(
        `${base}/rest/raven/1.0/api/testexec/${executionKey}/test`,
        { auth: { username: email, password: token }, httpsAgent }
      );
      const xrayTests = xrayRes.data || [];
      if (xrayTests.length) {
        const mapped = xrayTests.map(t => ({
          issueId:  String(t.id || ''),
          key:      t.key || '',
          summary:  t.summary || '',
          status:   t.status || 'TODO',
          testType: t.type || 'Manual',
        }));
        console.log(`[Jira] Xray Server: found ${mapped.length} tests in ${executionKey}`);
        return res.json({ success: true, executionKey, tests: mapped, source: 'xray-server' });
      }
    } catch (xrayServerErr) {
      console.warn('[Jira] Xray Server REST failed:', xrayServerErr.response?.status, xrayServerErr.response?.data?.message || xrayServerErr.message);
    }

    // Fallback: Use Jira REST to get linked issues from the Test Execution issue
    const { data: issue } = await api.get(`/issue/${executionKey}?fields=summary,issuelinks,subtasks,issuetype`);
    const links = issue.fields?.issuelinks || [];
    console.log(`[Jira] REST fallback for ${executionKey}: ${links.length} links, ${(issue.fields?.subtasks || []).length} subtasks`);
    // Log what types the linked issues are for debugging
    links.forEach(link => {
      const linked = link.outwardIssue || link.inwardIssue;
      if (linked) console.log(`[Jira]   Link: ${linked.key} — type: "${linked.fields?.issuetype?.name}" — "${linked.fields?.summary?.slice(0, 60)}"`);
    });

    // Extract linked test issues — include "Test" types AND any issues linked via Xray link types
    const tests = [];
    const testTypeNames = ['test', 'test xray', 'test case', 'xray test'];
    const xrayLinkNames = ['test', 'tested by', 'tests', 'is tested by', 'test execution'];
    for (const link of links) {
      const linked = link.outwardIssue || link.inwardIssue;
      if (!linked) continue;
      const issueTypeName = (linked.fields?.issuetype?.name || '').toLowerCase();
      const linkTypeName = (link.type?.name || '').toLowerCase();
      const isTestType = testTypeNames.some(t => issueTypeName.includes(t));
      const isXrayLink = xrayLinkNames.some(t => linkTypeName.includes(t));
      if (isTestType || isXrayLink) {
        tests.push({
          issueId: linked.id,
          key:     linked.key,
          summary: linked.fields?.summary || '',
          status:  linked.fields?.status?.name || 'TODO',
          testType: linked.fields?.issuetype?.name || 'Manual',
        });
      }
    }

    // Also check subtasks
    const subtasks = issue.fields?.subtasks || [];
    for (const sub of subtasks) {
      tests.push({
        issueId: sub.id,
        key:     sub.key,
        summary: sub.fields?.summary || '',
        status:  sub.fields?.status?.name || 'TODO',
        testType: 'Manual',
      });
    }

    // If still no tests, try JQL (new Jira Cloud POST endpoint)
    if (!tests.length) {
      try {
        const jql = `issue in testsOfTestExecution("${executionKey}")`;
        const searchRes = await api.post('/search/jql', {
          jql,
          fields: ['summary', 'status', 'issuetype'],
          maxResults: 100,
        });
        const issues = searchRes.data?.issues || [];
        for (const iss of issues) {
          tests.push({
            issueId: iss.id,
            key:     iss.key,
            summary: iss.fields?.summary || '',
            status:  iss.fields?.status?.name || 'TODO',
            testType: iss.fields?.issuetype?.name || 'Manual',
          });
        }
        if (issues.length) console.log(`[Jira] JQL (POST) found ${issues.length} tests for ${executionKey}`);
      } catch (jqlErr) {
        console.warn('[Jira] JQL POST failed:', jqlErr.response?.data?.errorMessages?.[0] || jqlErr.response?.data?.message || jqlErr.message);
        // Try legacy GET endpoint as last resort (older Jira Cloud instances)
        try {
          const legacyRes = await api.get(`/search?jql=${encodeURIComponent(`issue in testsOfTestExecution("${executionKey}")`)}&fields=summary,status,issuetype&maxResults=100`);
          const issues = legacyRes.data?.issues || [];
          for (const iss of issues) {
            tests.push({
              issueId: iss.id,
              key:     iss.key,
              summary: iss.fields?.summary || '',
              status:  iss.fields?.status?.name || 'TODO',
              testType: iss.fields?.issuetype?.name || 'Manual',
            });
          }
          if (issues.length) console.log(`[Jira] JQL (legacy GET) found ${issues.length} tests`);
        } catch (legErr) {
          console.warn('[Jira] JQL legacy GET also failed:', legErr.response?.data?.errorMessages?.[0] || legErr.message);
        }
      }
    }

    // Last resort: try Xray Cloud REST v2 (non-GraphQL)
    if (!tests.length) {
      try {
        const xrayV2Res = await axios.get(
          `https://xray.cloud.getxray.app/api/v2/testexec/${executionKey}/tests`,
          { headers: xrayToken ? { Authorization: `Bearer ${xrayToken}` } : {}, httpsAgent }
        );
        const xrayTests = xrayV2Res.data || [];
        for (const t of xrayTests) {
          tests.push({
            issueId: String(t.id || ''),
            key:     t.key || '',
            summary: t.summary || '',
            status:  t.status || 'TODO',
            testType: t.type || 'Manual',
          });
        }
        if (xrayTests.length) console.log(`[Jira] Xray Cloud v2 REST found ${xrayTests.length} tests`);
      } catch (v2Err) {
        console.warn('[Jira] Xray Cloud v2 REST failed:', v2Err.response?.status || v2Err.message);
      }
    }

    if (!tests.length) {
      console.warn(`[Jira] No tests found for ${executionKey} via any method`);
      // Return helpful error indicating Xray credentials are needed
      const hasXrayCreds = !!(cfg.xrayClientId && cfg.xrayClientSecret);
      return res.json({
        success: true,
        executionKey,
        tests: [],
        source: 'none',
        hint: hasXrayCreds
          ? 'Xray credentials are configured but could not retrieve tests. Verify the execution key and Xray permissions.'
          : 'On Jira Cloud + Xray Cloud, test execution associations are only accessible via the Xray API. Please configure Xray Client ID and Secret in Settings (Jira → Apps → Manage Apps → Xray → API Keys).'
      });
    }

    res.json({ success: true, executionKey, tests, source: tests.length ? 'jira-rest' : 'none' });
  } catch (err) {
    const status = err.response?.status;
    const hint = status === 404 ? `Issue "${executionKey}" not found`
               : status === 401 ? 'Authentication failed'
               : err.response?.data?.errorMessages?.[0] || err.message;
    res.status(status || 500).json({ error: hint });
  }
});

// ── Helpers: extract steps from a plain-Jira card description ───────────────────
// Flattens an ADF (Atlassian Document Format) node tree to plain text.
function adfToText(node) {
  if (!node) return '';
  if (Array.isArray(node)) return node.map(adfToText).join('');
  if (node.type === 'text') return node.text || '';
  let s = node.content ? adfToText(node.content) : '';
  if (node.type === 'hardBreak') return '\n';
  if (['paragraph', 'heading', 'listItem', 'blockquote', 'tableRow'].includes(node.type)) s += '\n';
  return s;
}

// Parses numbered steps from description text. Matches the format this tool writes
// for non-Xray cards: "N. action" / "Data: ..." / "Expected: ...".
function parseStepsFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const steps = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)[.)]\s*(.+)$/);
    if (m) { if (cur) steps.push(cur); cur = { step_number: Number(m[1]), action: m[2], test_data: '', expected_result: '' }; continue; }
    const dm = line.match(/^(?:data|test data)\s*:\s*(.+)$/i);
    if (dm && cur) { cur.test_data = dm[1]; continue; }
    const em = line.match(/^(?:expected|expected result)\s*:\s*(.+)$/i);
    if (em && cur) { cur.expected_result = em[1]; continue; }
    // Otherwise treat as a continuation of the current action
    if (cur && !cur.test_data && !cur.expected_result) cur.action += ' ' + line;
  }
  if (cur) steps.push(cur);
  return steps;
}

// ── GET /api/jira/import-tests/:key — Fetch tests WITH steps for automation ─────
// Pulls test cases from a Jira Test Execution or Test Set, including their steps,
// so they can be driven by the Browser Agent. Works with Xray (GraphQL steps) and
// plain Jira (steps parsed from the card description).
//   query: type=execution|set (default execution) + jira/xray creds
router.get('/import-tests/:key', async (req, res) => {
  const key  = req.params.key;
  const type = (req.query.type || 'execution').toLowerCase() === 'set' ? 'set' : 'execution';
  const cfg = {
    jiraUrl:          req.query.jiraUrl   || process.env.JIRA_BASE_URL,
    jiraEmail:        req.query.jiraEmail || process.env.JIRA_EMAIL,
    jiraToken:        req.query.jiraToken || process.env.JIRA_API_TOKEN,
    xrayClientId:     req.query.xrayClientId     || process.env.XRAY_CLIENT_ID,
    xrayClientSecret: req.query.xrayClientSecret || process.env.XRAY_CLIENT_SECRET,
  };

  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    return res.status(400).json({ error: 'Jira credentials required' });
  }

  const norm = (t) => ({
    id:              t.key || String(t.issueId || ''),
    tc_id:           t.key || String(t.issueId || ''),
    key:             t.key || '',
    title:           t.summary || t.key || 'Untitled',
    module:          t.module || '',
    priority:        t.priority || 'Medium',
    type:            t.testType || 'Functional',
    preconditions:   [],
    steps:           t.steps || [],
    expected_result: t.expected_result || '',
  });

  try {
    const api = jiraClient(cfg);
    const xrayToken = await getXrayToken(cfg);

    // ── Xray Cloud path — fetch tests + steps in one GraphQL query ─────────────
    if (xrayToken) {
      try {
        // Resolve the key → internal numeric id (Xray GraphQL needs the id)
        let internalId = key;
        try {
          const { data: issueData } = await api.get(`/issue/${key}?fields=id`);
          internalId = issueData.id;
        } catch {}

        const container = type === 'set' ? 'getTestSet' : 'getTestExecution';
        const gqlRes = await xrayGql(xrayToken, `
          query GetContainer($issueId: String!, $limit: Int!) {
            ${container}(issueId: $issueId) {
              issueId
              tests(limit: $limit) {
                total
                results {
                  issueId
                  jira(fields: ["key", "summary"])
                  testType { name }
                  steps { action data result }
                }
              }
            }
          }
        `, { issueId: internalId, limit: 200 });

        if (gqlRes.data?.errors) console.warn('[Jira] import-tests Xray GraphQL errors:', JSON.stringify(gqlRes.data.errors.slice(0, 2)));
        const results = gqlRes.data?.data?.[container]?.tests?.results || [];
        if (results.length) {
          const testcases = results.map(t => norm({
            issueId:  t.issueId,
            key:      t.jira?.key,
            summary:  t.jira?.summary,
            testType: t.testType?.name,
            steps:    (t.steps || []).map((s, i) => ({
              step_number:     i + 1,
              action:          s.action || '',
              test_data:       s.data   || '',
              expected_result: s.result || '',
            })),
          }));
          console.log(`[Jira] import-tests: ${testcases.length} tests from ${type} ${key} (xray-cloud)`);
          return res.json({ success: true, key, type, source: 'xray-cloud', testcases });
        }
      } catch (xErr) {
        console.warn('[Jira] import-tests Xray path failed:', xErr.response?.data?.errors?.[0]?.message || xErr.message);
      }
    }

    // ── Plain-Jira path — list tests, then parse steps from each description ───
    const testKeys = new Set();

    // 1. Linked issues + subtasks on the container issue
    try {
      const { data: issue } = await api.get(`/issue/${key}?fields=summary,issuelinks,subtasks,issuetype`);
      const testTypeNames = ['test', 'test xray', 'test case', 'xray test'];
      for (const link of (issue.fields?.issuelinks || [])) {
        const linked = link.outwardIssue || link.inwardIssue;
        if (!linked) continue;
        const itype = (linked.fields?.issuetype?.name || '').toLowerCase();
        const ltype = (link.type?.name || '').toLowerCase();
        if (testTypeNames.some(t => itype.includes(t)) || /test/.test(ltype)) testKeys.add(linked.key);
      }
      for (const sub of (issue.fields?.subtasks || [])) testKeys.add(sub.key);
    } catch (e) {
      console.warn('[Jira] import-tests linked-issue lookup failed:', e.response?.status || e.message);
    }

    // 2. JQL via the Xray test-container functions
    if (!testKeys.size) {
      const jqlFn = type === 'set' ? `testSetTests("${key}")` : `testsOfTestExecution("${key}")`;
      try {
        const searchRes = await api.post('/search/jql', { jql: `issue in ${jqlFn}`, fields: ['key'], maxResults: 200 });
        for (const iss of (searchRes.data?.issues || [])) testKeys.add(iss.key);
      } catch {
        try {
          const legacy = await api.get(`/search?jql=${encodeURIComponent(`issue in ${jqlFn}`)}&fields=key&maxResults=200`);
          for (const iss of (legacy.data?.issues || [])) testKeys.add(iss.key);
        } catch (e2) {
          console.warn('[Jira] import-tests JQL failed:', e2.response?.data?.errorMessages?.[0] || e2.message);
        }
      }
    }

    if (!testKeys.size) {
      const hasXrayCreds = !!(cfg.xrayClientId && cfg.xrayClientSecret);
      return res.json({
        success: true, key, type, source: 'none', testcases: [],
        hint: hasXrayCreds
          ? `No tests found in ${type} ${key}. Check the key and Xray permissions.`
          : `No tests found in ${type} ${key}. For Jira Cloud + Xray, configure Xray Client ID/Secret in Settings, or ensure the ${type} links its test issues.`,
      });
    }

    // 3. Fetch each test issue and parse steps from its description
    const testcases = [];
    for (const tk of testKeys) {
      try {
        const { data: t } = await api.get(`/issue/${tk}?fields=summary,description,issuetype,priority`);
        const descText = adfToText(t.fields?.description);
        testcases.push(norm({
          key:      tk,
          summary:  t.fields?.summary,
          testType: t.fields?.issuetype?.name,
          priority: t.fields?.priority?.name,
          steps:    parseStepsFromText(descText),
          expected_result: '',
        }));
      } catch (e) {
        console.warn(`[Jira] import-tests could not fetch ${tk}:`, e.response?.status || e.message);
      }
    }

    console.log(`[Jira] import-tests: ${testcases.length} tests from ${type} ${key} (jira-rest)`);
    res.json({ success: true, key, type, source: 'jira-rest', testcases });
  } catch (err) {
    const status = err.response?.status;
    const hint = status === 404 ? `Issue "${key}" not found`
               : status === 401 ? 'Authentication failed'
               : err.response?.data?.errorMessages?.[0] || err.message;
    res.status(status || 500).json({ error: hint });
  }
});

// ── POST /api/jira/upload-execution-result ────────────────────────────────────
// Upload PDF evidence / update test run status for a test within a Test Execution.
// Body: { executionKey, testKey, status, cfg } + optional file upload
router.post('/upload-execution-result', upload.single('file'), async (req, res) => {
  try {
    let cfg = {};
    if (req.body.cfg) {
      try { cfg = typeof req.body.cfg === 'string' ? JSON.parse(req.body.cfg) : req.body.cfg; } catch {}
    }

    const testKey      = req.body.testKey;
    const executionKey = req.body.executionKey;
    const status       = req.body.status || 'PASS'; // PASS, FAIL, TODO, EXECUTING

    if (!testKey) return res.status(400).json({ error: 'testKey required' });

    const base  = cfg.jiraUrl   || process.env.JIRA_BASE_URL;
    const email = cfg.jiraEmail || process.env.JIRA_EMAIL;
    const token = cfg.jiraToken || process.env.JIRA_API_TOKEN;

    // 1. Try updating execution status via Xray Cloud GraphQL
    const xrayToken = await getXrayToken(cfg);
    let statusUpdated = false;

    if (xrayToken && executionKey) {
      try {
        await xrayGql(xrayToken, `
          mutation UpdateTestRunStatus($testIssueId: String!, $testExecIssueId: String!, $status: String!) {
            updateTestRunStatus(testIssueId: $testIssueId, testExecIssueId: $testExecIssueId, status: $status)
          }
        `, { testIssueId: testKey, testExecIssueId: executionKey, status });
        statusUpdated = true;
      } catch (xErr) {
        console.warn('[Jira] Xray status update failed:', xErr.response?.data?.errors?.[0]?.message || xErr.message);
      }
    }

    // 2. Attach PDF evidence to the test issue — either an uploaded file (multipart) or a
    //    server-side file path (e.g. the latest matching PDF in the repo's Executionscreenshots).
    let fileAttached = false;
    let attachBuffer = null, attachName = null, attachType = 'application/pdf';
    if (req.file) {
      attachBuffer = req.file.buffer;
      attachName   = req.file.originalname || 'execution-report.pdf';
      attachType   = req.file.mimetype || 'application/pdf';
    } else if (req.body.filePath) {
      // Read a server-side evidence file. Guard to the repo dir when repoPath is given.
      const fp = path.resolve(req.body.filePath);
      if (req.body.repoPath) {
        const root = path.resolve(req.body.repoPath);
        if (fp !== root && !fp.startsWith(root + path.sep)) {
          return res.status(400).json({ error: 'filePath must be inside the repo' });
        }
      }
      if (!fs.existsSync(fp)) return res.status(404).json({ error: `Evidence file not found: ${fp}` });
      attachBuffer = fs.readFileSync(fp);
      attachName   = path.basename(fp);
    }

    if (attachBuffer) {
      const form = new FormData();
      form.append('file', attachBuffer, { filename: attachName, contentType: attachType });
      await axios.post(
        `${(base || '').replace(/\/$/, '')}/rest/api/3/issue/${testKey}/attachments`,
        form,
        {
          auth: { username: email, password: token },
          headers: { ...form.getHeaders(), 'X-Atlassian-Token': 'no-check' },
          httpsAgent,
        }
      );
      fileAttached = true;
    }

    res.json({
      success: true,
      testKey,
      statusUpdated,
      fileAttached,
      message: `${statusUpdated ? 'Status updated' : 'Status unchanged'}${fileAttached ? ' + PDF attached' : ''}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

module.exports = router;
