/**
 * lib/browser-agent.js  —  Agentic Browser Agent (provider-agnostic)
 *
 * A browser-use-style observe→plan→act loop driven by the AI provider selected in
 * the header (Copilot / OpenAI / Gemini / Claude API) — NOT a hardcoded Claude CLI.
 *
 * Each turn:
 *   1. Observe   — capture URL, title and a SHADOW-DOM-AWARE indexed list of visible
 *                  interactive elements WITH their current state (value/disabled/checked),
 *                  tagged data-agent-idx. Piercing shadow roots is essential for the
 *                  Angular-MFE login / SingPass-CorpPass mock forms.
 *   2. Plan      — send observation + task + history to callAI; it returns a BATCH of
 *                  actions (e.g. fill all fields + click submit) as strict JSON.
 *   3. Act       — execute the batch in sequence (indices re-tagged shadow-aware before
 *                  each), stopping early when the page navigates, then re-observe.
 *                  Multiple actions per LLM call = far fewer round-trips.
 *   4. Repeat    — until the model sets done:true, or max turns / stop.
 *
 * Deterministic fast-paths (username/password auto-login, SP/CP mock UIN/UEN fill, and
 * UUID-field fill) run before the model each turn, so basic login never burns LLM turns.
 *
 * The browser is launched headed in-process via the local Playwright library, so it
 * opens visibly on the machine running the server.
 */
'use strict';

const path = require('path');
const fs     = require('fs');
const os     = require('os');
const crypto = require('crypto');
const { callAI } = require('../providers');
const repoCtx = require('./repo-context');

const APP_ROOT    = path.join(__dirname, '..');
const PW_MODULE   = path.join(APP_ROOT, 'node_modules', 'playwright');
const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SCREENSHOT  = path.join(os.tmpdir(), 'browser-agent-screenshot.png');
const MAX_TURNS   = Number(process.env.AGENT_MAX_TURNS) || 30;
const MAX_ELEMENTS = 60;
// browser-use style: the model returns a BATCH of actions per turn (e.g. fill all
// fields + click submit), executed in sequence until the page changes — slashing
// the number of LLM round-trips. Capped so a runaway plan can't act blindly forever.
const MAX_ACTIONS_PER_TURN = Number(process.env.AGENT_MAX_ACTIONS) || 8;

// browser-use-style visual highlighting in the LIVE headed browser: color-coded dashed
// boxes + index labels over every interactive element each turn, and a flash pulse on the
// element being clicked/filled. Set AGENT_HIGHLIGHT=0 to disable.
const SHOW_HIGHLIGHTS = !/^(0|false|off|no)$/i.test(process.env.AGENT_HIGHLIGHT || '');
const HL_COLORS = { button: '#FF6B6B', input: '#4ECDC4', select: '#45B7D1', a: '#96CEB4', textarea: '#FF8C42', default: '#DDA0DD' };

// UUID handling — a UUID field uses a configured value (TEST_UUID), or a freshly
// generated v4 when the test data asks to "generate". The AI never fabricates one.
const DEFAULT_UUID = 'b583026f-350c-4ecf-8950-73851b6f2ed0';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildUuids() {
  const env = (process.env.TEST_UUID || '').trim();
  // Explicit configured UUID wins; "generate"/empty → a fresh one; else the default.
  const fixed = UUID_RE.test(env) ? env
              : /^(generate|new|random)$/i.test(env) ? crypto.randomUUID()
              : DEFAULT_UUID;
  return { fixed, generated: crypto.randomUUID() };
}

// Substitute UUID placeholders / "generate UUID" directives in test data with a
// concrete value, so the agent types a valid UUID rather than guessing.
function applyUuid(text, u) {
  if (text == null) return text;
  return String(text)
    .replace(/\b(?:generate|create|new|random)\s+(?:a\s+)?(?:new\s+)?(?:uuid|guid)\b/gi, u.generated)
    .replace(/\{\{\s*uuid\s*\}\}|\$\{?\s*uuid\s*\}?|<\s*uuid\s*>|\[\s*uuid\s*\]/gi, u.fixed);
}

const AGENT_SYSTEM_PROMPT = `\
You are an autonomous web-browser agent (like browser-use). Each turn you get the current
page state (URL, title, and an indexed list of visible interactive elements WITH their current
values). You plan a SHORT BATCH of actions that make as much progress as possible, then you see
the updated page and plan again.

Respond with STRICT JSON only (no markdown, no prose) in this exact shape:
{
  "evaluation": "Did my PREVIOUS action work? Look at the new page state and judge: Success / Failure / Uncertain — and why. (empty on the first turn)",
  "memory": "1-2 sentences tracking overall progress: which step you're on, what's done, what's left",
  "thought": "what you see now and what you'll do next",
  "actions": [
    { "type": "fill",   "index": 4, "value": "S1234567A" },
    { "type": "fill",   "index": 6, "value": "201912345A" },
    { "type": "click",  "index": 8 }
  ],
  "done": false,            // true when the task is complete or truly blocked
  "success": true,          // when done: did the task meet its expected result?
  "summary": "what happened / why finished"   // when done
}

Action types: "navigate" (needs "url"), "click" (needs "index"), "fill" (needs "index"+"value"),
"press" ("index" optional + "value" = key e.g. "Enter"), "select" ("index"+"value"=option),
"scroll", "wait", "request_login".

BATCHING — this is how you stay fast:
- Put MULTIPLE actions in "actions" when they happen on the SAME page with no reload between them.
- A form (login / identity / search with several inputs): fill EVERY field, THEN the submit/login click — ALL in one "actions" array, in order. NEVER submit before all fields are filled.
- The batch STOPS automatically when the page navigates/reloads; you'll then re-plan on the new page. So it's safe to end a batch with the click that submits.
- Keep batches to what you can predict from the CURRENT element list (max ${MAX_ACTIONS_PER_TURN}). Don't guess indices for a page you haven't seen yet.

Rules:
- Use ONLY the data given in the task (steps, test data, credentials). NEVER invent usernames, passwords, UIN/UEN, or test values.
- For any UUID / GUID field, type EXACTLY the UUID value provided in the task.
- Reference elements ONLY by their [index] from the provided list. An input's current value is shown as value="…" — skip fields already correctly filled.
- Elements marked "*NEW*" appeared since your last action (URL unchanged) — they are usually the result of what you just did (a dropdown, autocomplete list, modal, error). Interact with them when relevant (e.g. pick the matching option after typing).
- SELF-EVALUATE every turn: judge whether your PREVIOUS action actually worked from the new state. If the page did NOT change as expected, the action FAILED — do NOT blindly repeat it. Try a different element/approach (e.g. the element wasn't the real target, scroll to it, or pick a sibling). If you've repeated the same action ~2× with no progress, you are stuck — change strategy.
- FOLLOW THE STEPS in order. Each step has an "expect:" — after performing it, verify the page reflects it; note pass/fail in "thought". If an expected result clearly does NOT match, set "done":true with "success":false and explain.
- LOGIN is application-specific — every project's login page is different. Drive login from THIS test case's login steps and Test Data; do NOT assume any particular login UI.
- LOGIN (standard USERNAME/PASSWORD page): if credentials are in the Test Data, a standard page is auto-filled & submitted by the system before your turn — do NOT act on it. If no credentials are available for a required login, use "request_login".
- LOGIN (identity / SSO / mock login, only if the app uses one and the Test Data has an identity value): prefer the MANUAL / "Password login" / identity-entry option where you TYPE the identity (e.g. NRIC/UIN/UEN). AVOID "Scan QR" / app / mobile / biometric options — those need a real device and cannot be automated. Fill the identity field(s) from the Test Data and submit in ONE batch. Never guess identity values; if none is provided, "request_login".
- "not authorised" / "access denied" / "restricted" / error / validation pages: FIRST check the step's expected result. If reaching that page IS the expected outcome (e.g. a NEGATIVE test), that's success — set "done":true,"success":true. Otherwise a previous step failed.
- When complete or truly blocked, set "done": true (with "success" and "summary"). Leave "actions" empty in that case.`;

// ── Launch a headed browser (real Chrome if present, else bundled Chromium) ─────
async function launchBrowser() {
  const { chromium } = require(PW_MODULE);
  const opts = { headless: false, args: ['--start-maximized'] };
  if (fs.existsSync(CHROME_PATH)) opts.executablePath = CHROME_PATH;
  const browser = await chromium.launch(opts);
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();
  page.setDefaultTimeout(20000);
  return { browser, page };
}

