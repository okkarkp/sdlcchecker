/**
 * lib/twin/context.js — Digital Twin context package assembler
 *
 * Synchronous (better-sqlite3) reader that produces a structured context object
 * for grounding LLM test generation. Returns null when no page exists for the
 * given route, so callers can fall back to unguided generation.
 */
'use strict';

const { db } = require('../db');

const JSONp = (s, fallback) => {
  try { return JSON.parse(s || ''); } catch { return fallback; }
};

// Pick a single page row, preferring the most recently crawled non-deleted match.
function findPage(route) {
  if (!route) return null;
  // Exact match first (with deleted filter)
  let row = db.prepare(
    `SELECT * FROM twin_pages WHERE route=? AND deleted_at IS NULL ORDER BY crawled_at DESC LIMIT 1`
  ).get(route);
  if (row) return row;
  // Loose match: trailing slash / leading slash variants
  const variants = [
    route.endsWith('/') ? route.slice(0, -1) : route + '/',
    route.startsWith('/') ? route.slice(1) : '/' + route,
  ];
  for (const v of variants) {
    row = db.prepare(`SELECT * FROM twin_pages WHERE route=? AND deleted_at IS NULL LIMIT 1`).get(v);
    if (row) return row;
  }
  return null;
}

/**
 * @param {string} route
 * @param {object} options
 *   role             — restrict role_variants to a single role
 *   includeUpstream  — single-hop upstream context (default true)
 *   includeDownstream— single-hop downstream context (default true)
 *   _hopDepth        — internal: prevents infinite recursion (max 1 hop)
 * @returns {object|null}
 */
function assembleTwinContext(route, options = {}) {
  const {
    role = null,
    includeUpstream = true,
    includeDownstream = true,
    _hopDepth = 0,
  } = options;

  const page = findPage(route);
  if (!page) return null;

  const elements = db.prepare(
    `SELECT * FROM twin_elements WHERE page_id=? AND deleted_at IS NULL`
  ).all(page.id);

  const rules = db.prepare(
    `SELECT * FROM twin_rules WHERE page_id=? AND deleted_at IS NULL`
  ).all(page.id);

  const transitions = db.prepare(
    `SELECT * FROM twin_transitions WHERE page_id=? AND deleted_at IS NULL`
  ).all(page.id);

  const apis = db.prepare(
    `SELECT * FROM twin_api_contracts WHERE page_id=? AND deleted_at IS NULL`
  ).all(page.id);

  const roleRows = role
    ? db.prepare(`SELECT * FROM twin_roles WHERE page_id=? AND role_name=? AND deleted_at IS NULL`).all(page.id, role)
    : db.prepare(`SELECT * FROM twin_roles WHERE page_id=? AND deleted_at IS NULL`).all(page.id);

  const requirements = db.prepare(
    `SELECT * FROM twin_requirements WHERE page_id=? AND deleted_at IS NULL`
  ).all(page.id);

  // Neighbours — single hop only. Recurse with _hopDepth + 1 so neighbour fetches don't recurse again.
  let upstream = [], downstream = [];
  if (_hopDepth === 0) {
    if (includeUpstream) {
      for (const r of JSONp(page.upstream_pages, [])) {
        const ctx = assembleTwinContext(r, { includeUpstream: false, includeDownstream: false, _hopDepth: 1 });
        if (ctx) upstream.push(ctx);
      }
    }
    if (includeDownstream) {
      for (const r of JSONp(page.downstream_pages, [])) {
        const ctx = assembleTwinContext(r, { includeUpstream: false, includeDownstream: false, _hopDepth: 1 });
        if (ctx) downstream.push(ctx);
      }
    }
  }

  return {
    page: {
      route: page.route,
      name:  page.page_name,
      entry_conditions: JSONp(page.entry_conditions, []),
    },
    elements: elements.map(e => ({
      id:           e.element_id,
      tag:          e.tag,
      type:         e.type,
      role:         e.role,
      label:        e.label,
      required:     !!e.required,
      disabled:     !!e.disabled_by_default,
      enabled_when: e.enabled_when,
      placeholder:  e.placeholder,
      test_id:      e.test_id,
      locator:      e.locator_strategy,
    })),
    business_rules:   rules.map(r => r.rule_text),
    validation_rules: rules
      .filter(r => r.applies_to && (r.condition || r.expected_outcome))
      .map(r => ({ field: r.applies_to, condition: r.condition, outcome: r.expected_outcome })),
    transitions: transitions.map(t => ({
      trigger: t.trigger_action,
      target:  t.target_route,
      guard:   t.guard_condition,
      effect:  t.effect,
    })),
    api_contracts: apis.map(a => ({
      method:   a.method,
      endpoint: a.endpoint,
      success:  a.success_status,
      errors:   JSONp(a.error_codes, []),
    })),
    role_variants: roleRows.map(r => ({
      role: r.role_name,
      access_level: r.access_level,
      overrides:    JSONp(r.element_overrides, []),
    })),
    requirements:  requirements.map(r => r.requirement_id),
    upstream_pages: upstream.map(p => ({ route: p.page.route, name: p.page.name })),
    downstream_pages: downstream.map(p => ({ route: p.page.route, name: p.page.name })),
  };
}

