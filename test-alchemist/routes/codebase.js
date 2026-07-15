'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const https   = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Build GitLab API client from request body or .env
function gitlabApi(body) {
  const base  = body.gitlabUrl || process.env.GITLAB_URL || 'https://gitlab.com';
  const token = body.gitlabToken || process.env.GITLAB_TOKEN;
  return { base: `${base}/api/v4`, token, projectId: body.projectId || process.env.GITLAB_PROJECT_ID };
}

function glHeaders(token) {
  return { 'PRIVATE-TOKEN': token, Accept: 'application/json' };
}

// ── POST /api/codebase/tree ──────────────────────────────────────────────────
// Get repository file tree (optionally filtered by path/module)
router.post('/tree', async (req, res) => {
  const { path: dirPath = '', search, recursive = true, ref = 'main' } = req.body;
  const { base, token, projectId } = gitlabApi(req.body);

  if (!token) return res.status(400).json({ error: 'GitLab token not configured. Set it in ⚙ Settings → GitLab.' });
  if (!projectId) return res.status(400).json({ error: 'GitLab Project ID not configured.' });

  try {
    const params = { path: dirPath, ref, recursive, per_page: 100 };
    const resp = await axios.get(`${base}/projects/${projectId}/repository/tree`, {
      params,
      headers: glHeaders(token),
      httpsAgent,
      timeout: 30000,
    });

    let items = resp.data || [];

    // Filter by search/module keyword if provided
    if (search) {
      const kw = search.toLowerCase();
      items = items.filter(f => f.path.toLowerCase().includes(kw) || f.name.toLowerCase().includes(kw));
    }

    // Separate folders and files, sort alphabetically
    const folders = items.filter(i => i.type === 'tree').map(i => ({ name: i.name, path: i.path, type: 'folder' }));
    const files   = items.filter(i => i.type === 'blob').map(i => ({ name: i.name, path: i.path, type: 'file' }));

    res.json({ success: true, folders, files, total: items.length });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'GitLab auth failed. Check your token.' });
    if (status === 404) return res.status(404).json({ error: 'Project or path not found.' });
    return res.status(500).json({ error: `GitLab API error: ${err.message}` });
  }
});