// Builds the in-page tagging script. SHADOW-AWARE: walks open shadow roots via deep()
// so Angular-MFE / web-component forms (login, SP/CP mock) are visible to the model —
// the old document.querySelectorAll version could not see them, which is why mock
// login "had no elements". Tags each element data-agent-idx and returns its STATE
// (current value / disabled / checked) so the model skips already-filled fields.
function buildCollectScript(max) {
  return `(() => {${DEEP_DOM_FNS}
    // browser-use-style interactivity: not just a fixed tag list. Catches clickable
    // <div>/<li>/custom components (cursor:pointer), ARIA roles, onclick, tabindex —
    // which is what SPA nav menus / cards / tiles actually are. Without this the model
    // sees no clickable nav and navigation stalls.
    const TAGS  = new Set(['a','button','input','select','textarea','summary','details','option']);
    const ROLES = new Set(['button','link','menuitem','menuitemcheckbox','menuitemradio','option','radio','checkbox','tab','textbox','combobox','switch','slider','spinbutton','searchbox','treeitem']);
    const cur = (el) => { try { return getComputedStyle(el).cursor; } catch(e){ return ''; } };
    const interactive = (el) => {
      const tag = el.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') return false;
      if (TAGS.has(tag)) return true;
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role && ROLES.has(role)) return true;
      if (el.hasAttribute('onclick') || el.hasAttribute('tabindex') || el.getAttribute('contenteditable') === 'true') return true;
      // cursor:pointer — but only the OUTERMOST pointer element in a chain, so we tag the
      // clickable container once instead of every nested icon/span inside it.
      if (cur(el) === 'pointer') {
        const p = el.parentElement;
        if (!p || cur(p) !== 'pointer') return true;
      }
      return false;
    };
    const out = []; let i = 0;
    for (const el of deep('*')) {
      if (i >= ${max}) break;
      if (el.classList && el.classList.contains('__agent_hl')) continue;   // skip our own highlight overlay
      if (!vis(el) || !interactive(el)) continue;
      const tag  = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      el.setAttribute('data-agent-idx', String(i));
      const label = (el.getAttribute('aria-label') || el.innerText || el.value ||
                     el.getAttribute('placeholder') || el.getAttribute('name') ||
                     el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
      const isField = tag === 'input' || tag === 'textarea' || tag === 'select';
      out.push({
        idx: i, tag, type,
        role: el.getAttribute('role') || '',
        label,
        value: isField ? String(el.value || '').slice(0, 40) : '',
        disabled: !!el.disabled,
        checked: (type === 'checkbox' || type === 'radio') ? !!el.checked : null,
      });
      i++;
    }
    return out;
  })()`;
}

// ── Observe: URL/title + shadow-aware indexed interactive elements (with state) ──
async function observe(page) {
  const url   = page.url();
  const title = await page.title().catch(() => '');
  let elements = [];
  try { elements = await page.evaluate(buildCollectScript(MAX_ELEMENTS)); } catch {}
  return { url, title, elements };
}

// Signature for diffing elements turn-to-turn (to mark newly-appeared ones).
const elemSig = (e) => `${e.tag}:${e.type}:${e.role}:${e.label}`;

function describeObservation(obs, prevSigs = null) {
  const lines = obs.elements.map(e => {
    const kind = e.tag === 'input' ? `input${e.type ? `:${e.type}` : ''}` : (e.role || e.tag);
    const state = [];
    if (e.value)   state.push(`value="${e.value}"`);
    if (e.checked === true) state.push('checked');
    if (e.disabled) state.push('disabled');
    // Mark elements that appeared since the previous observation (same page)
    const isNew = prevSigs && prevSigs.size && !prevSigs.has(elemSig(e));
    return `${isNew ? '*NEW* ' : ''}[${e.idx}] ${kind}${e.label ? ` "${e.label}"` : ''}${state.length ? ` (${state.join(', ')})` : ''}`;
  });
  return `URL: ${obs.url}\nTitle: ${obs.title}\nInteractive elements:\n${lines.join('\n') || '(none detected)'}`;
}

const sel = (i) => `[data-agent-idx="${i}"]`;

// Re-apply data-agent-idx (shadow-aware, same order as observe) right before an action,
// so SPA re-renders between planning and acting don't break index lookups.
async function retagElements(page) {
  await page.evaluate(buildCollectScript(MAX_ELEMENTS)).catch(() => {});
}

// Draw browser-use-style highlight boxes over every tagged element in the live browser:
// a color-coded dashed box (by tag/type) + an index label. Redrawn each turn so the user
// SEES exactly what the agent reads. Overlay is pointer-events:none so it never blocks clicks.
async function drawHighlights(page) {
  if (!SHOW_HIGHLIGHTS) return;
  try {
    await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const COLORS = ${JSON.stringify(HL_COLORS)};
      const LAYER = '__agent_hl_layer';
      document.getElementById(LAYER)?.remove();
      const layer = document.createElement('div');
      layer.id = LAYER; layer.className = '__agent_hl';
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none;margin:0;padding:0;';
      for (const el of deep('[data-agent-idx]')) {
        if (el.classList && el.classList.contains('__agent_hl')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        let color = COLORS[tag] || COLORS.default;
        if (tag === 'input' && (type === 'button' || type === 'submit')) color = COLORS.button;
        const box = document.createElement('div');
        box.className = '__agent_hl';
        box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px dashed '+color+';border-radius:3px;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;';
        const lbl = document.createElement('div');
        lbl.className = '__agent_hl'; lbl.textContent = el.getAttribute('data-agent-idx');
        lbl.style.cssText = 'position:fixed;left:'+r.left+'px;top:'+Math.max(0,r.top-15)+'px;background:'+color+';color:#fff;font:bold 11px/15px monospace;padding:0 4px;border-radius:3px;white-space:nowrap;';
        layer.appendChild(box); layer.appendChild(lbl);
      }
      document.documentElement.appendChild(layer);
    })()`).catch(() => {});
  } catch {}
}

// Flash a pulse on the element about to be acted on (red=click, teal=fill/type) so the
// user can follow the agent's actions visually. Briefly visible, then fades + removes.
async function flashElement(page, idx, kind = 'click') {
  if (!SHOW_HIGHLIGHTS || idx == null) return;
  const color = kind === 'fill' || kind === 'select' || kind === 'press' ? '#00C2A8' : '#FF3B30';
  try {
    await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const el = deep('[data-agent-idx="${String(idx).replace(/"/g, '')}"]')[0];
      if (!el) return;
      const r = el.getBoundingClientRect();
      const f = document.createElement('div');
      f.className = '__agent_hl';
      f.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;left:'+(r.left-3)+'px;top:'+(r.top-3)+'px;width:'+(r.width+6)+'px;height:'+(r.height+6)+'px;border:3px solid ${color};border-radius:4px;box-shadow:0 0 14px ${color};transition:opacity .5s ease;opacity:1;';
      document.documentElement.appendChild(f);
      setTimeout(() => { f.style.opacity = '0'; }, 320);
      setTimeout(() => { f.remove(); }, 900);
    })()`).catch(() => {});
    await page.waitForTimeout(220);
  } catch {}
}

const LOGIN_RE = /login|sign[\-_]?in|signin|auth|sso|logon|oauth|account/i;

