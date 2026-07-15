'use strict';
const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const https   = require('https');
const db      = require('../lib/db');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper: build Confluence Cloud auth headers
function confluenceHeaders(email, token) {
  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  return { Authorization: `Basic ${auth}`, Accept: 'application/json' };
}

// Helper: extract base URL and page ID from a Confluence URL
function parseConfluenceUrl(url) {
  // Cloud: https://xxx.atlassian.net/wiki/spaces/SPACE/pages/123456/Title
  const cloudMatch = url.match(/^(https?:\/\/[^/]+)\/wiki\/.*?pages\/(\d+)/);
  if (cloudMatch) return { baseUrl: cloudMatch[1], pageId: cloudMatch[2] };

  // Cloud short: https://xxx.atlassian.net/wiki/x/abcdef (tiny URL)
  const shortMatch = url.match(/^(https?:\/\/[^/]+)\/wiki\/x\/([A-Za-z0-9_-]+)/);
  if (shortMatch) return { baseUrl: shortMatch[1], pageId: shortMatch[2], isTiny: true };

  return null;
}

// Strip HTML tags and clean up Confluence content, preserving structure
function htmlToText(html) {
  return html
    .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi, '\n## $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/?(ol|ul)[^>]*>/gi, '\n')
    .replace(/<\/?(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Split content into individual rules/sections based on headings, numbered items, bullets
function splitIntoRules(text) {
  const rules = [];

  // Try splitting by headings (## Section)
  const headingSections = text.split(/\n##\s+/);
  if (headingSections.length > 1) {
    // First chunk is content before any heading — skip if empty
    for (let i = 1; i < headingSections.length; i++) {
      const lines = headingSections[i].split('\n');
      const title = lines[0].trim();
      const body = lines.slice(1).join('\n').trim();
      if (title || body) {
        rules.push({ title, guidance: body || title });
      }
    }
    return rules;
  }

  // Try splitting by numbered items (1. / 1) / Rule 1: etc.)
  const numberedPattern = /\n(?=\d+[\.\)]\s|\bRule\s+\d+)/i;
  const numberedSections = text.split(numberedPattern).map(s => s.trim()).filter(Boolean);
  if (numberedSections.length > 1) {
    for (const section of numberedSections) {
      const firstLine = section.split('\n')[0].trim();
      rules.push({ title: firstLine.substring(0, 80), guidance: section });
    }
    return rules;
  }

  // Try splitting by bullet points (each bullet = a rule)
  const bulletLines = text.split('\n').filter(l => l.trim().startsWith('•') || l.trim().match(/^[-–]\s/));
  if (bulletLines.length >= 2) {
    for (const line of bulletLines) {
      const clean = line.replace(/^[•\-–]\s*/, '').trim();
      if (clean.length > 10) { // skip very short bullets
        rules.push({ title: clean.substring(0, 80), guidance: clean });
      }
    }
    return rules;
  }

  // Fallback: split by paragraphs (double newline)
  const paragraphs = text.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 15);
  if (paragraphs.length > 1 && paragraphs.length <= 30) {
    for (const para of paragraphs) {
      const firstLine = para.split('\n')[0].trim();
      rules.push({ title: firstLine.substring(0, 80), guidance: para });
    }
    return rules;
  }

  // Last resort: return as single entry
  return [{ title: '', guidance: text }];
}

// ── POST /api/confluence/fetch-page ──────────────────────────────────────────
// Fetch a single Confluence page content by URL or page ID
router.post('/fetch-page', async (req, res) => {
  const { confluenceUrl, pageId: directPageId, baseUrl: directBaseUrl } = req.body;
  const email = req.body.confluenceEmail || req.body.jiraEmail || process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '';
  const token = req.body.confluenceToken || req.body.jiraToken || process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '';

  if (!email || !token) {
    return res.status(400).json({ error: 'Confluence credentials required. Add Jira email + API token in ⚙ Settings → Jira (same Atlassian credentials).' });
  }

  let baseUrl, pageId;
  if (confluenceUrl) {
    const parsed = parseConfluenceUrl(confluenceUrl);
    if (!parsed) return res.status(400).json({ error: 'Invalid Confluence URL. Use a page URL like: https://your-domain.atlassian.net/wiki/spaces/SPACE/pages/12345/Title' });
    baseUrl = parsed.baseUrl;
    pageId  = parsed.pageId;
  } else if (directPageId && directBaseUrl) {
    baseUrl = directBaseUrl.replace(/\/$/, '');
    pageId  = directPageId;
  } else {
    return res.status(400).json({ error: 'Provide a Confluence page URL or baseUrl + pageId' });
  }

  try {
    const url = `${baseUrl}/wiki/api/v2/pages/${pageId}?body-format=storage`;
    const resp = await axios.get(url, {
      headers: confluenceHeaders(email, token),
      httpsAgent,
      timeout: 30000,
    });

    const page = resp.data;
    const title = page.title || 'Untitled';
    const htmlBody = page.body?.storage?.value || '';
    const textContent = htmlToText(htmlBody);

    res.json({
      success: true,
      page: {
        id: page.id,
        title,
        spaceId: page.spaceId,
        content: textContent,
        htmlContent: htmlBody,
        url: `${baseUrl}/wiki/spaces/~${page.spaceId}/pages/${page.id}`,
      },
    });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Confluence auth failed. Check your email and API token.' });
    if (status === 403) return res.status(403).json({ error: 'No access to this page. Ensure the API token owner has view permissions.' });
    if (status === 404) return res.status(404).json({ error: 'Confluence page not found. Check the URL or page ID.' });
    return res.status(500).json({ error: `Confluence API error: ${err.message}` });
  }
});

// ── POST /api/confluence/search ──────────────────────────────────────────────
// Search for pages in a Confluence space
router.post('/search', async (req, res) => {
  const { query, spaceKey, baseUrl: directBaseUrl, limit = 10 } = req.body;
  const email = req.body.confluenceEmail || req.body.jiraEmail || process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '';
  const token = req.body.confluenceToken || req.body.jiraToken || process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '';
  const baseUrl = (directBaseUrl || req.body.confluenceBaseUrl || process.env.CONFLUENCE_BASE_URL || '').replace(/\/$/, '');

  if (!email || !token) return res.status(400).json({ error: 'Confluence credentials required. Configure Jira email + API token in Settings.' });
  if (!baseUrl) return res.status(400).json({ error: 'Confluence base URL required (e.g. https://your-domain.atlassian.net).' });
  if (!query) return res.status(400).json({ error: 'Search query required.' });

  try {
    let cql = `type=page AND text~"${query.replace(/"/g, '\\"')}"`;
    if (spaceKey) cql += ` AND space="${spaceKey}"`;

    const resp = await axios.get(`${baseUrl}/wiki/rest/api/content/search`, {
      params: { cql, limit: Math.min(limit, 25), expand: 'metadata.labels' },
      headers: confluenceHeaders(email, token),
      httpsAgent,
      timeout: 30000,
    });

    const pages = (resp.data.results || []).map(p => ({
      id: p.id,
      title: p.title,
      url: `${baseUrl}/wiki${p._links?.webui || ''}`,
      space: p.space?.key,
      labels: (p.metadata?.labels?.results || []).map(l => l.name),
    }));

    res.json({ success: true, pages });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Confluence auth failed.' });
    return res.status(500).json({ error: `Confluence search failed: ${err.message}` });
  }
});

// ── POST /api/confluence/fetch-children ──────────────────────────────────────
// Fetch child pages of a given page (for navigation)
router.post('/fetch-children', async (req, res) => {
  const { pageId, baseUrl: directBaseUrl } = req.body;
  const email = req.body.confluenceEmail || req.body.jiraEmail || process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '';
  const token = req.body.confluenceToken || req.body.jiraToken || process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '';
  const baseUrl = (directBaseUrl || req.body.confluenceBaseUrl || process.env.CONFLUENCE_BASE_URL || '').replace(/\/$/, '');

  if (!email || !token) return res.status(400).json({ error: 'Confluence credentials required. Configure Jira email + API token in Settings.' });
  if (!baseUrl || !pageId) return res.status(400).json({ error: 'baseUrl and pageId required.' });

  try {
    const resp = await axios.get(`${baseUrl}/wiki/api/v2/pages/${pageId}/children/page`, {
      params: { limit: 50 },
      headers: confluenceHeaders(email, token),
      httpsAgent,
      timeout: 30000,
    });

    const children = (resp.data.results || []).map(p => ({
      id: p.id,
      title: p.title,
      url: `${baseUrl}/wiki/spaces/~${p.spaceId}/pages/${p.id}`,
    }));

    res.json({ success: true, children });
  } catch (err) {
    return res.status(500).json({ error: `Failed to fetch children: ${err.message}` });
  }
});

// ── POST /api/confluence/import-as-knowledge ─────────────────────────────────
// Fetch a Confluence FRD page and save as functional requirements context
router.post('/import-as-knowledge', async (req, res) => {
  const { confluenceUrl, clientId, kind = 'requirement', module: mod } = req.body;
  const email = req.body.confluenceEmail || req.body.jiraEmail || process.env.CONFLUENCE_EMAIL || process.env.JIRA_EMAIL || '';
  const token = req.body.confluenceToken || req.body.jiraToken || process.env.CONFLUENCE_API_TOKEN || process.env.JIRA_API_TOKEN || '';

  if (!clientId) return res.status(400).json({ error: 'clientId required' });
  if (!confluenceUrl) return res.status(400).json({ error: 'confluenceUrl required' });
  if (!email || !token) return res.status(400).json({ error: 'Confluence credentials required. Configure Jira email + API token in Settings.' });

  const parsed = parseConfluenceUrl(confluenceUrl);
  if (!parsed) return res.status(400).json({ error: 'Invalid Confluence URL.' });

  try {
    const url = `${parsed.baseUrl}/wiki/api/v2/pages/${parsed.pageId}?body-format=storage`;
    const resp = await axios.get(url, {
      headers: confluenceHeaders(email, token),
      httpsAgent,
      timeout: 30000,
    });

    const page = resp.data;
    const title = page.title || 'Untitled';
    const rawHtml = page.body?.storage?.value || '';
    const textContent = htmlToText(rawHtml);

    if (!textContent) return res.status(400).json({ error: 'Page has no content.' });

    // Save as a single functional requirements entry (full document)
    const id = db.saveKnowledgeEntry({
      clientId,
      kind: 'requirement',
      module: mod || null,
      triggerText: `FRD: ${title}`,
      guidance: textContent,
      htmlContent: rawHtml,
      sourceItemId: `confluence:${page.id}`,
      sourceItemType: 'confluence',
    });

    res.json({ success: true, id, title, contentLength: textContent.length });
  } catch (err) {
    const status = err.response?.status;
    if (status === 401) return res.status(401).json({ error: 'Confluence auth failed.' });
    if (status === 404) return res.status(404).json({ error: 'Page not found.' });
    return res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

module.exports = router;
