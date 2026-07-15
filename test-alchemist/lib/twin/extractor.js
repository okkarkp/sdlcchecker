/**
 * lib/twin/extractor.js — Digital Twin LLM extractor
 *
 * Processes unstructured inputs (Confluence HTML, PPT text, requirement docs) and
 * extracts structured twin data via the active AI provider (callAI). Reconciles
 * extracted page_mappings with existing twin_pages by fuzzy name match, then
 * inserts business_rules → twin_rules and flow_steps → twin_transitions.
 */
'use strict';

const { callAI } = require('../../providers');
const { db, uid, now } = require('../db');

const SYSTEM_PROMPT = `You are a QA knowledge extractor. Extract structured test-relevant information from this document. Return ONLY valid JSON matching the schema. No markdown, no explanation.`;

const SCHEMA_HINT = `
Schema to extract:
{
  "page_mappings": [{ "page_name": "", "route_hint": "" }],
  "business_rules": [{
    "rule_text": "",
    "applies_to": "field_id or page_name",
    "condition": "when this is true",
    "expected_outcome": "then this happens",
    "requirement_ids": []
  }],
  "user_personas": [{
    "role_name": "",
    "permissions": [],
    "typical_journey": []
  }],
  "acceptance_criteria": [{
    "criterion": "",
    "linked_requirement": "",
    "testable": true
  }],
  "flow_steps": [{
    "from_page": "",
    "action": "",
    "to_page": "",
    "condition": ""
  }]
}
`;