/**
 * Render the assembled context as a prompt block ready to inject into
 * the test-generation system prompt.
 */
function renderTwinPromptBlock(ctx) {
  if (!ctx) return '';
  const submitSuccess = ctx.transitions.find(t => /success|submit_success|navigate/i.test(t.trigger || ''));
  const submitFail    = ctx.transitions.find(t => /fail|error|submit_failure/i.test(t.trigger || ''));
  const api0          = ctx.api_contracts[0];

  return [
    '=== DIGITAL TWIN CONTEXT ===',
    'You have access to a verified, crawled model of the application. Use this as ground truth — do not invent UI elements, fields, or behaviours not listed here.',
    '',
    `Page: ${ctx.page.name} (${ctx.page.route})`,
    ctx.page.entry_conditions.length ? `Entry conditions: ${ctx.page.entry_conditions.join(', ')}` : '',
    '',
    'UI Elements on this page:',
    ctx.elements.length
      ? ctx.elements.map(e => `  - [${e.type || e.tag}] "${e.label || '(no label)'}"${e.id ? ` (id: ${e.id})` : ''} required:${e.required}${e.locator ? ` locator: ${e.locator}` : ''}`).join('\n')
      : '  (none captured)',
    '',
    'Business rules:',
    ctx.business_rules.length ? ctx.business_rules.map(r => `  - ${r}`).join('\n') : '  (none extracted)',
    '',
    'Field validation rules:',
    ctx.validation_rules.length
      ? ctx.validation_rules.map(v => `  - ${v.field}: IF ${v.condition || '?'} THEN ${v.outcome || '?'}`).join('\n')
      : '  (none extracted)',
    '',
    submitSuccess ? `On submit success → navigates to: ${submitSuccess.target}` : '',
    submitFail    ? `On submit failure → ${submitFail.guard || submitFail.target || '(see error states)'}` : '',
    api0 ? `API called: ${api0.method} ${api0.endpoint}  Success: ${api0.success || '?'} | Errors: ${(api0.errors || []).join(', ') || 'none'}` : '',
    '',
    ctx.upstream_pages.length   ? `Upstream pages (pre-conditions already met): ${ctx.upstream_pages.map(p => p.name || p.route).join(', ')}` : '',
    ctx.downstream_pages.length ? `Downstream pages (assert navigation): ${ctx.downstream_pages.map(p => p.name || p.route).join(', ')}` : '',
    ctx.requirements.length     ? `Linked requirements: ${ctx.requirements.join(', ')}` : '',
    '=== END TWIN CONTEXT ===',
  ].filter(Boolean).join('\n');
}

// Convenience: list all crawled routes (used by API + UI)
function listPages() {
  return db.prepare(
    `SELECT id, route, page_name, module, crawled_at,
            (SELECT COUNT(*) FROM twin_elements e WHERE e.page_id=p.id AND e.deleted_at IS NULL) AS elements_count,
            (SELECT COUNT(*) FROM twin_rules r    WHERE r.page_id=p.id AND r.deleted_at IS NULL) AS rules_count,
            (SELECT COUNT(*) FROM twin_api_contracts a WHERE a.page_id=p.id AND a.deleted_at IS NULL) AS apis_count
     FROM twin_pages p
     WHERE p.deleted_at IS NULL
     ORDER BY COALESCE(NULLIF(p.module,''),'~'), p.route`
  ).all();
}

function getMeta() {
  const row = db.prepare(`SELECT * FROM twin_meta WHERE id=1`).get();
  if (!row) return { total_routes: 0, total_elements: 0, total_apis: 0, duration_ms: 0, crawled_at: null, config: {} };
  return { ...row, config: JSONp(row.config, {}) };
}

// Best-effort: resolve a free-text hint (module name, page title, route fragment)
// to the most likely crawled route. Returns the route string or null.
function resolveRouteFromHint(hint) {
  if (!hint) return null;
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const h = norm(hint);
  if (!h) return null;
  const pages = db.prepare(`SELECT route, page_name FROM twin_pages WHERE deleted_at IS NULL`).all();
  let best = null, bestScore = 0;
  for (const p of pages) {
    const route = norm(p.route), name = norm(p.page_name);
    let score = 0;
    if (name && (name.includes(h) || h.includes(name))) score += 2;
    if (route && (route.includes(h) || h.includes(route))) score += 2;
    if (score > bestScore) { best = p.route; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}

// One-call convenience for generators: given a free-text hint (module/title/route),
// return a ready-to-inject prompt block, or '' when nothing matches (no twin data,
// or no confident route match → generation proceeds unguided).
function twinPromptForHint(hint, { role = null } = {}) {
  try {
    // Direct route match first (hint may already be a route like "/login")
    let ctx = (hint && /^\//.test(hint)) ? assembleTwinContext(hint, { role }) : null;
    if (!ctx) {
      const route = resolveRouteFromHint(hint);
      if (route) ctx = assembleTwinContext(route, { role });
    }
    return ctx ? '\n' + renderTwinPromptBlock(ctx) + '\n' : '';
  } catch { return ''; }
}

module.exports = {
  assembleTwinContext, renderTwinPromptBlock, listPages, getMeta,
  resolveRouteFromHint, twinPromptForHint,
};
