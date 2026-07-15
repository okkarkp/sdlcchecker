/**
 * lib/db.js — SQLite persistence layer for Test Alchemist
 * Uses better-sqlite3 (synchronous API — no async overhead).
 * Initialised once on require(); safe to require from multiple modules.
 */
'use strict';

const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Database file location ────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH  = path.join(DATA_DIR, 'alchemist.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');   // better concurrent-read performance
db.pragma('foreign_keys = ON');
db.pragma('wal_autocheckpoint = 1');   // checkpoint after every page write — ensures data hits disk immediately
db.pragma('synchronous = FULL');       // ensure writes are durable even on force-kill

// Force a checkpoint on startup to merge any leftover WAL from a crash
db.pragma('wal_checkpoint(TRUNCATE)');

// Also checkpoint every 5 minutes while the server is running
setInterval(() => {
  try { db.pragma('wal_checkpoint(PASSIVE)'); } catch (_) {}
}, 5 * 60 * 1000);

// Graceful shutdown: checkpoint WAL so no data is lost on stop
function closeDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch (_) {}
}
process.on('SIGINT',  closeDb);
process.on('SIGTERM', closeDb);
process.on('exit',    closeDb);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS generation (
    id               TEXT PRIMARY KEY,
    client_id        TEXT NOT NULL,
    title            TEXT NOT NULL,
    source_type      TEXT NOT NULL DEFAULT 'text',
    source_ref       TEXT,
    app_name         TEXT,
    module           TEXT,
    requirement_text TEXT,
    scenario_count   INTEGER DEFAULT 0,
    tc_count         INTEGER DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scenario (
    id                  TEXT PRIMARY KEY,
    generation_id       TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    client_id           TEXT NOT NULL,
    sc_id               TEXT,
    title               TEXT NOT NULL,
    module              TEXT,
    description         TEXT,
    type                TEXT,
    priority            TEXT,
    tags                TEXT DEFAULT '[]',
    acceptance_criteria TEXT DEFAULT '[]',
    status              TEXT DEFAULT 'active',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS test_case (
    id               TEXT PRIMARY KEY,
    generation_id    TEXT NOT NULL REFERENCES generation(id) ON DELETE CASCADE,
    scenario_id      TEXT REFERENCES scenario(id),
    client_id        TEXT NOT NULL,
    tc_id            TEXT,
    title            TEXT NOT NULL,
    module           TEXT,
    priority         TEXT,
    type             TEXT,
    preconditions    TEXT DEFAULT '[]',
    steps            TEXT DEFAULT '[]',
    expected_result  TEXT,
    labels           TEXT DEFAULT '[]',
    automation_notes TEXT,
    status           TEXT DEFAULT 'not_executed',
    jira_key         TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_message (
    id         TEXT PRIMARY KEY,
    client_id  TEXT NOT NULL,
    item_type  TEXT NOT NULL,
    item_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    content    TEXT NOT NULL,
    diff_json  TEXT,
    applied    INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS knowledge_entry (
    id               TEXT PRIMARY KEY,
    client_id        TEXT NOT NULL,
    kind             TEXT NOT NULL DEFAULT 'preference',
    module           TEXT,
    trigger_text     TEXT,
    guidance         TEXT NOT NULL,
    source_item_id   TEXT,
    source_item_type TEXT,
    weight           REAL DEFAULT 1.0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playwright_script (
    id         TEXT PRIMARY KEY,
    tc_id      TEXT,
    tc_title   TEXT NOT NULL,
    module     TEXT DEFAULT '',
    script     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_gen_client   ON generation(client_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_scen_gen     ON scenario(generation_id);
  CREATE INDEX IF NOT EXISTS idx_tc_gen       ON test_case(generation_id);
  CREATE INDEX IF NOT EXISTS idx_chat_item    ON chat_message(item_type, item_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_know_module  ON knowledge_entry(client_id, module);
  CREATE INDEX IF NOT EXISTS idx_know_client  ON knowledge_entry(client_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_pw_script    ON playwright_script(created_at DESC);
`);

// Migration: add jira_test_key and execution_key columns to playwright_script
try {
  db.exec(`ALTER TABLE playwright_script ADD COLUMN jira_test_key TEXT DEFAULT ''`);
} catch (_) {} // column already exists
try {
  db.exec(`ALTER TABLE playwright_script ADD COLUMN execution_key TEXT DEFAULT ''`);
} catch (_) {} // column already exists

// ── Digital Twin: structured, queryable model of the target application ────────
db.exec(`
  CREATE TABLE IF NOT EXISTS twin_pages (
    id                TEXT PRIMARY KEY,
    route             TEXT NOT NULL,
    page_name         TEXT,
    module            TEXT DEFAULT '',
    entry_conditions  TEXT DEFAULT '[]',
    exit_transitions  TEXT DEFAULT '[]',
    upstream_pages    TEXT DEFAULT '[]',
    downstream_pages  TEXT DEFAULT '[]',
    crawled_at        TEXT,
    source            TEXT DEFAULT 'crawler',
    deleted_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_elements (
    id                  TEXT PRIMARY KEY,
    page_id             TEXT NOT NULL REFERENCES twin_pages(id) ON DELETE CASCADE,
    element_id          TEXT,
    tag                 TEXT,
    role                TEXT,
    label               TEXT,
    type                TEXT,
    required            INTEGER DEFAULT 0,
    disabled_by_default INTEGER DEFAULT 0,
    enabled_when        TEXT,
    placeholder         TEXT,
    test_id             TEXT,
    locator_strategy    TEXT,
    deleted_at          TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_rules (
    id               TEXT PRIMARY KEY,
    page_id          TEXT REFERENCES twin_pages(id) ON DELETE CASCADE,
    rule_text        TEXT NOT NULL,
    applies_to       TEXT,
    condition        TEXT,
    expected_outcome TEXT,
    source           TEXT DEFAULT 'manual',
    requirement_ids  TEXT DEFAULT '[]',
    deleted_at       TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_transitions (
    id              TEXT PRIMARY KEY,
    page_id         TEXT REFERENCES twin_pages(id) ON DELETE CASCADE,
    trigger_action  TEXT,
    target_route    TEXT,
    guard_condition TEXT,
    effect          TEXT,
    deleted_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_api_contracts (
    id              TEXT PRIMARY KEY,
    page_id         TEXT REFERENCES twin_pages(id) ON DELETE CASCADE,
    method          TEXT,
    endpoint        TEXT,
    request_schema  TEXT,
    success_status  INTEGER,
    error_codes     TEXT DEFAULT '[]',
    response_schema TEXT,
    deleted_at      TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_roles (
    id                TEXT PRIMARY KEY,
    page_id           TEXT REFERENCES twin_pages(id) ON DELETE CASCADE,
    role_name         TEXT NOT NULL,
    access_level      TEXT DEFAULT 'full',
    element_overrides TEXT DEFAULT '[]',
    deleted_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_requirements (
    id             TEXT PRIMARY KEY,
    page_id        TEXT REFERENCES twin_pages(id) ON DELETE CASCADE,
    requirement_id TEXT NOT NULL,
    title          TEXT,
    source_url     TEXT,
    linked_at      TEXT,
    deleted_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS twin_meta (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    total_routes   INTEGER DEFAULT 0,
    total_elements INTEGER DEFAULT 0,
    total_apis     INTEGER DEFAULT 0,
    duration_ms    INTEGER DEFAULT 0,
    crawled_at     TEXT,
    config         TEXT DEFAULT '{}'
  );

  CREATE INDEX IF NOT EXISTS idx_twin_pages_route ON twin_pages(route);
  CREATE INDEX IF NOT EXISTS idx_twin_elements_page ON twin_elements(page_id);
  CREATE INDEX IF NOT EXISTS idx_twin_rules_page ON twin_rules(page_id);
  CREATE INDEX IF NOT EXISTS idx_twin_transitions_page ON twin_transitions(page_id);
  CREATE INDEX IF NOT EXISTS idx_twin_api_page ON twin_api_contracts(page_id);
  CREATE INDEX IF NOT EXISTS idx_twin_roles_page ON twin_roles(page_id, role_name);
  CREATE INDEX IF NOT EXISTS idx_twin_reqs_page ON twin_requirements(page_id);
`);

// App flow map storage
db.exec(`
  CREATE TABLE IF NOT EXISTS app_flow (
    id          TEXT PRIMARY KEY,
    client_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    module      TEXT,
    description TEXT,
    steps       TEXT DEFAULT '[]',
    source      TEXT DEFAULT 'manual',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  )
`);

// ── Migrations ────────────────────────────────────────────────────────────────
// Add status and use_count columns to knowledge_entry if they don't exist yet
try { db.exec("ALTER TABLE knowledge_entry ADD COLUMN status TEXT DEFAULT 'approved'"); } catch(_) {}
try { db.exec("ALTER TABLE knowledge_entry ADD COLUMN use_count INTEGER DEFAULT 0"); } catch(_) {}
try { db.exec("ALTER TABLE knowledge_entry ADD COLUMN html_content TEXT"); } catch(_) {}
// Digital Twin: module column on twin_pages (guided "record a module" crawls)
try { db.exec("ALTER TABLE twin_pages ADD COLUMN module TEXT DEFAULT ''"); } catch(_) {}

console.log('[DB] SQLite ready →', DB_PATH);

// ── Helpers ───────────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();

function uid() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : require('crypto').randomUUID();
}

// ── Generation queries ────────────────────────────────────────────────────────

function saveGeneration({ clientId, title, sourceType = 'text', sourceRef, appName, module: mod, requirementText }) {
  const id = uid();
  const ts = now();
  db.prepare(`
    INSERT INTO generation(id,client_id,title,source_type,source_ref,app_name,module,requirement_text,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)
  `).run(id, clientId, title, sourceType, sourceRef || null, appName || null, mod || null, (requirementText || '').slice(0, 4000), ts, ts);
  return id;
}

// Increment tc_count by delta (safe for multiple runs on the same generation)
function incrementTcCount(id, delta) {
  db.prepare('UPDATE generation SET tc_count=tc_count+?,updated_at=? WHERE id=?')
    .run(delta, now(), id);
}

function updateGenerationCounts(id, scenarioCount, tcCount) {
  if (scenarioCount !== undefined && tcCount !== undefined) {
    db.prepare('UPDATE generation SET scenario_count=?,tc_count=?,updated_at=? WHERE id=?')
      .run(scenarioCount, tcCount, now(), id);
  } else if (scenarioCount !== undefined) {
    db.prepare('UPDATE generation SET scenario_count=?,updated_at=? WHERE id=?')
      .run(scenarioCount, now(), id);
  } else if (tcCount !== undefined) {
    db.prepare('UPDATE generation SET tc_count=?,updated_at=? WHERE id=?')
      .run(tcCount, now(), id);
  }
}

function listGenerations(clientId) {
  // Use live sub-counts so badges stay accurate after items are deleted/archived
  return db.prepare(`
    SELECT g.id, g.title, g.source_type, g.source_ref, g.app_name, g.module, g.created_at,
      (SELECT COUNT(*) FROM scenario  s WHERE s.generation_id = g.id AND s.status != 'archived') AS scenario_count,
      (SELECT COUNT(*) FROM test_case t WHERE t.generation_id = g.id AND t.status != 'archived') AS tc_count
    FROM generation g
    WHERE g.client_id = ?
    ORDER BY g.created_at DESC LIMIT 50
  `).all(clientId);
}

function getGeneration(id, clientId) {
  return db.prepare('SELECT * FROM generation WHERE id=? AND client_id=?').get(id, clientId);
}

function deleteGeneration(id, clientId) {
  db.prepare('DELETE FROM generation WHERE id=? AND client_id=?').run(id, clientId);
}

// ── Scenario queries ──────────────────────────────────────────────────────────

function saveScenarios(generationId, clientId, scenarios) {
  const insert = db.prepare(`
    INSERT INTO scenario(id,generation_id,client_id,sc_id,title,module,description,type,priority,tags,acceptance_criteria,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const ts = now();
  const ids = [];
  const batch = db.transaction((scenarios) => {
    for (const s of scenarios) {
      const id = uid();
      insert.run(
        id, generationId, clientId,
        s.id || null, s.title || 'Untitled',
        s.module || null, s.description || null,
        s.type || null, s.priority || null,
        JSON.stringify(s.tags || []),
        JSON.stringify(s.acceptance_criteria || []),
        ts, ts
      );
      ids.push(id);
    }
  });
  batch(scenarios);
  return ids;
}

function getScenariosForGeneration(generationId) {
  return db.prepare("SELECT * FROM scenario WHERE generation_id=? AND status != 'archived' ORDER BY sc_id").all(generationId);
}

function updateScenario(id, clientId, fields) {
  const allowed = ['title','module','description','type','priority','tags','acceptance_criteria','status'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k}=?`);
      vals.push(Array.isArray(fields[k]) ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at=?'); vals.push(now());
  vals.push(id); vals.push(clientId);
  db.prepare(`UPDATE scenario SET ${sets.join(',')} WHERE id=? AND client_id=?`).run(...vals);
}

// ── Test Case queries ─────────────────────────────────────────────────────────

function saveTestCases(generationId, clientId, testcases, scenarioMap = {}) {
  const insert = db.prepare(`
    INSERT INTO test_case(id,generation_id,scenario_id,client_id,tc_id,title,module,priority,type,preconditions,steps,expected_result,labels,automation_notes,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const ts = now();
  const batch = db.transaction((testcases) => {
    for (const tc of testcases) {
      const id = uid();
      const scenarioId = tc.scenario_id ? (scenarioMap[tc.scenario_id] || null) : null;
      insert.run(
        id, generationId, scenarioId, clientId,
        tc.id || null, tc.title || 'Untitled',
        tc.module || null, tc.priority || null, tc.type || null,
        JSON.stringify(tc.preconditions || []),
        JSON.stringify(tc.steps || []),
        tc.expected_result || null,
        JSON.stringify(tc.labels || []),
        tc.automation_notes || null,
        ts, ts
      );
    }
  });
  batch(testcases);
}

function getTestCasesForGeneration(generationId) {
  return db.prepare(`
    SELECT tc.*, s.sc_id AS parent_sc_id
    FROM test_case tc
    LEFT JOIN scenario s
      ON s.id = tc.scenario_id AND tc.scenario_id IS NOT NULL AND tc.scenario_id != 'null'
    WHERE tc.generation_id = ? AND tc.status != 'archived'
    ORDER BY tc.tc_id
  `).all(generationId);
}

function getTestCase(id, clientId) {
  return db.prepare('SELECT * FROM test_case WHERE id=? AND client_id=?').get(id, clientId);
}

function updateTestCase(id, clientId, fields) {
  const allowed = ['title','module','priority','type','preconditions','steps','expected_result','labels','automation_notes','status','jira_key'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k}=?`);
      vals.push(Array.isArray(fields[k]) ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at=?'); vals.push(now());
  vals.push(id); vals.push(clientId);
  db.prepare(`UPDATE test_case SET ${sets.join(',')} WHERE id=? AND client_id=?`).run(...vals);
}

// ── Chat queries ──────────────────────────────────────────────────────────────

function saveChatMessage({ clientId, itemType, itemId, role, content, diffJson = null }) {
  const id = uid();
  db.prepare(`
    INSERT INTO chat_message(id,client_id,item_type,item_id,role,content,diff_json,created_at)
    VALUES(?,?,?,?,?,?,?,?)
  `).run(id, clientId, itemType, itemId, role, content, diffJson ? JSON.stringify(diffJson) : null, now());
  return id;
}

function getChatHistory(itemType, itemId, clientId) {
  return db.prepare(`
    SELECT id,role,content,diff_json,applied,created_at
    FROM chat_message WHERE item_type=? AND item_id=? AND client_id=?
    ORDER BY created_at
  `).all(itemType, itemId, clientId);
}

function markChatApplied(messageId, clientId) {
  db.prepare('UPDATE chat_message SET applied=1 WHERE id=? AND client_id=?').run(messageId, clientId);
}

function clearChatHistory(itemType, itemId, clientId) {
  db.prepare('DELETE FROM chat_message WHERE item_type=? AND item_id=? AND client_id=?').run(itemType, itemId, clientId);
}

// ── Knowledge queries ─────────────────────────────────────────────────────────

function saveKnowledgeEntry({ clientId, kind = 'preference', module: mod, triggerText, guidance, sourceItemId, sourceItemType, htmlContent }) {
  const id = uid();
  const ts = now();
  db.prepare(`
    INSERT INTO knowledge_entry(id,client_id,kind,module,trigger_text,guidance,source_item_id,source_item_type,weight,html_content,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, clientId, kind, mod || null, triggerText || null, guidance, sourceItemId || null, sourceItemType || null, 1.0, htmlContent || null, ts, ts);
  return id;
}

function listKnowledge(clientId, mod = null) {
  if (mod) {
    return db.prepare(`
      SELECT * FROM knowledge_entry WHERE client_id=? AND (module=? OR module IS NULL)
      ORDER BY weight DESC, created_at DESC
    `).all(clientId, mod);
  }
  return db.prepare(`
    SELECT * FROM knowledge_entry WHERE client_id=? ORDER BY module, weight DESC, created_at DESC
  `).all(clientId);
}

function getRelevantKnowledge(clientId, mod, keywords = [], limit = 8) {
  // Simple relevance: module match + keyword overlap in guidance text
  const candidates = db.prepare(`
    SELECT * FROM knowledge_entry WHERE client_id=? AND (module=? OR module IS NULL)
    ORDER BY weight DESC, created_at DESC LIMIT 20
  `).all(clientId, mod || 'NULL_NEVER_MATCH');

  if (!candidates.length && mod) {
    // Fallback: no-module entries
    return db.prepare(`
      SELECT * FROM knowledge_entry WHERE client_id=? AND module IS NULL
      ORDER BY weight DESC, created_at DESC LIMIT ${limit}
    `).all(clientId);
  }

  if (!keywords.length) return candidates.slice(0, limit);

  // Score by keyword hits
  const kw = keywords.map(w => w.toLowerCase());
  const scored = candidates.map(e => {
    const text = (e.guidance + ' ' + (e.trigger_text || '')).toLowerCase();
    const score = kw.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
    return { ...e, _score: score + e.weight };
  });
  return scored.sort((a, b) => b._score - a._score).slice(0, limit);
}

function updateKnowledge(id, clientId, fields) {
  const allowed = ['kind','module','trigger_text','guidance','weight','status'];
  const sets = [];
  const vals = [];
  for (const k of allowed) {
    if (k in fields) { sets.push(`${k}=?`); vals.push(fields[k]); }
  }
  if (!sets.length) return;
  sets.push('updated_at=?'); vals.push(now());
  vals.push(id); vals.push(clientId);
  db.prepare(`UPDATE knowledge_entry SET ${sets.join(',')} WHERE id=? AND client_id=?`).run(...vals);
}

function getKnowledgeStats(clientId) {
  const total   = db.prepare("SELECT COUNT(*) as n FROM knowledge_entry WHERE client_id=?").get(clientId)?.n || 0;
  const pending = db.prepare("SELECT COUNT(*) as n FROM knowledge_entry WHERE client_id=? AND status != 'approved'").get(clientId)?.n || 0;
  const mods    = db.prepare("SELECT COUNT(DISTINCT module) as n FROM knowledge_entry WHERE client_id=? AND module IS NOT NULL").get(clientId)?.n || 0;
  const uses    = db.prepare("SELECT SUM(use_count) as n FROM knowledge_entry WHERE client_id=?").get(clientId)?.n || 0;
  return { total, pending, moduleCount: mods, useCount: uses || 0 };
}

function bumpUseCount(id, clientId) {
  db.prepare("UPDATE knowledge_entry SET use_count=COALESCE(use_count,0)+1,updated_at=? WHERE id=? AND client_id=?")
    .run(now(), id, clientId);
}

function deleteKnowledge(id, clientId) {
  db.prepare('DELETE FROM knowledge_entry WHERE id=? AND client_id=?').run(id, clientId);
}

function bumpKnowledgeWeight(id, clientId, delta = 0.5) {
  db.prepare('UPDATE knowledge_entry SET weight=MIN(weight+?,10.0),updated_at=? WHERE id=? AND client_id=?')
    .run(delta, now(), id, clientId);
}

// ── JSON parse helpers (for rows coming out of DB) ────────────────────────────
function parseRow(row) {
  if (!row) return null;
  const jsonCols = ['tags','acceptance_criteria','preconditions','steps','labels'];
  const out = { ...row };
  for (const col of jsonCols) {
    if (typeof out[col] === 'string') {
      try { out[col] = JSON.parse(out[col]); } catch { out[col] = []; }
    }
  }
  if (typeof out.diff_json === 'string') {
    try { out.diff_json = JSON.parse(out.diff_json); } catch { out.diff_json = null; }
  }
  return out;
}

function parseRows(rows) { return rows.map(parseRow); }

// ── Playwright Script Library queries ────────────────────────────────────────
// Global — no client_id, visible across all sessions

function listPwScripts() {
  return db.prepare('SELECT id,tc_id,tc_title,module,jira_test_key,execution_key,created_at,updated_at FROM playwright_script ORDER BY created_at DESC').all();
}

function getPwScript(id) {
  return db.prepare('SELECT * FROM playwright_script WHERE id=?').get(id);
}

function savePwScript({ id, tcId, tcTitle, module: mod, script, jiraTestKey, executionKey }) {
  const ts = now();
  const rowId = id || uid();
  db.prepare(`
    INSERT INTO playwright_script(id,tc_id,tc_title,module,script,jira_test_key,execution_key,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)
  `).run(rowId, tcId || null, tcTitle, mod || '', script, jiraTestKey || '', executionKey || '', ts, ts);
  return rowId;
}

function updatePwScript(id, script) {
  db.prepare('UPDATE playwright_script SET script=?,updated_at=? WHERE id=?').run(script, now(), id);
}

function deletePwScript(id) {
  db.prepare('DELETE FROM playwright_script WHERE id=?').run(id);
}

// ── App Flow queries ──────────────────────────────────────────────────────────

function saveAppFlow({ clientId, name, module: mod, description, steps = [], source = 'manual' }) {
  const id = uid();
  const ts = now();
  db.prepare(`INSERT INTO app_flow(id,client_id,name,module,description,steps,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, clientId, name, mod || null, description || null, JSON.stringify(steps), source, ts, ts);
  return id;
}

function getAppFlows(clientId) {
  return db.prepare("SELECT * FROM app_flow WHERE client_id=? ORDER BY created_at DESC").all(clientId)
    .map(r => ({ ...r, steps: JSON.parse(r.steps || '[]') }));
}

function getAppFlow(id, clientId) {
  const r = db.prepare("SELECT * FROM app_flow WHERE id=? AND client_id=?").get(id, clientId);
  return r ? { ...r, steps: JSON.parse(r.steps || '[]') } : null;
}

function updateAppFlow(id, clientId, fields) {
  const allowed = ['name','module','description','steps','source'];
  const sets = []; const vals = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k}=?`);
      vals.push(k === 'steps' ? JSON.stringify(fields[k]) : fields[k]);
    }
  }
  if (!sets.length) return;
  sets.push('updated_at=?'); vals.push(now());
  vals.push(id); vals.push(clientId);
  db.prepare(`UPDATE app_flow SET ${sets.join(',')} WHERE id=? AND client_id=?`).run(...vals);
}

function deleteAppFlow(id, clientId) {
  db.prepare('DELETE FROM app_flow WHERE id=? AND client_id=?').run(id, clientId);
}

// ── Bulk archive test cases for a generation (preserves generation + scenarios)
function archiveTestCasesForGeneration(generationId, clientId) {
  db.prepare("UPDATE test_case SET status='archived', updated_at=? WHERE generation_id=? AND client_id=? AND status != 'archived'")
    .run(now(), generationId, clientId);
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = {
  db,
  // generation
  saveGeneration, updateGenerationCounts, incrementTcCount, listGenerations, getGeneration, deleteGeneration,
  // scenarios
  saveScenarios, getScenariosForGeneration, updateScenario,
  // test cases
  saveTestCases, getTestCasesForGeneration, getTestCase, updateTestCase, archiveTestCasesForGeneration,
  // chat
  saveChatMessage, getChatHistory, markChatApplied, clearChatHistory,
  // knowledge
  saveKnowledgeEntry, listKnowledge, getRelevantKnowledge,
  updateKnowledge, deleteKnowledge, bumpKnowledgeWeight,
  getKnowledgeStats, bumpUseCount,
  // playwright script library
  listPwScripts, getPwScript, savePwScript, updatePwScript, deletePwScript,
  // app flow map
  saveAppFlow, getAppFlows, getAppFlow, updateAppFlow, deleteAppFlow,
  // helpers
  parseRow, parseRows, uid, now,
};