// Strip HTML tags to plain text (cheap, no DOM parsing). Good enough for Confluence exports.
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalise(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Light fuzzy match: case-insensitive substring either way + token overlap ratio.
function fuzzyMatchPage(pageName, routeHint) {
  const candidates = db.prepare(`SELECT id, route, page_name FROM twin_pages WHERE deleted_at IS NULL`).all();
  if (!candidates.length) return null;
  const target = normalise(pageName);
  const hint   = normalise(routeHint);

  let best = null, bestScore = 0;
  for (const c of candidates) {
    const route = normalise(c.route);
    const name  = normalise(c.page_name);
    let score = 0;
    if (target && (name.includes(target) || target.includes(name))) score += 2;
    if (hint   && (route.includes(hint)  || hint.includes(route)))   score += 2;
    if (target && route.includes(target)) score += 1;
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

// ── Persistence ──────────────────────────────────────────────────────────────
const STMT = {
  insertRule: db.prepare(`
    INSERT INTO twin_rules(id,page_id,rule_text,applies_to,condition,expected_outcome,source,requirement_ids)
    VALUES(?,?,?,?,?,?,?,?)
  `),
  insertTransition: db.prepare(`
    INSERT INTO twin_transitions(id,page_id,trigger_action,target_route,guard_condition,effect)
    VALUES(?,?,?,?,?,?)
  `),
  insertRole: db.prepare(`
    INSERT INTO twin_roles(id,page_id,role_name,access_level,element_overrides)
    VALUES(?,?,?,?,?)
  `),
  insertRequirement: db.prepare(`
    INSERT INTO twin_requirements(id,page_id,requirement_id,title,source_url,linked_at)
    VALUES(?,?,?,?,?,?)
  `),
  insertOrphanPage: db.prepare(`
    INSERT INTO twin_pages(id,route,page_name,entry_conditions,exit_transitions,upstream_pages,downstream_pages,crawled_at,source)
    VALUES(?,?,?,?,?,?,?,?,?)
  `),
};

// Best-effort JSON parse: model sometimes wraps in ``` despite the system prompt.
function extractJson(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  let s = String(raw).trim();
  // Strip code fences if present
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find the outermost JSON object
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Extract structured twin data from a document and merge into the twin store.
 * @param {object} opts
 *   text       — raw text (already extracted from PPT / requirement doc); preferred
 *   html       — alternative: HTML (Confluence export) — converted to text internally
 *   source     — 'confluence' | 'ppt' | 'manual' | etc. (stored on rules)
 *   sourceUrl  — optional reference url
 *   aiOpts     — provider/model/keys
 * @returns { added: { rules, transitions, roles, requirements, orphanPages }, raw }
 */
async function extractAndMerge({ text, html, source = 'manual', sourceUrl = '', aiOpts = {} } = {}) {
  const body = text || htmlToText(html);
  if (!body || body.length < 30) throw new Error('Document is empty or too short to extract');

  // Cap input size so the LLM call stays sensible
  const MAX = 18000;
  const input = body.length > MAX ? body.slice(0, MAX) + '\n\n[... truncated ...]' : body;

  const prompt = `${SCHEMA_HINT}\n\nDocument:\n${input}\n\nReturn ONLY the JSON object — no prose, no markdown.`;

  let resp;
  try {
    resp = await callAI(prompt, 6000, { ...aiOpts, systemPrompt: SYSTEM_PROMPT });
  } catch (e) {
    throw new Error(`AI extraction failed: ${e.message}`);
  }
  const data = extractJson(resp);
  if (!data) throw new Error('LLM returned non-JSON or malformed response');

  // ── Reconcile ──────────────────────────────────────────────────────────────
  const pageMappings = Array.isArray(data.page_mappings) ? data.page_mappings : [];
  // Resolve each page mapping → page_id (existing match or create an "orphan" page row)
  const resolvedPageByName = new Map();
  for (const pm of pageMappings) {
    if (!pm?.page_name) continue;
    const match = fuzzyMatchPage(pm.page_name, pm.route_hint);
    if (match) {
      resolvedPageByName.set(normalise(pm.page_name), match.id);
    } else {
      const id = uid();
      const route = pm.route_hint || `/__extracted__/${normalise(pm.page_name) || 'page-' + id.slice(0, 6)}`;
      STMT.insertOrphanPage.run(id, route, pm.page_name, '[]', '[]', '[]', '[]', now(), source);
      resolvedPageByName.set(normalise(pm.page_name), id);
    }
  }

  // Helper: resolve a page_name (or applies_to/from_page/to_page) to a page_id
  function resolvePageId(name) {
    if (!name) return null;
    const n = normalise(name);
    if (resolvedPageByName.has(n)) return resolvedPageByName.get(n);
    // Fall back to fuzzy match against existing pages
    const m = fuzzyMatchPage(name, '');
    if (m) { resolvedPageByName.set(n, m.id); return m.id; }
    return null;
  }

  let addedRules = 0, addedTransitions = 0, addedRoles = 0, addedRequirements = 0;

  // ── business_rules → twin_rules ─────────────────────────────────────────────
  const tx = db.transaction(() => {
    for (const r of (data.business_rules || [])) {
      if (!r?.rule_text) continue;
      const pageId = resolvePageId(r.applies_to);
      STMT.insertRule.run(
        uid(), pageId, r.rule_text,
        r.applies_to || null, r.condition || null, r.expected_outcome || null,
        source, JSON.stringify(r.requirement_ids || []),
      );
      addedRules++;
    }

    // ── flow_steps → twin_transitions (and create requirement-anchored navigation) ─
    for (const f of (data.flow_steps || [])) {
      const fromId = resolvePageId(f?.from_page);
      // Resolve to_page to a route string. If the to_page resolves to an existing page, use its route.
      let targetRoute = f?.to_page || null;
      const toId = resolvePageId(f?.to_page);
      if (toId) {
        const row = db.prepare(`SELECT route FROM twin_pages WHERE id=?`).get(toId);
        targetRoute = row?.route || targetRoute;
      }
      STMT.insertTransition.run(
        uid(), fromId || null, f?.action || 'navigate', targetRoute, f?.condition || null, null,
      );
      addedTransitions++;
    }

    // ── user_personas → twin_roles (attached to each mapped page if scoped, else page_id null) ─
    for (const p of (data.user_personas || [])) {
      if (!p?.role_name) continue;
      // Attach the persona to each mapped page as a "role hint"; if no mapped pages, attach to all crawled pages.
      const targetPages = resolvedPageByName.size
        ? [...resolvedPageByName.values()]
        : db.prepare(`SELECT id FROM twin_pages WHERE deleted_at IS NULL`).all().map(r => r.id);
      for (const pageId of targetPages) {
        STMT.insertRole.run(
          uid(), pageId, p.role_name, 'full',
          JSON.stringify({ permissions: p.permissions || [], typical_journey: p.typical_journey || [] }),
        );
        addedRoles++;
      }
    }

    // ── acceptance_criteria → twin_requirements (one row per criterion linked to its requirement) ─
    for (const ac of (data.acceptance_criteria || [])) {
      if (!ac?.criterion) continue;
      const targetPages = resolvedPageByName.size ? [...resolvedPageByName.values()] : [null];
      for (const pageId of targetPages) {
        STMT.insertRequirement.run(
          uid(), pageId, ac.linked_requirement || ac.criterion.slice(0, 80), ac.criterion, sourceUrl || null, now(),
        );
        addedRequirements++;
      }
    }
  });
  tx();

  return {
    added: {
      rules:        addedRules,
      transitions:  addedTransitions,
      roles:        addedRoles,
      requirements: addedRequirements,
      orphanPages:  pageMappings.length - [...resolvedPageByName.keys()].filter(k => {
        const row = db.prepare(`SELECT source FROM twin_pages WHERE id=?`).get(resolvedPageByName.get(k));
        return row && row.source !== source;
      }).length,
    },
    raw: data,
  };
}

module.exports = { extractAndMerge, htmlToText };
