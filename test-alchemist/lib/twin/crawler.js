/**
 * lib/twin/crawler.js — Digital Twin Playwright crawler
 *
 * Authenticated BFS crawl of the target app that builds a structured model:
 *   • twin_pages           — route + entry/exit metadata + neighbours
 *   • twin_elements        — visible interactive elements per page (with locators)
 *   • twin_transitions     — clickable elements that change route
 *   • twin_api_contracts   — fetch/XHR observed while on the page
 *   • twin_roles           — per-role element variants (diffed across roles)
 *   • twin_meta            — last crawl summary
 *
 * Reuses the browser-agent's deep-DOM walk (shadow-root aware) and autoLogin so
 * a Digital Twin crawl of an Angular MFE works the same as the agent flow.
 *
 * Streams progress via the existing global.broadcastTo(clientId, {type,…}) WS pattern.
 */
'use strict';

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const { db, uid, now, saveAppFlow, getAppFlows, deleteAppFlow } = require('../db');
const { _internals: BA } = require('../browser-agent');

const APP_ROOT  = path.join(__dirname, '..', '..');
const PW_MODULE = path.join(APP_ROOT, 'node_modules', 'playwright');

const MAX_DEPTH          = Number(process.env.TWIN_MAX_DEPTH)     || 5;
const MAX_ROUTES         = Number(process.env.TWIN_MAX_ROUTES)    || 200;
const PER_PAGE_TIMEOUT   = Number(process.env.TWIN_PAGE_TIMEOUT)  || 25000;
const API_OBSERVE_MS     = Number(process.env.TWIN_API_WAIT_MS)   || 3000;
// SPA navigation is button/router-driven, so we also CLICK navigation elements to
// discover routes that aren't <a href>. Cap clicks per page to bound crawl time.
const MAX_CLICKS_PER_PAGE = Number(process.env.TWIN_MAX_CLICKS)   || 40;
const CRAWL_BUDGET_MS     = Number(process.env.TWIN_BUDGET_MS)    || 15 * 60 * 1000;

// Exclude these patterns from auto-discovery / never click them (destructive or off-app)
const SKIP_HREF_RE   = /\b(logout|sign[\s_-]?out|download|\.pdf|\.zip|\.xlsx|\.docx|\.csv|mailto:|tel:)\b/i;
const DESTRUCTIVE_RE = /log\s*out|sign\s*out|\bdelete\b|\bremove\b|\bsubmit\b|\bsave\b|\bconfirm\b|\bpay\b|\bcancel\b|\breset\b|\bapprove\b|\breject\b|withdraw|terminate/i;

// ── Utilities ────────────────────────────────────────────────────────────────
function emit(clientId, type, payload) {
  try { global.broadcastTo?.(clientId || 'anon', { type, ...payload }); } catch {}
}

function emitProgress(clientId, level, text) {
  emit(clientId, 'twin_progress', { level, text });
}