// ── POST /api/codebase/file ──────────────────────────────────────────────────
// Get content of a specific file
router.post('/file', async (req, res) => {
  const { filePath, ref = 'main' } = req.body;
  const { base, token, projectId } = gitlabApi(req.body);

  if (!token) return res.status(400).json({ error: 'GitLab token not configured.' });
  if (!projectId) return res.status(400).json({ error: 'GitLab Project ID required.' });
  if (!filePath) return res.status(400).json({ error: 'filePath required.' });

  try {
    const encodedPath = encodeURIComponent(filePath);
    const resp = await axios.get(`${base}/projects/${projectId}/repository/files/${encodedPath}`, {
      params: { ref },
      headers: glHeaders(token),
      httpsAgent,
      timeout: 30000,
    });

    const content = Buffer.from(resp.data.content, 'base64').toString('utf-8');
    res.json({
      success: true,
      file: {
        path: resp.data.file_path,
        name: resp.data.file_name,
        size: resp.data.size,
        content,
        ref: resp.data.ref,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return res.status(404).json({ error: `File not found: ${filePath}` });
    return res.status(500).json({ error: `Failed to fetch file: ${err.message}` });
  }
});

// ── POST /api/codebase/search ────────────────────────────────────────────────
// Search for files/content by keyword (module name, function, endpoint)
router.post('/search', async (req, res) => {
  const { query, scope = 'blobs', ref = 'main' } = req.body;
  const { base, token, projectId } = gitlabApi(req.body);

  if (!token) return res.status(400).json({ error: 'GitLab token not configured.' });
  if (!projectId) return res.status(400).json({ error: 'GitLab Project ID required.' });
  if (!query) return res.status(400).json({ error: 'Search query required.' });

  try {
    // GitLab project-level search
    const resp = await axios.get(`${base}/projects/${projectId}/search`, {
      params: { scope, search: query, ref, per_page: 20 },
      headers: glHeaders(token),
      httpsAgent,
      timeout: 30000,
    });

    const results = (resp.data || []).map(item => ({
      path: item.filename || item.path,
      data: item.data,        // matched content snippet
      startline: item.startline,
      ref: item.ref,
    }));

    res.json({ success: true, results, total: results.length });
  } catch (err) {
    return res.status(500).json({ error: `Search failed: ${err.message}` });
  }
});

// ── POST /api/codebase/context ───────────────────────────────────────────────
// Smart fetch: given a module/feature keyword, find relevant files and return
// concatenated source code as context for AI test generation
router.post('/context', async (req, res) => {
  const { module: moduleName, keywords = [], maxFiles = 15, ref = 'main' } = req.body;
  const { base, token, projectId } = gitlabApi(req.body);

  if (!token) return res.status(400).json({ error: 'GitLab token not configured.' });
  if (!projectId) return res.status(400).json({ error: 'GitLab Project ID or repo URL required.' });
  if (!moduleName && !keywords.length) return res.status(400).json({ error: 'Provide a module name, path, or keywords to search.' });

  const searchTerms = [moduleName, ...keywords].filter(Boolean);

  try {
    // Strategy 1: Try as a direct folder path first (for MFE repos with known structure)
    let allMatches = [];
    try {
      const treeResp = await axios.get(`${base}/projects/${projectId}/repository/tree`, {
        params: { path: moduleName, ref, recursive: true, per_page: 50 },
        headers: glHeaders(token),
        httpsAgent,
        timeout: 30000,
      });
      const treeFiles = (treeResp.data || []).filter(f => f.type === 'blob');
      // Filter to code files only
      const codeExts = /\.(js|ts|tsx|jsx|vue|py|java|cs|go|rb|rs|php|swift|kt|dart|html|css|scss|json)$/i;
      for (const f of treeFiles) {
        if (codeExts.test(f.name) && allMatches.length < maxFiles) {
          allMatches.push({ path: f.path, snippet: '', startline: 0 });
        }
      }
    } catch (_) { /* path doesn't exist as folder — fall through to search */ }

    // Strategy 2: If tree browse found nothing, search by keywords
    if (!allMatches.length) {
      for (const term of searchTerms.slice(0, 3)) {
        try {
          const resp = await axios.get(`${base}/projects/${projectId}/search`, {
            params: { scope: 'blobs', search: term, ref, per_page: 15 },
            headers: glHeaders(token),
            httpsAgent,
            timeout: 30000,
          });
          for (const item of resp.data || []) {
            if (!allMatches.find(m => m.path === item.filename)) {
              allMatches.push({ path: item.filename, snippet: item.data, startline: item.startline });
            }
          }
        } catch (_) {}
      }
    }

    // Deduplicate and limit
    const filePaths = allMatches.slice(0, maxFiles).map(m => m.path);

    // Fetch full file contents for top matches
    const fileContents = [];
    for (const fp of filePaths) {
      try {
        const encodedPath = encodeURIComponent(fp);
        const resp = await axios.get(`${base}/projects/${projectId}/repository/files/${encodedPath}`, {
          params: { ref },
          headers: glHeaders(token),
          httpsAgent,
          timeout: 15000,
        });
        const content = Buffer.from(resp.data.content, 'base64').toString('utf-8');
        // Cap individual files at 15KB to keep context manageable
        fileContents.push({
          path: fp,
          content: content.substring(0, 15000),
          truncated: content.length > 15000,
          size: content.length,
        });
      } catch (_) { /* skip files that fail */ }
    }

    // Build concatenated context string
    const contextStr = fileContents.map(f =>
      `--- ${f.path} ${f.truncated ? '(truncated)' : ''} ---\n${f.content}`
    ).join('\n\n');

    res.json({
      success: true,
      module: moduleName,
      filesFound: allMatches.length,
      filesFetched: fileContents.length,
      files: fileContents.map(f => ({ path: f.path, size: f.size, truncated: f.truncated })),
      context: contextStr,
    });
  } catch (err) {
    return res.status(500).json({ error: `Context fetch failed: ${err.message}` });
  }
});

module.exports = router;