// Flatten a test case's test_data (object or string) into readable lines.
// Optionally mask password-like values for display.
function formatTestData(td, { mask = false } = {}) {
  if (!td) return '';
  if (typeof td === 'string') return td.trim();
  if (typeof td !== 'object') return String(td);
  return Object.entries(td)
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${mask && /(?:^|_)(password|passwd|pwd|secret|token)$/i.test(k) ? '••••••' : v}`)
    .join('\n');
}

// Does the test case carry login data (explicit fields, the test_data object, or steps)?
function hasProvidedCredentials(testcase) {
  if (!testcase) return false;
  if (testcase.username || testcase.password || testcase.login) return true;
  const td = testcase.test_data;
  if (td && typeof td === 'object' && (td.username || td.password || td.login || td.uin || td.singpass_uin || td.pwd)) return true;
  const blob = (JSON.stringify(testcase.steps || []) + ' ' + JSON.stringify(td || '') + ' ' + (testcase.preconditions || []).join(' ')).toLowerCase();
  return /pass(word)?\s*[:=]|pwd\s*[:=]|user(name)?\s*[:=]|credential|log\s*in\s*as|singpass|\buin\s*[:=]/.test(blob);
}

// Determine SingPass vs CorpPass from the LOGIN steps:
//   login with UIN only            → SINGPASS
//   login with both UIN and UEN    → CORPPASS
// (A UEN used later for SEARCH does not count — only UEN inside a login step.)
function detectLoginType(testcase) {
  const steps = testcase?.steps || [];
  const loginSteps = steps.filter(s =>
    /singpass|corppass|corpass|log\s*in|sign\s*in|authenticat/i.test(`${s.action || ''} ${s.test_data || ''}`));
  const blob = loginSteps.map(s => `${s.action || ''} ${s.test_data || ''}`).join(' ');

  // Explicit wording wins
  if (/corp\s*pass|corppass|corpass/i.test(blob)) return 'CORPPASS';

  const hasUEN = /\buen\b/i.test(blob) || /\b\d{8,10}[A-Z]\b/.test(blob);                 // UEN keyword or pattern
  const hasUIN = /\b(uin|nric|fin)\b/i.test(blob) || /\b[STFG]\d{7}[A-Z]\b/i.test(blob);  // UIN/NRIC/FIN keyword or pattern
  if (loginSteps.length) {
    if (hasUIN && hasUEN) return 'CORPPASS';
    if (hasUIN)           return 'SINGPASS';
  }

  // Fallback to the test_data fields when login steps are vague
  const td = (testcase && typeof testcase.test_data === 'object') ? testcase.test_data : {};
  const lt = String(td.login_type || td.logintype || td.loginType || '').toLowerCase();
  if (/corp/.test(lt)) return 'CORPPASS';
  if (/sing/.test(lt)) return 'SINGPASS';
  if (td.corppass || td.login_uen) return 'CORPPASS';
  if (td.singpass_uin || td.uin || td.nric) return 'SINGPASS';
  return '';
}

// Pull username/password ONLY from the test case (top-level fields or its test_data).
// The tool is used across different projects/applications, so there is NO fixed default
// login — credentials must come from the test case for the app/URL under test. If a TC
// omits them, the agent asks the human (request_login) rather than using a hardcoded value.
function extractCreds(testcase) {
  const td = testcase?.test_data;
  const o  = td && typeof td === 'object' ? td : {};
  return {
    username: testcase?.username || testcase?.login || o.username || o.login || '',
    password: testcase?.password || o.password || o.pwd || '',
  };
}

// Poll for a login form to appear (SPA pages render it after navigation).
async function waitForLoginForm(page, timeoutMs = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await hasLoginForm(page)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// In-page helper source (string) — walks the DOM INCLUDING open shadow roots, so it
// works on web-component / Angular-MFE login forms that Playwright locators miss.
const DEEP_DOM_FNS = `
  const deep = (sel) => { const out = []; const walk = (r) => { try { out.push(...r.querySelectorAll(sel)); } catch (e) {} r.querySelectorAll('*').forEach(e => { if (e.shadowRoot) walk(e.shadowRoot); }); }; walk(document); return out; };
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const attrs = (el) => ((el.placeholder||'') + ' ' + (el.name||'') + ' ' + (el.id||'') + ' ' + (el.getAttribute('aria-label')||'') + ' ' + (el.type||'')).toLowerCase();
  const findPwd = (ins) => ins.find(i => i.type === 'password') || ins.find(i => /pass/.test(attrs(i)));
`;

// Are we on a real USERNAME/PASSWORD login page? Requires an actual password field
// (type=password or a "password" placeholder/label). This deliberately does NOT match
// a SingPass/CorpPass MOCK (UIN/identity entry, no password) — that is filled by the
// model from the step data, not by the deterministic br2s/br2s auto-login.
async function hasLoginForm(page) {
  try {
    return await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const inputs = deep('input').filter(vis);
      return !!findPwd(inputs);
    })()`);
  } catch { return false; }
}

// Are we on a SingPass/CorpPass MOCK identity form (no password field, but identity inputs)?
// Triggers only on test-environment mocks — not the real SingPass/CorpPass SSO.
async function hasMockLoginForm(page) {
  try {
    return await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const inputs = deep('input').filter(vis).filter(i => i.type !== 'hidden');
      if (!inputs.length) return false;
      if (inputs.find(i => i.type === 'password' || /pass/.test(attrs(i)))) return false;
      const fieldBlob = inputs.map(i => attrs(i)).join(' ');
      const pageText  = (document.body?.innerText || '').toLowerCase();
      return /singpass|corppass|mock|\\buin\\b|\\bnric\\b|\\bfin\\b|\\buen\\b|entity.*id|identity/i.test(fieldBlob + ' ' + pageText);
    })()`);
  } catch { return false; }
}

// Single combined login probe — ONE shadow-aware deep walk per turn (instead of a
// separate hasLoginForm + hasMockLoginForm pass). Reports:
//   hasPwd    — a standard username/PASSWORD form is present
//   hasMock   — a SingPass/CorpPass MOCK identity form (fillable UIN/UEN input) is present
//   spChooser — a SingPass/CorpPass page that offers login OPTIONS but no identity input
//               yet (e.g. "Scan QR" vs "Manual/Password login" tabs) — we must pick manual
async function probeLoginState(page) {
  try {
    return await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const inputs = deep('input').filter(vis).filter(i => i.type !== 'hidden');
      const hasPwd = !!findPwd(inputs);
      if (hasPwd) return { hasPwd: true, hasMock: false, spChooser: false };
      const pageText  = (document.body?.innerText || '').toLowerCase();
      const fieldBlob = inputs.map(i => attrs(i)).join(' ');
      const spContext = /singpass|corppass|corpass/.test(pageText + ' ' + fieldBlob);
      // a fillable identity input (text/tel/number-ish, not a button)
      const idInput = inputs.find(i => ['text','tel','number','email',''].includes((i.type||'').toLowerCase()));
      const hasMock   = !!idInput && (spContext || /mock|\\buin\\b|\\bnric\\b|\\bfin\\b|\\buen\\b|entity.*id|identity/i.test(fieldBlob + ' ' + pageText));
      const spChooser = !idInput && spContext;
      return { hasPwd: false, hasMock, spChooser };
    })()`);
  } catch { return { hasPwd: false, hasMock: false, spChooser: false }; }
}