// Normalise a URL to a stable route key: pathname + sorted query keys (no values).
// Cuts down on duplicates from session ids / cache busters.
function routeOf(urlStr, baseUrl) {
  try {
    const u = new URL(urlStr, baseUrl);
    // Same-origin only — external links shouldn't enter the crawl frontier
    const base = new URL(baseUrl);
    if (u.origin !== base.origin) return null;
    let p = u.pathname.replace(/\/+$/, '') || '/';
    const keys = [...u.searchParams.keys()].sort();
    let key = keys.length ? `${p}?${keys.join('&')}` : p;
    // SPA hash routing (e.g. #/dashboard) — fold the hash path into the route key so
    // hash-routed Angular/React apps are crawled as distinct routes.
    if (u.hash && /^#\/?\w/.test(u.hash)) {
      const hp = u.hash.replace(/^#/, '').split('?')[0].replace(/\/+$/, '');
      if (hp && hp !== '/') key = `${p === '/' ? '' : p}#${hp.startsWith('/') ? hp : '/' + hp}`;
    }
    return key;
  } catch { return null; }
}

function fullUrl(route, baseUrl) {
  if (/^https?:/i.test(route)) return route;
  try { return new URL(route, baseUrl).toString(); } catch { return baseUrl + route; }
}

// ── Per-page extractors (run in the browser context) ─────────────────────────
const COLLECT_ELEMENTS_FN = `
(() => {
  ${BA.DEEP_DOM_FNS}
  const SEL = 'input, button, select, textarea, a[href], [role="button"], [role="link"], [role="tab"], [role="dialog"], table, [data-testid], form';
  const els = deep(SEL).filter(vis);
  return els.slice(0, 250).map(el => {
    const tag = el.tagName.toLowerCase();
    const id  = el.id || null;
    const testId = el.getAttribute('data-testid') || null;
    const name = el.getAttribute('name') || null;
    const label = (() => {
      try { if (el.labels && el.labels[0]) return el.labels[0].innerText.trim(); } catch {}
      return el.getAttribute('aria-label')
          || el.getAttribute('aria-labelledby')
          || (el.innerText || '').trim().slice(0, 80)
          || null;
    })();
    const locator = id ? '#' + id
      : testId ? '[data-testid="' + testId + '"]'
      : name ? '[name="' + name + '"]'
      : label ? (tag + ':has-text("' + label.replace(/"/g, '\\\\"').slice(0, 40) + '")')
      : tag;
    return {
      tag,
      role: el.getAttribute('role') || tag,
      id, name, testId,
      type: el.getAttribute('type') || null,
      required: !!el.required,
      disabled: !!el.disabled,
      label,
      placeholder: el.getAttribute('placeholder') || null,
      visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
      locator,
    };
  });
})()
`;

// Tag every navigation-intent element with data-twin-idx (deep, pierces shadow roots)
// and return descriptors. We then click by [data-twin-idx="N"] — which Playwright
// resolves through open shadow DOM — instead of fragile exact-text matching.
// Broad on purpose so router-driven SPA menus (Angular MFE) are actually found.
const TAG_CANDIDATES_FN = `
(() => {
  ${BA.DEEP_DOM_FNS}
  const SEL = [
    'a','[role=link]','[role=tab]','[role=menuitem]','[role=treeitem]','[role=button]',
    'button','[routerlink]','[ng-reflect-router-link]','[href]',
    '[class*=nav] a','[class*=nav] li','[class*=menu] a','[class*=menu] li',
    '[class*=sidebar] a','[class*=sidebar] li','[class*=tab] [role]','li[class*=item]'
  ].join(',');
  const isClickable = (el) => {
    if (el.tagName === 'A' || el.hasAttribute('routerlink') || el.hasAttribute('href')) return true;
    const r = el.getAttribute('role') || '';
    if (/link|tab|menuitem|treeitem|button/.test(r)) return true;
    if (el.tagName === 'BUTTON') return true;
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (e) {}
    return false;
  };
  const out = []; const seenEl = new Set(); let i = 0;
  for (const el of deep(SEL).filter(vis)) {
    if (seenEl.has(el) || !isClickable(el)) continue;
    seenEl.add(el);
    const text = (el.innerText || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const href = el.getAttribute('href') || el.getAttribute('routerlink') || null;
    el.setAttribute('data-twin-idx', String(i));
    out.push({ idx: i, text, href, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' });
    i++;
    if (i >= ${MAX_CLICKS_PER_PAGE * 3}) break;
  }
  return out;
})()
`;

const COLLECT_LINKS_FN = `
(() => {
  ${BA.DEEP_DOM_FNS}
  const out = [];
  // Real anchors with hrefs
  for (const a of deep('a[href]').filter(vis)) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    out.push({ kind: 'href', href, text: (a.innerText || a.getAttribute('aria-label') || '').trim().slice(0, 80) });
  }
  // SPA-style clickable nav items (role=link / role=tab / role=menuitem) — capture text so
  // a later pass can click them to discover routes that aren't in href form.
  for (const el of deep('[role=link],[role=tab],[role=menuitem],nav button,aside button').filter(vis)) {
    out.push({ kind: 'click', text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80) });
  }
  return out;
})()
`;

// ── Persistence helpers (synchronous better-sqlite3 prepared statements) ─────
const STMT = {
  insertPage: db.prepare(`
    INSERT INTO twin_pages(id,route,page_name,module,entry_conditions,exit_transitions,upstream_pages,downstream_pages,crawled_at,source)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `),
  updatePageNeighbours: db.prepare(`
    UPDATE twin_pages SET upstream_pages=?, downstream_pages=?, exit_transitions=?, crawled_at=? WHERE id=?
  `),
  setPageModule: db.prepare(`UPDATE twin_pages SET module=? WHERE id=? AND (module IS NULL OR module='')`),
  findPageByRoute: db.prepare(`SELECT * FROM twin_pages WHERE route=? AND deleted_at IS NULL`),
  insertElement: db.prepare(`
    INSERT INTO twin_elements(id,page_id,element_id,tag,role,label,type,required,disabled_by_default,enabled_when,placeholder,test_id,locator_strategy)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `),
  insertTransition: db.prepare(`
    INSERT INTO twin_transitions(id,page_id,trigger_action,target_route,guard_condition,effect)
    VALUES(?,?,?,?,?,?)
  `),
  insertApi: db.prepare(`
    INSERT INTO twin_api_contracts(id,page_id,method,endpoint,request_schema,success_status,error_codes,response_schema)
    VALUES(?,?,?,?,?,?,?,?)
  `),
  insertRole: db.prepare(`
    INSERT INTO twin_roles(id,page_id,role_name,access_level,element_overrides)
    VALUES(?,?,?,?,?)
  `),
  softDeleteAll: db.exec.bind(db),
  upsertMeta: db.prepare(`
    INSERT INTO twin_meta(id,total_routes,total_elements,total_apis,duration_ms,crawled_at,config)
    VALUES(1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      total_routes=excluded.total_routes,
      total_elements=excluded.total_elements,
      total_apis=excluded.total_apis,
      duration_ms=excluded.duration_ms,
      crawled_at=excluded.crawled_at,
      config=excluded.config
  `),
};

function softDeleteAllTwinRows() {
  // Soft-delete via timestamp so referential history is preserved.
  // Used ONLY by the explicit user "Reset Twin" action — wipes everything.
  const ts = now();
  db.prepare(`UPDATE twin_pages          SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_elements       SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_rules          SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_transitions    SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_api_contracts  SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_roles          SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
  db.prepare(`UPDATE twin_requirements   SET deleted_at=? WHERE deleted_at IS NULL`).run(ts);
}

// Soft-delete ONLY auto-crawler pages (source='crawler') and their child rows.
// A re-crawl refreshes the auto-discovered model WITHOUT touching pages the user
// recorded by hand (source='guided') — so recordings persist until the user
// explicitly resets the twin or deletes the flow. App Flows are never touched here.
function softDeleteCrawlerRows() {
  const ts = now();
  const crawlerPageIds = db.prepare(
    `SELECT id FROM twin_pages WHERE deleted_at IS NULL AND COALESCE(source,'crawler')='crawler'`
  ).all().map(r => r.id);
  if (!crawlerPageIds.length) return 0;
  const wipe = db.transaction((ids) => {
    for (const id of ids) {
      for (const tbl of ['twin_elements', 'twin_transitions', 'twin_api_contracts', 'twin_roles']) {
        db.prepare(`UPDATE ${tbl} SET deleted_at=? WHERE deleted_at IS NULL AND page_id=?`).run(ts, id);
      }
      db.prepare(`UPDATE twin_pages SET deleted_at=? WHERE id=?`).run(ts, id);
    }
  });
  wipe(crawlerPageIds);
  return crawlerPageIds.length;
}

// Soft-delete a page's current child rows so a re-crawl REFRESHES the page instead
// of appending duplicate elements/APIs each run. Keeps the page row (and its module).
function clearPageChildren(pageId) {
  const ts = now();
  for (const tbl of ['twin_elements', 'twin_transitions', 'twin_api_contracts']) {
    db.prepare(`UPDATE ${tbl} SET deleted_at=? WHERE deleted_at IS NULL AND page_id=?`).run(ts, pageId);
  }
}

function savePage({ route, name, module = '', source = 'crawler' }) {
  const existing = STMT.findPageByRoute.get(route);
  if (existing) {
    // Backfill the module on an already-known page (e.g. a guided recording revisits it)
    if (module) { try { STMT.setPageModule.run(module, existing.id); } catch {} }
    return existing.id;
  }
  const id = uid();
  STMT.insertPage.run(id, route, name || route, module || '', '[]', '[]', '[]', '[]', now(), source);
  return id;
}

function saveElements(pageId, elements, roleName = null) {
  // Diff-aware: collect what's recorded as the "base" and per-role overrides.
  if (!roleName) {
    const insert = db.transaction((els) => {
      for (const e of els) {
        STMT.insertElement.run(
          uid(), pageId,
          e.id || e.name || e.testId || null,
          e.tag, e.role, e.label, e.type,
          e.required ? 1 : 0,
          e.disabled ? 1 : 0,
          null,                       // enabled_when — populated later by extractor
          e.placeholder,
          e.testId,
          e.locator
        );
      }
    });
    insert(elements);
  } else {
    // Per-role: store as override JSON on twin_roles
    STMT.insertRole.run(
      uid(), pageId, roleName, 'full',
      JSON.stringify(elements.map(e => ({ label: e.label, locator: e.locator, disabled: e.disabled, visible: e.visible })))
    );
  }
}

function saveTransitions(pageId, transitions) {
  const insert = db.transaction((ts) => {
    for (const t of ts) {
      STMT.insertTransition.run(
        uid(), pageId, t.trigger || 'click', t.target || null, t.guard || null, t.effect || null
      );
    }
  });
  insert(transitions);
}

function saveApis(pageId, apis) {
  const insert = db.transaction((rows) => {
    for (const a of rows) {
      STMT.insertApi.run(
        uid(), pageId, a.method, a.endpoint,
        a.requestSchema ? JSON.stringify(a.requestSchema) : null,
        a.status || null,
        JSON.stringify(a.errorCodes || []),
        a.responseSchema ? JSON.stringify(a.responseSchema) : null,
      );
    }
  });
  insert(apis);
}

// ── Crawl one route: observe elements + capture APIs while on it ─────────────
async function crawlOneRoute(page, route, baseUrl, clientId, deadline = Infinity) {
  emitProgress(clientId, 'progress', `→ visiting ${route}`);
  const target = fullUrl(route, baseUrl);

  // Network capture: APIs called while this page is the active one
  const apis = [];
  const reqMap = new Map();
  const onReq = (req) => {
    const rt = req.resourceType();
    if (rt !== 'fetch' && rt !== 'xhr') return;
    // Only attribute requests fired while still ON this route. A nav-click changes the
    // route before its load XHRs fire (so they're skipped here and captured on that
    // route's own visit), while same-route interactions (tabs, accordions, lazy loads)
    // ARE captured — so each module records the full set of APIs it actually calls.
    if (routeOf(page.url(), baseUrl) !== route) return;
    const u = (() => { try { return new URL(req.url()); } catch { return null; } })();
    if (!u) return;
    // Same-origin only, and skip noisy assets
    try { if (u.origin !== new URL(baseUrl).origin) return; } catch {}
    reqMap.set(req, { method: req.method(), endpoint: u.pathname + (u.search || '') });
  };
  const onRes = (res) => {
    const req = res.request();
    const entry = reqMap.get(req);
    if (!entry) return;
    const status = res.status();
    apis.push({
      method:   entry.method,
      endpoint: entry.endpoint,
      status:   status >= 200 && status < 400 ? status : null,
      errorCodes: status >= 400 ? [status] : [],
    });
  };
  page.on('request',  onReq);
  page.on('response', onRes);

  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(API_OBSERVE_MS);
  } catch (e) {
    emitProgress(clientId, 'warn', `⚠ goto failed for ${route}: ${e.message}`);
  }

  let elements = [], links = [];
  try { elements = await page.evaluate(COLLECT_ELEMENTS_FN); } catch (e) { emitProgress(clientId, 'warn', `⚠ element scan failed: ${e.message}`); }
  try { links    = await page.evaluate(COLLECT_LINKS_FN);    } catch (e) { emitProgress(clientId, 'warn', `⚠ link scan failed: ${e.message}`);    }

  // ── Discover outgoing routes ────────────────────────────────────────────────
  const outgoing = [];
  const seen = new Set();
  const addOut = (r, text) => {
    if (!r || r === route || seen.has(r)) return;
    seen.add(r);
    outgoing.push({ target: r, text: text || 'navigate' });
  };

  // 1. Real anchors with hrefs (cheap)
  for (const l of links) {
    if (l.kind !== 'href' || SKIP_HREF_RE.test(l.href)) continue;
    addOut(routeOf(l.href, baseUrl), l.text);
  }

  // 2. Click-driven discovery — the key for SPAs (Angular MFE / router nav).
  // Tag candidates and click by index ([data-twin-idx] pierces shadow DOM), observe
  // the URL change, then return to this route to try the next. Destructive labels skipped.
  let candidates = [];
  try { candidates = await page.evaluate(TAG_CANDIDATES_FN); } catch (e) { emitProgress(clientId, 'warn', `⚠ candidate scan failed: ${e.message}`); }

  // Diagnostics so it's clear what the crawler actually sees on this page
  const title = await page.title().catch(() => '');
  emitProgress(clientId, 'progress', `   ↳ "${(title || '').slice(0, 50)}" · ${elements.length} elements · ${candidates.length} nav candidate(s)`);

  // First harvest href/routerlink targets directly (no click needed)
  for (const c of candidates) {
    if (c.href && /^(https?:|\/)/.test(c.href) && !c.href.startsWith('//')) {
      const r = routeOf(c.href, baseUrl);
      if (r && !SKIP_HREF_RE.test(c.href)) addOut(r, c.text);
    }
  }

  // Then click the rest to discover router-driven routes
  let clicks = 0, navs = 0;
  for (const c of candidates) {
    if (Date.now() > deadline || clicks >= MAX_CLICKS_PER_PAGE) break;
    if (DESTRUCTIVE_RE.test(c.text)) continue;
    // Skip elements with no text AND no href that aren't clearly nav (avoids icon buttons w/ side effects)
    if (!c.text && !c.href && !/link|tab|menuitem|treeitem/.test(c.role) && c.tag !== 'a') continue;
    // Already harvested via href above → no need to click
    if (c.href && /^(https?:|\/)/.test(c.href) && !c.href.startsWith('//')) continue;
    try {
      // Ensure we're back on this route, then re-tag so the index is valid post-render
      if (routeOf(page.url(), baseUrl) !== route) {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
        await page.waitForTimeout(400);
        await page.evaluate(TAG_CANDIDATES_FN).catch(() => {});
      }
      const before = routeOf(page.url(), baseUrl);
      const loc = page.locator(`[data-twin-idx="${c.idx}"]`).first();
      if (!(await loc.count())) continue;
      clicks++;
      await loc.click({ timeout: 4000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(600);
      const after = routeOf(page.url(), baseUrl);
      if (after && after !== before) { addOut(after, c.text); navs++; }
    } catch { /* not clickable / no nav / detached — skip */ }
  }
  if (clicks) emitProgress(clientId, 'progress', `   ↳ clicked ${clicks} · ${navs} led to new route(s)`);

  // Stop capture and de-duplicate APIs by method+endpoint
  page.off('request',  onReq);
  page.off('response', onRes);
  const apiByKey = new Map();
  for (const a of apis) {
    const k = `${a.method} ${a.endpoint}`;
    const existing = apiByKey.get(k);
    if (!existing) { apiByKey.set(k, a); continue; }
    existing.status = existing.status || a.status;
    existing.errorCodes = [...new Set([...(existing.errorCodes || []), ...(a.errorCodes || [])])];
  }

  return { elements, apis: [...apiByKey.values()], outgoing };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Resolve the identity used to authenticate. This app uses a SingPass/CorpPass MOCK
// (UIN / UEN / UUID) rather than username+password — but we keep user/pass as an
// optional fallback so a standard login page is still handled if one ever appears.
function resolveIdentity(config = {}) {
  const id = config.identity || config.credentials || {};
  const rawUuid = id.uuid || process.env.TEST_UUID || '';
  const uuid = UUID_RE.test(rawUuid) ? rawUuid
             : /^(generate|new|random)$/i.test(rawUuid) ? crypto.randomUUID()
             : (rawUuid || crypto.randomUUID());
  // Identity comes from the crawl config the user entered for THIS app's URL — no fixed
  // APP_* env defaults, so the crawler works across different projects.
  return {
    uin:      id.uin      || '',
    uen:      id.uen      || '',
    uuid,
    username: id.username || '',
    password: id.password || '',
  };
}

// Drive a (possibly multi-step) mock login: fill any UUID fields, then a SP/CP mock
// identity form (UIN/UEN), and fall back to a username/password page if present.
// Loops a few times to pass through multi-page login flows (first page → SP/CP mock).
async function performLogin(page, identity, clientId) {
  const emit = (lvl, txt) => emitProgress(clientId, lvl, txt);
  for (let step = 0; step < 4; step++) {
    await page.waitForTimeout(700);

    // Always satisfy UUID/correlation-id fields first
    if (identity.uuid) await BA.autoFillUuids(page, identity.uuid, emit);

    // SingPass/CorpPass MOCK (UIN, optional UEN) — the primary path for this app
    if (identity.uin && await BA.hasMockLoginForm(page)) {
      emit('progress', `🔐 Mock login → ${[identity.uin, identity.uen].filter(Boolean).join(' + ')}`);
      await BA.autoSpLogin(page, identity.uin, identity.uen, emit);
      await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
      continue;   // re-check: there may be a follow-up page
    }

    // Optional fallback: a real username/password page
    if (identity.username && identity.password && await BA.hasLoginForm(page)) {
      emit('progress', `🔐 Signing in as ${identity.username}…`);
      await BA.autoLogin(page, identity, emit);
      await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
      continue;
    }

    // No (more) login forms detected → done
    break;
  }
}

// ── Public: run a full crawl ─────────────────────────────────────────────────
/**
 * @param {object} config
 *   baseUrl          — required
 *   loginRoute       — optional (default: baseUrl)
 *   identity         — { uin, uen, uuid, username?, password? } mock-login identity for
 *                      THIS app's URL (entered in the crawl config). No fixed env defaults;
 *                      uuid falls back to TEST_UUID or a generated v4 (a test value, not a credential).
 *   routes           — optional whitelist of routes; empty → auto-discover from baseUrl
 *   roles            — optional [{ name, identity }] for per-role diff (extra logins)
 *   clientId         — WS client id for progress streaming
 *   resetBeforeCrawl — soft-delete existing twin rows first (default true)
 */
async function runCrawl(config) {
  const startedAt = Date.now();
  const clientId  = config.clientId || 'anon';
  const baseUrl   = (config.baseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl required (or set APP_BASE_URL in .env)');

  const identity = resolveIdentity(config);
  const seedRoutes = Array.isArray(config.routes) && config.routes.length
    ? config.routes.map(r => routeOf(r.startsWith('http') ? r : (baseUrl + r), baseUrl)).filter(Boolean)
    : [];

  if (config.resetBeforeCrawl !== false) {
    const n = softDeleteCrawlerRows();
    emitProgress(clientId, 'progress', `✶ Refreshing auto-crawled pages (${n} cleared) — recorded modules & flows are kept`);
  }

  emit(clientId, 'twin_start', { baseUrl, seedRoutes, roles: (config.roles || []).map(r => r.name) });
  emitProgress(clientId, 'start', `🧬 Digital Twin crawl: ${baseUrl}`);

  const { browser, page } = await BA.launchBrowser();

  // Auth once on the base login page (mock UIN/UEN/UUID, with user/pass fallback)
  try {
    await page.goto(config.loginRoute || baseUrl, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await performLogin(page, identity, clientId);
    // Diagnostic: confirm where login landed so a stuck-on-login state is obvious
    const landedUrl   = page.url();
    const landedTitle = await page.title().catch(() => '');
    const stillLogin  = (await BA.hasMockLoginForm(page)) || (await BA.hasLoginForm(page));
    emitProgress(clientId, stillLogin ? 'warn' : 'success',
      `${stillLogin ? '⚠ Still on a login page after auth' : '✓ Logged in'} → ${landedUrl} ("${(landedTitle || '').slice(0, 50)}")`);
    if (stillLogin) emitProgress(clientId, 'warn', '   The crawl will only see the login page. Check the UIN/UEN/UUID, or set a Login route, then re-crawl.');
  } catch (e) {
    emitProgress(clientId, 'warn', `⚠ Auth step issue: ${e.message}`);
  }

  // BFS frontier — start with seedRoutes if provided, else just the current landing route
  const visited = new Map();      // route → { id, elementsCount, apisCount }
  const frontier = [];
  if (seedRoutes.length) {
    for (const r of seedRoutes) frontier.push({ route: r, depth: 0, from: null });
  } else {
    const landing = routeOf(page.url(), baseUrl) || '/';
    frontier.push({ route: landing, depth: 0, from: null });
  }
  const edges = []; // { from, to, text }

  let totalElements = 0, totalApis = 0;
  const deadline = startedAt + CRAWL_BUDGET_MS;

  while (frontier.length && visited.size < MAX_ROUTES) {
    if (Date.now() > deadline) { emitProgress(clientId, 'warn', `⏱ Crawl time budget reached — stopping at ${visited.size} routes`); break; }
    const { route, depth, from } = frontier.shift();
    if (visited.has(route)) {
      if (from) edges.push({ from, to: route });
      continue;
    }
    if (depth > MAX_DEPTH) continue;

    const { elements, apis, outgoing } = await crawlOneRoute(page, route, baseUrl, clientId, deadline);

    // Re-login if a click during discovery bounced us to the login page
    if (await BA.hasMockLoginForm(page) || await BA.hasLoginForm(page)) {
      await performLogin(page, identity, clientId);
    }

    const pageId = savePage({ route });
    clearPageChildren(pageId);   // refresh (avoid dup rows) when re-crawling an existing/guided page
    if (elements.length) saveElements(pageId, elements);
    if (apis.length)     saveApis(pageId, apis);

    visited.set(route, { id: pageId, elements: elements.length, apis: apis.length });
    if (from) edges.push({ from, to: route });
    totalElements += elements.length;
    totalApis     += apis.length;
    emitProgress(clientId, 'success', `  ✓ ${route} — ${elements.length} elements, ${apis.length} APIs`);

    for (const out of outgoing) {
      if (!visited.has(out.target)) {
        frontier.push({ route: out.target, depth: depth + 1, from: route });
      }
      edges.push({ from: route, to: out.target, text: out.text });
    }
  }

  // Build adjacency: upstream (who points to me) / downstream (where I point to)
  const upstream = new Map(), downstream = new Map(), transitions = new Map();
  for (const e of edges) {
    if (!e.to || !visited.has(e.to)) continue;
    if (e.from && visited.has(e.from)) {
      downstream.set(e.from, [...new Set([...(downstream.get(e.from) || []), e.to])]);
      upstream.set(e.to,    [...new Set([...(upstream.get(e.to)    || []), e.from])]);
      transitions.set(e.from, [...(transitions.get(e.from) || []), { text: e.text || 'navigate', target: e.to }]);
    }
  }
  for (const [route, info] of visited) {
    const up = upstream.get(route)   || [];
    const dn = downstream.get(route) || [];
    const ex = (transitions.get(route) || []).map(t => ({ trigger: t.text, target: t.target }));
    STMT.updatePageNeighbours.run(JSON.stringify(up), JSON.stringify(dn), JSON.stringify(ex), now(), info.id);
    // Also persist proper transitions rows so context assembler can read structured data
    saveTransitions(info.id, (transitions.get(route) || []).map(t => ({ trigger: t.text, target: t.target })));
  }

  // Per-role diff: re-crawl each route under each additional role and save overrides.
  // A role carries its own mock identity ({ uin, uen, uuid } — or user/pass fallback).
  for (const role of (config.roles || [])) {
    const roleIdentity = resolveIdentity(role);
    if (!role?.name || !(roleIdentity.uin || roleIdentity.username)) continue;
    emitProgress(clientId, 'progress', `👤 Crawling as role "${role.name}"`);
    try {
      // Fresh context per role so cookies/storage don't bleed
      try { await browser.contexts()[0].clearCookies(); } catch {}
      await page.goto(config.loginRoute || baseUrl, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
      await performLogin(page, roleIdentity, clientId);
      for (const [route, info] of visited) {
        try {
          await page.goto(fullUrl(route, baseUrl), { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
          await page.waitForTimeout(800);
          const els = await page.evaluate(COLLECT_ELEMENTS_FN);
          saveElements(info.id, els, role.name);
        } catch (e) {
          emitProgress(clientId, 'warn', `⚠ Role ${role.name} skipped ${route}: ${e.message}`);
        }
      }
    } catch (e) {
      emitProgress(clientId, 'warn', `⚠ Role ${role.name} crawl failed: ${e.message}`);
    }
  }

  try { await browser.close(); } catch {}

  const duration_ms = Date.now() - startedAt;
  STMT.upsertMeta.run(visited.size, totalElements, totalApis, duration_ms, now(),
    JSON.stringify({ baseUrl, seedRoutes, roles: (config.roles || []).map(r => r.name) }));

  const summary = {
    total_routes: visited.size,
    total_elements: totalElements,
    total_apis: totalApis,
    duration_ms,
    crawled_at: now(),
  };
  emit(clientId, 'twin_done', summary);
  emitProgress(clientId, 'success', `✓ Crawl complete — ${visited.size} routes · ${totalElements} elements · ${totalApis} APIs (${(duration_ms/1000).toFixed(1)}s)`);
  return summary;
}

// Recompute twin_meta totals from the live (non-deleted) rows. Used after a guided
// recording so the Status strip reflects the full store, not just this session.
function refreshMetaTotals(duration_ms = 0) {
  const c = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
  const routes   = c(`SELECT COUNT(*) n FROM twin_pages         WHERE deleted_at IS NULL`);
  const elements = c(`SELECT COUNT(*) n FROM twin_elements      WHERE deleted_at IS NULL`);
  const apis     = c(`SELECT COUNT(*) n FROM twin_api_contracts WHERE deleted_at IS NULL`);
  const cfgRow = db.prepare(`SELECT config FROM twin_meta WHERE id=1`).get();
  STMT.upsertMeta.run(routes, elements, apis, duration_ms, now(), cfgRow?.config || '{}');
  return { total_routes: routes, total_elements: elements, total_apis: apis };
}

// ── Public: GUIDED "record a module" crawl ───────────────────────────────────
/**
 * Launches a headed browser, logs in, then lets the USER manually navigate the
 * module from start to end. Every distinct route the user lands on is captured
 * (elements + APIs) and tagged with the module name. Runs until shouldStop() or
 * the user closes the browser. Additive — does NOT wipe the existing twin.
 *
 * @param {object}   config        — baseUrl, identity, loginRoute, startRoute, moduleName, clientId
 * @param {function} shouldStop    — () => boolean; true when the user clicks Stop
 */
async function runGuidedCrawl(config, shouldStop = () => false) {
  const startedAt = Date.now();
  const clientId  = config.clientId || 'anon';
  const baseUrl   = (config.baseUrl || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
  if (!baseUrl) throw new Error('baseUrl required (or set APP_BASE_URL in .env)');
  const moduleName = (config.moduleName || '').trim() || 'Module';
  const identity   = resolveIdentity(config);

  emit(clientId, 'twin_start', { baseUrl, mode: 'guided', module: moduleName });
  emitProgress(clientId, 'start', `🎥 Recording module "${moduleName}" — ${baseUrl}`);

  const { browser, page } = await BA.launchBrowser();

  // API capture bucketed by whichever route is active when the request fires
  const apisByRoute = new Map();   // route → [{method,endpoint,status,errorCodes}]
  const reqMap = new Map();
  const onReq = (req) => {
    const rt = req.resourceType();
    if (rt !== 'fetch' && rt !== 'xhr') return;
    let u; try { u = new URL(req.url()); } catch { return; }
    try { if (u.origin !== new URL(baseUrl).origin) return; } catch {}
    reqMap.set(req, { method: req.method(), endpoint: u.pathname + (u.search || ''), route: routeOf(page.url(), baseUrl) });
  };
  const onRes = (res) => {
    const entry = reqMap.get(res.request());
    if (!entry || !entry.route) return;
    const status = res.status();
    if (!apisByRoute.has(entry.route)) apisByRoute.set(entry.route, []);
    apisByRoute.get(entry.route).push({
      method: entry.method, endpoint: entry.endpoint,
      status: status >= 200 && status < 400 ? status : null,
      errorCodes: status >= 400 ? [status] : [],
    });
  };
  page.on('request', onReq);
  page.on('response', onRes);

  let pageClosed = false;
  page.on('close', () => { pageClosed = true; });

  // Login, then move to the start of the module
  try {
    await page.goto(config.loginRoute || baseUrl, { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await performLogin(page, identity, clientId);
    if (config.startRoute) {
      await page.goto(fullUrl(routeOf(config.startRoute, baseUrl) || config.startRoute, baseUrl),
        { waitUntil: 'domcontentloaded', timeout: PER_PAGE_TIMEOUT }).catch(() => {});
    }
  } catch (e) {
    emitProgress(clientId, 'warn', `⚠ Auth/start issue: ${e.message}`);
  }

  emitProgress(clientId, 'progress', '👉 Navigate the module from start to end in the opened browser. Click "Stop Recording" (or close the browser) when done.');

  const capturedOrder = [];          // ordered list of routes as the user walks them
  const capturedSet = new Set();
  const flowSteps = [];              // ordered step descriptors for the App Flow Map
  let totalElements = 0;

  // Capture the route the user is currently on (de-dupes; re-captures merge APIs)
  const captureCurrent = async () => {
    let route; try { route = routeOf(page.url(), baseUrl); } catch { return; }
    if (!route || capturedSet.has(route)) return;
    capturedSet.add(route);
    await page.waitForTimeout(API_OBSERVE_MS).catch(() => {});
    let elements = [];
    try { elements = await page.evaluate(COLLECT_ELEMENTS_FN); } catch {}
    const title = await page.title().catch(() => '');
    const pageId = savePage({ route, name: title || route, module: moduleName, source: 'guided' });
    clearPageChildren(pageId);   // refresh on re-record instead of duplicating
    if (elements.length) { saveElements(pageId, elements); totalElements += elements.length; }
    const apis = apisByRoute.get(route) || [];
    if (apis.length) {
      // de-dupe by method+endpoint
      const byKey = new Map();
      for (const a of apis) { const k = `${a.method} ${a.endpoint}`; if (!byKey.has(k)) byKey.set(k, a); }
      saveApis(pageId, [...byKey.values()]);
    }
    capturedOrder.push(route);
    // Build an App Flow step from this page. Title = page title or the last path segment.
    const seg = route.split('?')[0].split('/').filter(Boolean).pop() || route;
    const stepTitle = (title && title.trim()) ? title.trim().slice(0, 40) : seg;
    flowSteps.push({
      title: stepTitle,
      description: `Visited ${route} — ${elements.length} element(s), ${apis.length} API call(s)`,
      rule: null,
      tc_count: 0,
    });
    emitProgress(clientId, 'success', `   ● captured ${route} — ${elements.length} elements · ${apis.length} API call(s)`);
    emit(clientId, 'twin_guided_page', { route, module: moduleName, count: capturedOrder.length });
  };

  // Capture initial landing, then poll for navigations until stop / close
  let lastSeen = null, stableSince = 0;
  while (!shouldStop() && !pageClosed) {
    let route = null; try { route = routeOf(page.url(), baseUrl); } catch {}
    const t = Date.now();
    if (route !== lastSeen) { lastSeen = route; stableSince = t; }
    // Capture once a route has been stable ~1.5s (lets the SPA finish rendering)
    else if (route && !capturedSet.has(route) && t - stableSince > 1500) {
      await captureCurrent();
    }
    await page.waitForTimeout(700).catch(() => {});
  }

  // Wire transitions in the order the user walked them (a→b→c) so flow is preserved
  for (let i = 0; i < capturedOrder.length - 1; i++) {
    const fromId = STMT.findPageByRoute.get(capturedOrder[i])?.id;
    if (fromId) saveTransitions(fromId, [{ trigger: 'user navigation', target: capturedOrder[i + 1] }]);
  }
  // Persist upstream/downstream neighbours along the recorded path
  for (let i = 0; i < capturedOrder.length; i++) {
    const row = STMT.findPageByRoute.get(capturedOrder[i]);
    if (!row) continue;
    const up = i > 0 ? [capturedOrder[i - 1]] : [];
    const dn = i < capturedOrder.length - 1 ? [capturedOrder[i + 1]] : [];
    STMT.updatePageNeighbours.run(JSON.stringify(up), JSON.stringify(dn), '[]', now(), row.id);
  }

  page.off('request', onReq);
  page.off('response', onRes);
  try { await browser.close(); } catch {}

  // Auto-create an App Flow Map entry for the recorded module so the walked path
  // shows up in the Flow Map tab (same store the Figma/manual flows use).
  let flowId = null;
  if (flowSteps.length && config.clientId && config.clientId !== 'webhook') {
    try {
      // Replace any prior recording of THIS module (same client) so re-recording
      // refreshes the flow instead of piling up duplicates. Other flows are untouched.
      try {
        for (const f of getAppFlows(config.clientId)) {
          if (f.source === 'twin-recording' && (f.name === moduleName || f.module === moduleName)) {
            deleteAppFlow(f.id, config.clientId);
          }
        }
      } catch {}
      flowId = saveAppFlow({
        clientId:    config.clientId,
        name:        moduleName,
        module:      moduleName,
        description: `Recorded from ${baseUrl} — ${flowSteps.length} step(s) captured live`,
        steps:       flowSteps,
        source:      'twin-recording',
      });
      emitProgress(clientId, 'success', `🗺️ Added "${moduleName}" to App Flow Map (${flowSteps.length} step(s))`);
    } catch (e) {
      emitProgress(clientId, 'warn', `⚠ Could not add to App Flow Map: ${e.message}`);
    }
  }

  const duration_ms = Date.now() - startedAt;
  const totals = refreshMetaTotals(duration_ms);
  const summary = {
    ...totals,
    module: moduleName,
    module_routes: capturedOrder.length,
    flow_id: flowId,
    flow_added: !!flowId,
    duration_ms,
    crawled_at: now(),
  };
  emit(clientId, 'twin_done', summary);
  emitProgress(clientId, 'success', `✓ Module "${moduleName}" recorded — ${capturedOrder.length} page(s) · ${totalElements} elements (${(duration_ms/1000).toFixed(1)}s)`);
  return summary;
}

module.exports = { runCrawl, runGuidedCrawl, softDeleteAllTwinRows };