// On a SingPass/CorpPass chooser page, click the MANUAL / password / "Singpass ID"
// option (where you TYPE a NRIC/UIN) to reveal the mock identity form. Deliberately
// AVOIDS QR-code / "Singpass app" / mobile / biometric options — those are the real
// device flow, not the UAT mock. Returns the label clicked, or null.
const MANUAL_LOGIN_RE = /manual|mock|password\s*login|login\s*with\s*password|use\s*password|singpass\s*id|log\s*in\s*with\s*(your\s*)?singpass\s*id|enter\s*(your\s*)?(nric|uin|id)/i;
const AVOID_LOGIN_RE  = /scan|qr\b|singpass\s*app|mobile|face|fingerprint|biometric|download|google\s*play|app\s*store/i;
async function preferManualLogin(page, emit) {
  try {
    const clicked = await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const MANUAL = ${MANUAL_LOGIN_RE.toString()};
      const AVOID  = ${AVOID_LOGIN_RE.toString()};
      const txt = (el) => (el.innerText || el.getAttribute('aria-label') || el.value || '').trim().replace(/\\s+/g,' ');
      const cands = deep('a,button,[role=tab],[role=button],[role=link],[role=menuitem]').filter(vis);
      const hit = cands.find(el => { const t = txt(el); return t && t.length < 60 && MANUAL.test(t) && !AVOID.test(t); });
      if (hit) { hit.click(); return txt(hit).slice(0, 40); }
      return null;
    })()`);
    if (clicked) {
      emit('action', `→ SP/CP mock: chose manual entry "${clicked}" (avoiding QR/app)`);
      await page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
      await page.waitForTimeout(1200);
      return true;
    }
    return false;
  } catch { return false; }
}

// Deterministically fill any visible UUID / GUID field with the configured value.
// Runs before each turn so the AI never has to type a UUID — it always uses ours.
// Returns the count of fields filled (0 if none found / already filled correctly).
async function autoFillUuids(page, uuid, emit) {
  try {
    const filled = await page.evaluate(`(() => {${DEEP_DOM_FNS}
      const setVal = (el, val) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        ['input','change','blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      };
      const uuid = ${JSON.stringify(uuid || '')};
      if (!uuid) return 0;
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const inputs = deep('input, textarea').filter(vis).filter(i =>
        i.type !== 'hidden' && i.type !== 'password' && i.type !== 'submit' && !i.disabled && !i.readOnly);
      let count = 0;
      for (const el of inputs) {
        const a = attrs(el);
        const isUuid = /uuid|guid|correlation[\\s_-]?id|request[\\s_-]?id|transaction[\\s_-]?id|trace[\\s_-]?id/i.test(a);
        if (!isUuid) continue;
        if (UUID_RE.test((el.value || '').trim())) continue;   // already a UUID — leave it
        setVal(el, uuid);
        count++;
      }
      return count;
    })()`);
    if (filled > 0) emit('action', `→ Auto-filled ${filled} UUID field(s) with ${uuid}`);
    return filled;
  } catch (e) { return 0; }
}

// Deterministically fill the SP/CP MOCK form. uin = NRIC/FIN; uen = UEN (CorpPass only).
// Uses the same native-setter technique as autoLogin so Angular/React forms register the values.
async function autoSpLogin(page, uin, uen, emit) {
  try {
    const result = await page.evaluate(`(async () => {${DEEP_DOM_FNS}
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const setVal = (el, val) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        ['input','change','blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      };
      const uin = ${JSON.stringify(uin || '')};
      const uen = ${JSON.stringify(uen || '')};
      const inputs = deep('input').filter(vis).filter(i => i.type !== 'hidden' && i.type !== 'password' && i.type !== 'submit');
      if (!inputs.length) return { ok: false, reason: 'no inputs' };
      const uinField = inputs.find(i => /\\buin\\b|\\bnric\\b|\\bfin\\b|identity|singpass/i.test(attrs(i))) || inputs[0];
      if (uinField && uin) setVal(uinField, uin);
      if (uen) {
        const uenField = inputs.find(i => i !== uinField && /\\buen\\b|entity|company|corp/i.test(attrs(i)))
                      || inputs.find(i => i !== uinField);
        if (uenField) setVal(uenField, uen);
      }
      const findBtn = () => deep('button, input[type=submit]').filter(vis).find(b =>
        /log\\s*in|sign\\s*in|submit|continue|next|proceed/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '')));
      for (let i = 0; i < 30; i++) {
        const b = findBtn();
        if (b && !b.disabled) { b.click(); return { ok: true }; }
        await sleep(200);
      }
      const b2 = findBtn();
      if (b2) { b2.click(); return { ok: true }; }
      const form = uinField?.closest && uinField.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return { ok: true }; }
      return { ok: false, reason: 'no submit button' };
    })()`);
    if (!result?.ok) { emit('warn', `⚠ SP/CP mock fill: ${result?.reason || 'unknown'}`); return false; }
    emit('action', `→ SP/CP mock: filled ${[uin, uen].filter(Boolean).join(' + ')} & submitted`);
    await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return true;
  } catch (e) { emit('warn', `⚠ SP/CP auto-fill failed: ${e.message}`); return false; }
}

// Deterministically fill the login form (deep DOM walk), wait for the Login button
// to enable, then click it. Falls back to form submit / Enter.
async function autoLogin(page, creds, emit) {
  try {
    const result = await page.evaluate(`(async () => {${DEEP_DOM_FNS}
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const setVal = (el, val) => {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        ['input','change','blur'].forEach(t => el.dispatchEvent(new Event(t, { bubbles: true })));
      };
      const username = ${JSON.stringify(creds.username || '')};
      const password = ${JSON.stringify(creds.password || '')};
      const inputs = deep('input').filter(vis);
      if (!inputs.length) return { ok: false, reason: 'no inputs' };
      let pwd = findPwd(inputs);
      let user = inputs.find(i => i !== pwd && /(user|email|login|\\buin\\b|\\bid\\b)/.test(attrs(i))) || inputs.find(i => i !== pwd);
      if (!pwd && inputs.length >= 2) pwd = inputs[1];
      if (!user && inputs.length >= 1) user = inputs[0];
      if (!pwd) return { ok: false, reason: 'no password field' };
      if (user && username) setVal(user, username);
      setVal(pwd, password);
      const findBtn = () => deep('button, input[type=submit]').filter(vis).find(b => /log\\s*in|sign\\s*in|submit|continue/i.test((b.innerText || b.value || b.getAttribute('aria-label') || '')));
      for (let i = 0; i < 25; i++) { const b = findBtn(); if (b && !b.disabled) { b.click(); return { ok: true, clicked: 'button' }; } await sleep(200); }
      const form = pwd.closest && pwd.closest('form');
      if (form) { (form.requestSubmit ? form.requestSubmit() : form.submit()); return { ok: true, clicked: 'form' }; }
      const b2 = findBtn(); if (b2) { b2.click(); return { ok: true, clicked: 'forced' }; }
      return { ok: true, clicked: 'none' };
    })()`);

    if (!result || !result.ok) { emit('warn', `⚠ Login form not found (${result?.reason || 'unknown'})`); return false; }
    emit('action', `→ Filled login (username: ${creds.username})${result.clicked !== 'none' ? ' & submitted' : ''}`);

    await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const stillLogin = await hasLoginForm(page);
    emit(stillLogin ? 'warn' : 'success', stillLogin ? '⚠ Submitted login but still on a login page' : '✓ Logged in');
    return !stillLogin;
  } catch (e) {
    emit('warn', `⚠ Auto-login failed: ${e.message}`);
    return false;
  }
}

// Log in using the REPO's own login locators (extracted from its login page-object) —
// the proven selectors the suite already uses. Classifies each candidate as user /
// password / submit by keyword, fills + submits. Returns true if it filled a password
// field (i.e. it actually drove a credential form); the caller verifies it left login.
async function autoLoginWithHints(page, creds, hints, emit) {
  if (!hints) return false;
  const reUser   = /user|email|login|\buin\b|nric|\bid\b|account/i;
  const rePass   = /pass|pwd|secret/i;
  const reSubmit = /log\s*in|sign\s*in|submit|continue|next|proceed/i;

  // Build classified candidate locators (Playwright locators pierce open shadow DOM).
  const fieldCands = [];
  for (const c of hints.css)          fieldCands.push({ loc: page.locator(c),          desc: c });
  for (const l of hints.labels)       fieldCands.push({ loc: page.getByLabel(l),        desc: `label ${l}` });
  for (const p of hints.placeholders) fieldCands.push({ loc: page.getByPlaceholder(p),  desc: `placeholder ${p}` });
  for (const t of hints.testIds)      fieldCands.push({ loc: page.getByTestId(t),       desc: `testid ${t}` });
  const submitCands = hints.roleNames
    .filter(r => r.role === 'button' || r.role === 'link')
    .map(r => ({ loc: page.getByRole(r.role, { name: r.name }), desc: `${r.role} ${r.name}` }));

  const tryFill = async (re, value) => {
    for (const c of fieldCands) {
      if (!re.test(c.desc)) continue;
      try {
        const loc = c.loc.first();
        if (await loc.count() && await loc.isVisible().catch(() => false)) {
          await loc.fill(value, { timeout: 3000 });
          return true;
        }
      } catch {}
    }
    return false;
  };

  const passOk = creds.password ? await tryFill(rePass, creds.password) : false;
  if (!passOk) return false;   // repo hints didn't resolve a password field → use heuristic
  const userOk = creds.username ? await tryFill(reUser, creds.username) : false;

  let clicked = false;
  for (const c of [...submitCands, ...fieldCands]) {
    if (!reSubmit.test(c.desc)) continue;
    try { const loc = c.loc.first(); if (await loc.count()) { await loc.click({ timeout: 4000 }); clicked = true; break; } } catch {}
  }
  if (!clicked) await page.keyboard.press('Enter').catch(() => {});

  emit('action', `→ Repo login: filled ${userOk ? 'username + ' : ''}password & submitted (using your repo's selectors)`);
  await page.waitForLoadState('domcontentloaded', { timeout: 9000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return true;
}

// Pause the agent and let the human sign in manually in the headed browser, then
// resume once they are past the login page (or on timeout / stop).
async function waitForManualLogin(page, emit, stop, broadcastFn, timeoutMs = 180000) {
  const startUrl = page.url();
  let hadPassword = false;
  try { hadPassword = await page.evaluate(() => !!document.querySelector('input[type=password]')); } catch {}

  emit('action', '🔐 Login required — please sign in to the application in the opened browser window. I will continue automatically once you are past the login page (waiting up to 3 min)…');
  broadcastFn?.({ type: 'agent_login_required', message: 'Please log in in the browser window — the agent will resume automatically.' });

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (stop()) return 'stopped';
    await page.waitForTimeout(2000);
    let url = startUrl, hasPassword = hadPassword;
    try { url = page.url(); } catch {}
    try { hasPassword = await page.evaluate(() => !!document.querySelector('input[type=password]')); } catch {}
    const urlLeftLogin = url !== startUrl && !LOGIN_RE.test(url);
    const passwordGone = hadPassword && !hasPassword;
    if (urlLeftLogin || passwordGone) {
      await page.waitForTimeout(1000);
      emit('progress', '✓ Login detected — resuming automation');
      broadcastFn?.({ type: 'agent_login_done' });
      return 'ok';
    }
  }
  emit('warn', '⚠ Login wait timed out (3 min) — continuing anyway');
  return 'timeout';
}

// Map the many synonyms a model may emit to our canonical action set, and normalise
// field aliases (text/keys → value, element → index, href → url).
const ACTION_ALIASES = {
  fill: 'fill', type: 'fill', input: 'fill', input_text: 'fill', inputtext: 'fill', enter: 'fill', enter_text: 'fill',
  set_text: 'fill', settext: 'fill', set_value: 'fill', setvalue: 'fill', write: 'fill', type_text: 'fill', typetext: 'fill', fill_field: 'fill',
  fill_form: 'fill_form', fillform: 'fill_form', fill_fields: 'fill_form', fill_and_submit: 'fill_form', form_fill: 'fill_form', submit_form: 'fill_form',
  click: 'click', tap: 'click', press_button: 'click', clickbutton: 'click', click_element: 'click', click_button: 'click',
  navigate: 'navigate', goto: 'navigate', go_to: 'navigate', open: 'navigate', open_url: 'navigate', visit: 'navigate', goto_url: 'navigate', load: 'navigate',
  press: 'press', key: 'press', keypress: 'press', press_key: 'press', sendkey: 'press', send_keys: 'press', sendkeys: 'press', keyboard: 'press',
  select: 'select', choose: 'select', select_option: 'select', selectoption: 'select', dropdown: 'select',
  wait: 'wait', pause: 'wait', sleep: 'wait', wait_for: 'wait', waitfor: 'wait',
  scroll: 'scroll', scroll_down: 'scroll', scrolldown: 'scroll',
  request_login: 'request_login', manual_login: 'request_login', ask_login: 'request_login', login_request: 'request_login', request_manual_login: 'request_login',
  finish: 'finish', done: 'finish', complete: 'finish', completed: 'finish', stop: 'finish', end: 'finish', finished: 'finish',
};
// Normalise a SINGLE action object: accept `type` or `action`, map synonyms, and
// coerce field aliases (text/keys→value, element→index, href→url).
function normalizeAction(a) {
  if (!a || typeof a !== 'object') return a;
  const raw = a.type ?? a.action ?? '';
  const key = String(raw).toLowerCase().trim().replace(/[\s-]+/g, '_');
  a.type = ACTION_ALIASES[key] || key;
  if (a.value == null || a.value === '') a.value = a.text ?? a.keys ?? a.key ?? a.input ?? a.option ?? a.value ?? '';
  if (a.index == null) a.index = a.element ?? a.element_index ?? a.elementIndex ?? a.idx ?? null;
  if (!a.url) a.url = a.href || a.link || '';
  return a;
}

// Coerce a model decision into a flat list of normalised actions. Handles the
// multi-action shape ({actions:[…]}), a legacy single action ({action,…}), and the
// older fill_form shape ({action:'fill_form',fields,submit}) for backward compat.
function coerceActions(decision) {
  let list = [];
  if (Array.isArray(decision.actions)) list = decision.actions.slice();
  else if (decision.action || decision.type) list = [decision];

  const out = [];
  for (const a0 of list) {
    const a = normalizeAction({ ...a0 });
    if (a.type === 'fill_form') {
      for (const f of (a.fields || [])) {
        if (f && f.index != null) out.push({ type: 'fill', index: f.index, value: String(f.value ?? '') });
      }
      if (a.submit) out.push({ type: 'click', index: a.submitIndex ?? null, _submit: true });
      continue;
    }
    out.push(a);
  }
  return out.slice(0, MAX_ACTIONS_PER_TURN);
}

const settlePage = async (page) => {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
};

// ── Execute ONE action against the page (indices re-tagged shadow-aware first) ───
async function execOne(page, a, emit, ctx = {}) {
  normalizeAction(a);
  if (['click', 'fill', 'press', 'select'].includes(a.type)) {
    await retagElements(page);
    if (a.index != null) await flashElement(page, a.index, a.type);   // visual pulse on the target
  }

  switch (a.type) {
    case 'navigate':
      if (!a.url) throw new Error('navigate requires a url');
      await page.goto(a.url, { waitUntil: 'domcontentloaded' });
      await settlePage(page);
      return `navigated to ${a.url}`;
    case 'click': {
      // No explicit index (model said "click submit/login") → find the submit/login button.
      if (a.index == null) {
        let btn = page.getByRole('button', { name: /log\s*in|sign\s*in|submit|continue|next|search|save|proceed/i }).first();
        if (!(await btn.count())) btn = page.locator('button[type="submit"]:visible, input[type="submit"]:visible').first();
        if (await btn.count()) { await btn.click({ timeout: 8000 }).catch(async () => { await page.keyboard.press('Enter').catch(() => {}); }); }
        else await page.keyboard.press('Enter').catch(() => {});
        await settlePage(page);
        return 'submitted';
      }
      // Premature-submit guard — fire ONLY when an actual credential form is present:
      // a visible PASSWORD field that is still empty. This never blocks a navigation
      // "Login" link on a home page (no password field there) or a header search box.
      const btnText = await page.locator(sel(a.index)).evaluate(
        el => (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase()
      ).catch(() => '');
      if (/\b(log[\s_]?in|sign[\s_]?in|login|signin|submit)\b/i.test(btnText)) {
        const pwdEmpty = await page.evaluate(`(() => {${DEEP_DOM_FNS}
          const pwd = deep('input').filter(vis).find(i => i.type === 'password' || /pass/.test(attrs(i)));
          return pwd ? !(pwd.value || '').trim() : false;   // only block when a password field exists AND is empty
        })()`).catch(() => false);
        if (pwdEmpty) {
          emit('warn', '⚠ Blocked premature submit — password field is still empty');
          return 'blocked — password field empty';
        }
      }
      await page.click(sel(a.index));
      await settlePage(page);
      return `clicked [${a.index}]`;
    }
    case 'fill':
      await page.fill(sel(a.index), a.value ?? '');
      return `filled [${a.index}] = "${String(a.value).slice(0, 40)}"`;
    case 'press': {
      const key = a.value || 'Enter';
      if (a.index != null) await page.press(sel(a.index), key);
      else await page.keyboard.press(key);
      await settlePage(page);
      return `pressed ${key}`;
    }
    case 'select':
      await page.selectOption(sel(a.index), a.value);
      await settlePage(page);
      return `selected "${a.value}" in [${a.index}]`;
    case 'scroll':
      await page.mouse.wheel(0, 800);
      await page.waitForTimeout(400);
      return 'scrolled down';
    case 'wait':
      await settlePage(page);
      return 'waited';
    case 'request_login': {
      const r = await waitForManualLogin(page, emit, ctx.stop || (() => false), ctx.broadcastFn);
      return r === 'ok' ? 'user logged in' : `manual login ${r}`;
    }
    default:
      throw new Error(`unknown action "${a.type}"`);
  }
}

// Execute a BATCH of actions in sequence. Stops early when the page navigates (so the
// next turn re-observes the new page) or an action errors. Records each successful UI
// action for the repo-conversion step. Returns { results, navigated, recordedCount }.
async function executeBatch(page, actions, obs, emit, recorded, ctx = {}) {
  const descOf = (idx) => {
    const el = idx != null ? obs.elements.find(e => e.idx === idx) : null;
    return el ? { tag: el.tag, role: el.role, type: el.type, label: el.label } : null;
  };
  const results = [];
  let navigated = false;
  for (const a of actions) {
    if (ctx.stop && ctx.stop()) break;
    const urlBefore = page.url();
    let result;
    try { result = await execOne(page, a, emit, ctx); }
    catch (e) { result = `error: ${e.message}`; emit('warn', `⚠ ${result}`); results.push(result); break; }

    const label = `${a.type}${a.index != null ? `[${a.index}]` : ''}${a.url ? ` ${a.url}` : ''}${a.value ? ` "${String(a.value).slice(0, 30)}"` : ''}`;
    emit('action', `→ ${label} — ${result}`);
    results.push(result);

    // Record reproducible step for conversion (skip errors / guard-blocks)
    if (!String(result).startsWith('error') && !String(result).startsWith('blocked') &&
        ['navigate', 'click', 'fill', 'press', 'select', 'scroll'].includes(a.type)) {
      recorded.push({ step: recorded.length + 1, action: a.type, url: a.url || '', value: a.value || '', target: descOf(a.index) });
    }

    if (String(result).startsWith('error') || String(result).startsWith('blocked')) break;
    if (page.url() !== urlBefore) { navigated = true; break; }   // page changed → re-observe
  }
  return { results, navigated };
}

// Write one file into the repo (overwrite), with a path-traversal guard.
function writeRepoFile(repoPath, relPath, content, emit) {
  const root = path.resolve(repoPath);
  const dest = path.resolve(root, relPath);
  if (dest !== root && !dest.startsWith(root + path.sep)) { emit('warn', `⚠ Skipped unsafe path: ${relPath}`); return false; }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, content, 'utf8');
  emit('success', `  ✓ saved ${relPath}`);
  return true;
}

// Read a file under the repo, or '' if missing.
function readRepoFile(repoPath, relPath) {
  try { return fs.readFileSync(path.join(repoPath, relPath), 'utf8'); } catch { return ''; }
}

// Derive a stable PascalCase MODULE identifier (so all test cases of the same module
// map to the same page/spec/data files). Prefer the explicit module field; otherwise
// take the leading MODULE token from a "MODULE_SUBMODULE_TCxx_Title" style name.
function moduleIdent(testcase) {
  let raw = (testcase?.module || '').trim();
  if (!raw) {
    const name = String(testcase?.title || testcase?.tc_id || 'Module');
    // Strip a trailing "_TCxx_..." / "_TSxx_..." then take the first segment.
    const base = name.replace(/_T[CS]?\d.*$/i, '');
    raw = (base.split(/[_\s/-]+/)[0] || name).trim();
  }
  const parts = raw.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // Single token → keep its original casing; multi-word → PascalCase join.
  const id = parts.length === 1 ? parts[0]
           : parts.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return id || 'Module';
}

// ── Excel test-data: append/replace a row in data/<Module>.xlsx (keyed by TestCaseName) ──
function updateDataExcel(repoPath, relPath, row, emit) {
  if (!row || !Object.keys(row).length) return null;
  let XLSX;
  try { XLSX = require('xlsx'); } catch { emit('warn', '⚠ xlsx module unavailable — skipped test-data Excel update'); return null; }

  const abs = path.join(repoPath, relPath);
  let rows = [], sheetName = 'Data';
  try {
    const wb = XLSX.readFile(abs);
    sheetName = wb.SheetNames[0] || 'Data';
    rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
  } catch { /* new file */ }

  // Replace an existing row with the same TestCaseName, else append (keeps order)
  const keyCol = Object.keys(row).find(k => /^testcasename$/i.test(k)) || 'TestCaseName';
  const idx = rows.findIndex(r => String(r[keyCol] ?? '').trim() && String(r[keyCol]).trim() === String(row[keyCol]).trim());
  if (idx >= 0) rows[idx] = { ...rows[idx], ...row }; else rows.push(row);

  // Normalise columns across all rows (union of keys)
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const norm = rows.map(r => { const o = {}; cols.forEach(c => o[c] = r[c] ?? ''); return o; });

  const ws = XLSX.utils.json_to_sheet(norm, { header: cols });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  XLSX.writeFile(wb, abs);
  emit('success', `  ✓ ${idx >= 0 ? 'updated' : 'appended'} data row in ${relPath} (${norm.length} row(s))`);
  return relPath;
}

// Convert the recorded session into repo-structured scripts following the repo's
// .github prompt, MERGING into the per-module page/spec/data files so multiple test
// cases from the same module accumulate in the same files.
async function convertRecordingToRepoScripts({ testcase, recorded = [], rawScript = '', baseUrl, aiOpts, emit, creds = {}, spIdentity = '', loginType = '' }) {
  const repoPath = repoCtx.getRepoPath();
  if (!repoCtx.repoExists(repoPath)) {
    emit('warn', '⚠ No automation repo connected — set the Codebase Path and Connect to auto-convert into the repo structure.');
    return null;
  }
  if (!recorded.length && !rawScript) { emit('warn', '⚠ Nothing to convert — no recorded actions or script.'); return null; }

  // Lean context (prompt file + compact seed/login) → much faster through the CLI
  const context  = repoCtx.buildConversionContext(repoPath);
  const pagesDir = repoCtx.getPageObjectsDir(repoPath);
  const specsDir = repoCtx.getSpecsDir();
  const mod      = moduleIdent(testcase);
  const tcName   = testcase?.title || testcase?.tc_id || 'RecordedFlow';
  const isNeg    = /negative/.test((testcase?.type || '').toLowerCase()) ||
    /not authoris|not authoriz|unauthoris|unauthoriz|access denied|restricted|forbidden|should not|cannot access|no permission|denied|validation (error|message)|invalid/.test(
      ((testcase?.expected_result || '') + ' ' + (testcase?.steps || []).map(s => s.expected_result || '').join(' ')).toLowerCase());

  // Deterministic per-module targets so the same module reuses the same files
  const pagePath = `${pagesDir}/${mod}Page.js`;
  const specPath = `${specsDir}/${mod}.spec.js`;
  const dataPath = `data/${mod}.xlsx`;

  // Cap echoed existing files so a large module spec doesn't blow up the prompt
  const cap = (s, n = 9000) => (s && s.length > n ? s.slice(0, n) + '\n/* …truncated… */' : s);
  const existingPage = cap(readRepoFile(repoPath, pagePath));
  const existingSpec = cap(readRepoFile(repoPath, specPath));

  // The source test steps (from Jira/Xray) — actions drive navigation, expected results drive asserts
  const tcSteps = (testcase?.steps || []).map((s, i) => ({
    step: s.step_number || i + 1,
    action: s.action || '',
    data: s.test_data || '',
    expected: s.expected_result || '',
  }));
  const overallExpected = testcase?.expected_result || '';

  emit('action', `🛠 Converting "${tcName}" into module ${mod} (${existingSpec ? 'merging into existing' : 'creating new'} ${specPath})…`);

  const prompt =
`${context}

You are converting a test case into automation scripts that MUST follow the repository
conventions and the instructions/prompt file shown above EXACTLY.

This test case belongs to MODULE "${mod}". Multiple test cases from the same module accumulate
in the SAME files, so you must MERGE into the existing files below (do not drop existing content):

Target page object: ${pagePath}
Target spec file   : ${specPath}
Shared data file   : ${dataPath}

Test case: ${tcName}
${baseUrl ? `Base URL: ${baseUrl}` : ''}

LOGIN (the recorded session was already logged in by the harness — you MUST emit the login steps yourself):
- The flow ALWAYS starts by opening the Base URL and logging in on the standard username/password page${creds.username ? ` with username "${creds.username}" and password "${creds.password}"` : ''}.
- Reuse the repo's EXISTING login page object / method (see the loginPage in the context above) — do NOT hand-roll selectors if a login method exists.${spIdentity ? `\n- Then complete the SingPass/CorpPass step using identity "${spIdentity}" (reuse the repo's SP/CP login method if present).` : ''}
- Read these login values from the data file columns (Username, Password${spIdentity ? ', UIN' : ''}${loginType ? ', loginType' : ''}) — do not hardcode them in the spec.${loginType ? `\n- This test logs in via ${loginType} (${loginType === 'CORPPASS' ? 'UIN + UEN' : 'UIN only'}). Use the loginType column value "${loginType}" to drive the correct login path.` : ''}

TEST STEPS (from Jira/Xray) — use the "action" to navigate and the "expected" to ASSERT:
${JSON.stringify(tcSteps, null, 2)}
${overallExpected ? `\nOVERALL EXPECTED RESULT (assert at the end): ${overallExpected}` : ''}

RECORDED browser session (actual selectors/targets observed live — use for robust locators):
${rawScript
  ? 'A Playwright script was recorded for this flow (Codegen). Use its selectors/steps as the source of truth:\n```javascript\n' + (rawScript.length > 12000 ? rawScript.slice(0, 12000) + '\n/* …truncated… */' : rawScript) + '\n```'
  : JSON.stringify(recorded, null, 2)}

EXISTING PAGE OBJECT (${pagePath}) — extend this; keep all current locators/methods:
${existingPage ? '```javascript\n' + existingPage + '\n```' : '(none yet — create it)'}

EXISTING SPEC (${specPath}) — keep all existing tests and ADD this test in order at the end.
If a test for "${tcName}" already exists, REPLACE just that test:
${existingSpec ? '```javascript\n' + existingSpec + '\n```' : '(none yet — create it)'}

Rules:
- Navigate the flow using the step "action"s, in order, with their "data".
- For EACH step's "expected", add a Playwright assertion that verifies it (e.g. await expect(locator).toBeVisible(), toHaveText(...), expect(page).toHaveURL(...), toContainText(...)). Do not skip expected results.
- Add a final assertion for the OVERALL EXPECTED RESULT.
${isNeg ? '- This is a NEGATIVE test: the expected outcome is an error / "not authorised" / access-denied / validation message. ASSERT THAT MESSAGE/PAGE IS SHOWN (e.g. await expect(page.getByText(/not authorised|access denied/i)).toBeVisible()). Do NOT assert success or that the restricted content loaded.' : ''}
- Reuse existing page-object methods/locators where possible; only add new methods needed for this test.
- The spec must read its data from ${dataPath} the same way the seed spec reads Excel data.
- Build robust locators from each recorded target (role/label/text).
- Return the COMPLETE, updated file contents (not diffs).
- For the data row, output the columns this test needs (always include "TestCaseName": "${tcName}"${creds.username ? `, "Username": "${creds.username}", "Password": "${creds.password}"` : ''}${spIdentity ? `, "UIN": "${spIdentity}"` : ''}${loginType ? `, "loginType": "${loginType}"` : ''}). Use the EXACT column name "loginType" (camelCase) — not "Login type".

Return ONLY valid JSON:
{
  "page": { "path": "${pagePath}", "content": "// full merged page object" },
  "spec": { "path": "${specPath}", "content": "// full merged spec with all tests" },
  "data": { "path": "${dataPath}", "row": { "TestCaseName": "${tcName}"${creds.username ? `, "Username": "${creds.username}", "Password": "${creds.password}"` : ''}${spIdentity ? `, "UIN": "${spIdentity}"` : ''}${loginType ? `, "loginType": "${loginType}"` : ''} } }
}`;

  // Conversion is mechanical code-gen — run it on a FASTER model than the live agent.
  // CONVERSION_MODEL overrides; otherwise default Claude to Sonnet (Opus is slowest via CLI).
  const convModel = process.env.CONVERSION_MODEL ||
    (aiOpts.provider === 'claude' ? 'claude-sonnet-4-6' : aiOpts.model);
  if (convModel && convModel !== aiOpts.model) emit('progress', `⚙ Using ${convModel} for faster script generation`);

  let data;
  try {
    data = await callAI(prompt, 16000, { ...aiOpts, model: convModel });
  } catch (e) {
    emit('error', `✗ Conversion failed (${aiOpts.provider || 'AI'}): ${e.message}`);
    return null;
  }
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
  if (!data || (!data.page && !data.spec)) { emit('warn', '⚠ Conversion returned no usable files.'); return null; }

  // Force the deterministic per-MODULE paths — never the model's chosen (TC-named) path.
  const saved = [];
  if (data.page?.content) { if (writeRepoFile(repoPath, pagePath, data.page.content, emit)) saved.push(pagePath); }
  if (data.spec?.content) { if (writeRepoFile(repoPath, specPath, data.spec.content, emit)) saved.push(specPath); }

  // Ensure the login columns are always in the data row (safety net if the model omits them).
  const row = { TestCaseName: tcName, ...(data.data?.row || {}) };
  // Drop any login-type column variants the model may have invented, then set the canonical one.
  for (const k of Object.keys(row)) {
    if (/^login[\s_]?type$/i.test(k) && k !== 'loginType') delete row[k];
  }
  if (creds.username && !row.Username) row.Username = creds.username;
  if (creds.password && !row.Password) row.Password = creds.password;
  if (spIdentity && !row.UIN) row.UIN = spIdentity;
  if (loginType) row.loginType = loginType;   // force correct column name + derived value
  { const d = updateDataExcel(repoPath, dataPath, row, emit); if (d) saved.push(d); }

  emit('success', `✓ Converted into module ${mod} — ${saved.length} file(s) updated under ${repoPath}`);
  const files = [data.page, data.spec].filter(f => f && f.content);
  return { files, saved, repoPath, module: mod };
}

// ── Core agentic runner ─────────────────────────────────────────────────────────
async function runBrowserAgent({ mode, testcase, prompt: userPrompt, instruction, broadcastFn, aiOpts = {}, shouldStop, repoPath }) {
  const emit = (level, text) => broadcastFn?.({ type: 'agent_action', level, text });
  const stop = () => (typeof shouldStop === 'function' ? shouldStop() : false);

  // Lock in the connected automation repo for this run so conversion finds it
  // regardless of module-state timing.
  if (repoPath) repoCtx.setRepoPath(repoPath);

  // ── Resolve UUID test values (configured or generated) ───────────────────────
  const uuids = buildUuids();

  // ── Build the task description ───────────────────────────────────────────────
  let task;
  let baseUrl = process.env.APP_BASE_URL || '';
  if (mode === 'execute') {
    task = applyUuid(userPrompt, uuids);
  } else if (mode === 'automate' && testcase) {
    const steps = (testcase.steps || [])
      .map((s, i) =>
        `${i + 1}. ${applyUuid(s.action, uuids)}` +
        (s.test_data       ? ` [data: ${applyUuid(s.test_data, uuids)}]`     : '') +
        (s.expected_result ? ` → expect: ${applyUuid(s.expected_result, uuids)}` : ''))
      .join('\n');
    const td = testcase.test_data;
    // URL priority: explicit TC field → test_data.app_url (provided data) → .env
    baseUrl = testcase.baseUrl || testcase.app_url || (td && typeof td === 'object' && (td.app_url || td.url || td.base_url)) || baseUrl;
    const loginAs = testcase.username || testcase.login || testcase.UIN ||
                    (td && typeof td === 'object' && (td.username || td.login || td.singpass_uin || td.uin)) || '';
    const testDataBlock = applyUuid(formatTestData(td), uuids);
    const preconds = (testcase.preconditions || []).filter(Boolean);
    task =
`Execute this test case end-to-end. Use the EXACT values from the Test Data below — do not invent any values.
Test Case : ${testcase.title || testcase.tc_id || 'TC'}
Module    : ${testcase.module || ''}` +
(loginAs ? `\nLogin as  : ${loginAs}` : '') +
(baseUrl ? `\nBase URL  : ${baseUrl}` : '') +
(testDataBlock ? `\n\nTest Data:\n${testDataBlock}` : '') +
(preconds.length ? `\n\nPreconditions:\n${preconds.map(p => `- ${p}`).join('\n')}` : '') +
`\n\nSteps:\n${steps}`;
  } else {
    task = userPrompt || (baseUrl ? `Open ${baseUrl} and report what you see.` : 'Open the target application.');
  }

  // Optional user-edited automation instruction (from the "Edit Prompt" box) — appended as
  // additional guidance so the human can steer the run without losing the structured task.
  if (instruction && String(instruction).trim()) {
    task += `\n\nADDITIONAL INSTRUCTIONS (from the user — follow these):\n${String(instruction).trim()}`;
  }

  // Always give the agent a concrete UUID to use for any UUID/GUID field.
  const uuidHint = `For any UUID / GUID field, use exactly this value: ${uuids.fixed}`;

  // Negative test? Then an error / "not authorised" / validation page can be the EXPECTED outcome.
  const _expectedBlob = mode === 'automate'
    ? ((testcase?.expected_result || '') + ' ' + (testcase?.steps || []).map(s => s.expected_result || '').join(' ')).toLowerCase()
    : '';
  const isNegative = mode === 'automate' &&
    (/negative/.test((testcase?.type || '').toLowerCase()) ||
     /not authoris|not authoriz|unauthoris|unauthoriz|access denied|restricted|forbidden|should not|cannot access|no permission|denied|error message|validation (error|message)|invalid/.test(_expectedBlob));
  const negativeHint = isNegative
    ? 'This is a NEGATIVE test: an error / "not authorised" / access-denied / validation page may be the EXPECTED result. If you reach such a page and it matches the step\'s expected result, that is a PASS — confirm it and "finish" successfully. Do NOT treat it as a failure or navigate away.'
    : '';

  // No fixed credentials — login comes only from the test case (automate) or is handled
  // interactively (execute/free-prompt). Project-agnostic across applications/URLs.
  const creds = mode === 'automate' ? extractCreds(testcase) : { username: '', password: '' };
  const credentialsProvided = !!(creds.username && creds.password) || (mode === 'automate' && hasProvidedCredentials(testcase));

  // SingPass (UIN only) vs CorpPass (UIN + UEN) — derived from the login steps/data
  const loginType = mode === 'automate' ? detectLoginType(testcase) : '';

  // Identity for the SP/CP (SingPass/CorpPass) MOCK login — extract UIN and UEN separately
  // so the deterministic autoSpLogin can fill each field independently.
  const _td = (mode === 'automate' && testcase && typeof testcase.test_data === 'object') ? testcase.test_data : {};
  let spUin = _td.singpass_uin || _td.uin || _td.nric || testcase?.UIN || '';
  let spUen = _td.uen || _td.login_uen || _td.corppass_uen || '';
  if (mode === 'automate') {
    const stepsBlob = JSON.stringify(testcase?.steps || []);
    if (!spUin) { const m = stepsBlob.match(/\b[STFG]\d{7}[A-Z]\b/i); if (m) spUin = m[0]; }
    if (!spUen && loginType === 'CORPPASS') { const m = stepsBlob.match(/\b\d{8,10}[A-Z]\b/); if (m) spUen = m[0]; }
  }
  const spIdentity = spUin || spUen;  // for credHint + conversion prompt (backward compat)

  // Login guidance is project-agnostic: each application's login page differs, so drive
  // login from THIS test case's steps/data. SP/CP-specific guidance only appears when the
  // test case actually carries an identity value.
  const credHint =
    (creds.username && creds.password
      ? `LOGIN: a standard username/password page is auto-filled & submitted by the system — do NOT act on it or use "request_login" for it. `
      : `LOGIN: follow the test case's login steps for THIS application. If a login is required but the Test Data has no credentials for it, use "request_login" so the human can sign in. `) +
    (spIdentity
      ? `This test also uses an identity/SSO-style login: if a chooser appears, pick the MANUAL / "Password login" / identity-entry option (type the NRIC/UIN/UEN) — NEVER "Scan QR" / app / mobile (the real, non-mock flow). Fill the identity field(s) with "${spIdentity}" and submit. Do NOT request_login for it.`
      : `Each application's login page is different — do not assume any particular login UI; use only what the test case and the page in front of you show.`);

  const providerLabel = aiOpts.provider || 'AI';
  emit('start', `🚀 Agentic Browser Agent — driven by ${providerLabel} (max ${MAX_TURNS} turns)`);
  if (mode === 'automate' && testcase) {
    emit('progress', `📋 Test: ${testcase.title || testcase.tc_id || 'TC'} · ${(testcase.steps || []).length} step(s)`);
    const tdShown = formatTestData(testcase.test_data, { mask: true });
    if (tdShown) emit('progress', `📦 Test data recognised → ${tdShown.replace(/\n/g, ' · ')}`);
    else emit('warn', '⚠ No structured test_data on this test case — using steps only');
  } else {
    emit('progress', `📋 Task: ${task.slice(0, 140)}${task.length > 140 ? '…' : ''}`);
  }
  if (baseUrl) emit('progress', `🌐 URL: ${baseUrl}`);
  emit('progress', `🆔 UUID for UUID fields: ${uuids.fixed}`);
  if (isNegative) emit('progress', '🚫 Negative test — an access-denied / error page may be the expected (passing) result');
  if (loginType) emit('progress', `🔑 Login type: ${loginType} (${loginType === 'CORPPASS' ? 'UIN + UEN' : 'UIN only'})`);

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser());
  } catch (e) {
    emit('error', `✗ Could not launch the browser: ${e.message}`);
    throw new Error(`Browser launch failed: ${e.message}`);
  }

  // Seed: navigate to the base URL up front so the model starts on the right page.
  if (baseUrl) {
    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});  // let the SPA render
      await page.waitForTimeout(800);
      emit('action', `→ Opened ${baseUrl}`);
      // Give the SPA a moment to render the login form before the first decision
      if (creds.username && creds.password) await waitForLoginForm(page, 15000);
    } catch (e) { emit('warn', `⚠ Could not open base URL: ${e.message}`); }
  }

  const history  = [];
  const recorded = [];   // durable, reproducible action log for repo conversion
  let finished = false, finishNote = '';
  let autoLoginTries = 0;
  let spLoginDone = false;
  let prevSigs = null, prevUrl = '';   // for marking newly-appeared elements

  // Reuse the connected repo's OWN login locators for the standard login page.
  const repoLoginHints = repoCtx.repoExists(repoCtx.getRepoPath()) ? repoCtx.getLoginHints(repoCtx.getRepoPath()) : null;
  if (repoLoginHints) emit('progress', `🔑 Reusing login selectors from your repo's loginPage (${repoLoginHints.css.length} css · ${repoLoginHints.roleNames.length} button(s))`);

  try {
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
      if (stop()) { emit('warn', '⏹ Stopped by user'); break; }

      // One combined login probe per turn (shadow-aware) — drives the deterministic
      // fast-paths below so the model rarely has to handle login itself.
      const login = await probeLoginState(page);

      // Deterministic login: standard username/password page. Prefer the REPO's own
      // login selectors (proven), then fall back to the heuristic deep-DOM auto-login.
      if (creds.username && creds.password && autoLoginTries < 2 && login.hasPwd) {
        autoLoginTries++;
        emit('think', `✶ Login page detected — signing in as ${creds.username}`);
        let ok = false;
        if (repoLoginHints) {
          const used = await autoLoginWithHints(page, creds, repoLoginHints, emit);
          if (used) ok = !(await probeLoginState(page)).hasPwd;   // verify we left the login form
          if (used && !ok) emit('warn', '⚠ Repo login selectors did not pass the login page — trying deep-DOM fallback');
        }
        if (!ok) ok = await autoLogin(page, creds, emit);
        recorded.push({ step: recorded.length + 1, action: 'login', value: creds.username, target: { role: 'form', label: 'Login' } });
        if (ok) continue;   // logged in → re-observe on the next turn
      }

      // Deterministic UUID fill — any visible UUID/GUID/correlation-id field.
      await autoFillUuids(page, uuids.fixed, emit);

      // SP/CP chooser page (QR vs manual): click the MANUAL/password option to reveal
      // the mock identity form — never the QR/app (real-device) flow. Then re-observe.
      if (spUin && !spLoginDone && login.spChooser) {
        const revealed = await preferManualLogin(page, emit);
        if (revealed) continue;   // re-probe; the identity form should now be visible
      }

      // Deterministic SP/CP mock login: fill UIN/UEN directly so the model never has to.
      if (spUin && !spLoginDone && login.hasMock) {
        spLoginDone = true;
        emit('think', `✶ SP/CP mock detected — filling ${loginType || 'identity'}: ${[spUin, spUen].filter(Boolean).join(' + ')}`);
        const ok = await autoSpLogin(page, spUin, spUen, emit);
        recorded.push({ step: recorded.length + 1, action: 'splogin', value: [spUin, spUen].filter(Boolean).join(' + '), target: { role: 'form', label: loginType || 'SP/CP Mock' } });
        if (ok) continue;
      }

      const obs = await observe(page);
      await drawHighlights(page);   // browser-use-style boxes + index labels in the live browser
      // Only mark "new" elements when we're still on the same URL (else everything is new).
      const sameUrl = obs.url === prevUrl;
      const prompt =
`TASK:
${task}

${credHint}
${uuidHint}${negativeHint ? `\n${negativeHint}` : ''}

CURRENT PAGE:
${describeObservation(obs, sameUrl ? prevSigs : null)}

RECENT HISTORY (last few turns):
${history.slice(-5).map(h => `- T${h.turn}: ${h.summary}${h.memory ? ` | memory: ${h.memory}` : ''}`).join('\n') || '(none yet)'}

Plan the next BATCH of actions as strict JSON ({evaluation, memory, thought, actions:[…], done, success, summary}).`;
      prevSigs = new Set(obs.elements.map(elemSig));
      prevUrl  = obs.url;

      let decision;
      try {
        decision = await callAI(prompt, 1500, { ...aiOpts, systemPrompt: AGENT_SYSTEM_PROMPT });
      } catch (e) {
        emit('error', `✗ ${providerLabel} call failed: ${e.message}`);
        throw new Error(`AI provider call failed: ${e.message}`);
      }
      if (typeof decision === 'string') { try { decision = JSON.parse(decision); } catch { decision = { done: true, summary: 'Could not parse model response' }; } }
      decision = decision || { done: true, summary: 'Empty response' };

      // Surface the model's self-evaluation of the PREVIOUS action (helps spot spinning).
      if (decision.evaluation) emit('think', `⮑ eval: ${String(decision.evaluation).slice(0, 140)}`);
      emit('think', `✶ T${turn}: ${(decision.thought || decision.summary || '').slice(0, 180)}`);

      // Finish signal: explicit done, OR a legacy finish action, OR no actions left to take.
      const actions = coerceActions(decision);
      const memory = decision.memory ? String(decision.memory).slice(0, 160) : '';
      const wantsFinish = decision.done === true ||
        /^(finish|done|complete|stop|end)$/i.test(String(decision.action || '')) ||
        (!actions.length && !decision.actions);
      if (wantsFinish && !actions.length) {
        finished = true;
        finishNote = decision.summary || decision.thought || 'done';
        break;
      }
      if (!actions.length) { history.push({ turn, summary: 'no-op (empty actions)', memory }); continue; }

      const { results, navigated } = await executeBatch(page, actions, obs, emit, recorded, { stop, broadcastFn });
      const batchSummary = actions.map(a => `${a.type}${a.index != null ? `[${a.index}]` : ''}`).join(', ');
      history.push({ turn, summary: `${batchSummary} → ${results[results.length - 1] || 'ok'}${navigated ? ' (page changed)' : ''}`, memory });

      // The model may also signal completion in the same turn it acts.
      if (decision.done === true) { finished = true; finishNote = decision.summary || decision.thought || 'done'; break; }
    }

    // Final screenshot
    try { await page.screenshot({ path: SCREENSHOT, fullPage: false }); emit('success', `📸 Screenshot saved → ${SCREENSHOT}`); } catch {}

    if (finished) emit('success', `✓ Agent finished — ${finishNote}`.slice(0, 200));
    else if (!stop()) emit('warn', `⚠ Reached the ${MAX_TURNS}-turn limit before finishing`);

    // ── Convert the recorded session into repo-structured scripts ──────────────
    let conversion = null;
    if (!stop()) {
      try { conversion = await convertRecordingToRepoScripts({ testcase, recorded, baseUrl, aiOpts, emit, creds, spIdentity, loginType }); }
      catch (e) { emit('warn', `⚠ Conversion error: ${e.message}`); }
    }

    return {
      success:    true,
      finished,
      turns:      history.length,
      screenshot: fs.existsSync(SCREENSHOT) ? SCREENSHOT : null,
      recorded,
      files:      conversion?.files || [],
      saved:      conversion?.saved || [],
      repoPath:   conversion?.repoPath || null,
    };
  } finally {
    try { await browser.close(); } catch {}
  }
}

module.exports = {
  runBrowserAgent,
  convertRecordingToRepoScripts,   // reused by the per-script "Convert" button
  // Internals exposed for reuse by the Digital Twin crawler (auth + deep DOM walk).
  _internals: {
    DEEP_DOM_FNS, hasLoginForm, autoLogin, waitForLoginForm, launchBrowser,
    hasMockLoginForm, autoSpLogin, autoFillUuids,
  },
};
