/* ═══════════════════════════════════════════════════════════════════════════
   Test Alchemist — Main Application
   ══════════════════════════════════════════════════════════════════════════ */

// ── Client Identity (persists across reloads; unique per browser profile) ──────
function getClientId() {
  let id = localStorage.getItem('qahub_client_id');
  if (!id) {
    id = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem('qahub_client_id', id);
  }
  return id;
}
const CLIENT_ID = getClientId();

// ── State ──────────────────────────────────────────────────────────────────────
const State = {
  currentStep: 1,
  uploadedFiles: [],
  parsedInputs: [],
  scenarios: [],
  selectedScenarioIds: new Set(),   // tracks checked scenario IDs across filter re-renders
  testcases: [],
  playwrightFiles: [],
  lastPipelineId: null,
  lastPipelineWebUrl: null,
  settings: {},
};

// ── API helpers (supports S3-hosted frontend pointing at a remote backend) ──────
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');
async function apiFetch(path, opts) {
  const res = await fetch(API_BASE + path, opts);
  if (res.status === 401) {
    try { const j = await res.clone().json(); if (j && j.authRequired) showLoginOverlay(); } catch {}
  }
  return res;
}

// ── Authentication (local accounts; no-op when auth is disabled server-side) ────
async function guardAuth() {
  try {
    const me = await fetch(API_BASE + '/api/auth/me').then(r => r.json());
    if (me.authEnabled && !me.authenticated) { showLoginOverlay(); return false; }
    if (me.authEnabled && me.user) showAuthedUser(me.user);
    return true;
  } catch { return true; }   // never hard-block if the check itself fails
}
function showLoginOverlay() { const el = document.getElementById('loginOverlay'); if (el) el.style.display = 'flex'; }
function hideLoginOverlay() { const el = document.getElementById('loginOverlay'); if (el) el.style.display = 'none'; }
function showAuthedUser(user) {
  const box = document.getElementById('authUserBox');
  if (box) {
    box.style.display = '';
    const ws = user.workspace && user.workspace !== 'default' ? ` · ${user.workspace}` : '';
    document.getElementById('authUserName').textContent = user.username + ws;
  }
}
async function submitLogin(e) {
  if (e) e.preventDefault();
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginError');
  errEl.textContent = '';
  try {
    const res = await fetch(API_BASE + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (res.ok && data.ok) { hideLoginOverlay(); location.reload(); }
    else errEl.textContent = data.error || 'Login failed';
  } catch (err) { errEl.textContent = err.message; }
}
async function logout() {
  try { await fetch(API_BASE + '/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host  = window.WS_HOST || location.host;
  ws = new WebSocket(`${proto}//${host}?clientId=${CLIENT_ID}`);

  ws.onopen = () => {
    document.getElementById('wsDot').classList.add('connected');
    document.getElementById('wsLabel').textContent = 'Live';
  };
  ws.onclose = () => {
    document.getElementById('wsDot').classList.remove('connected');
    document.getElementById('wsLabel').textContent = 'Reconnecting…';
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (e) => {
    try { handleWsMessage(JSON.parse(e.data)); } catch {}
  };
}

// Map logStep number → exec pane stepKey
function _stepKeyForLogStep(logStep) {
  return { 2:'inputs', 3:'scenarios', 4:'testcases', 5:'playwright', 6:'pipeline' }[logStep] || 'scenarios';
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'progress': {
      const icons   = { scenarios: '🎯', testcases: '⚗️', playwright: '🎭' };
      const labels  = { scenarios: 'Generating Scenarios', testcases: 'Generating Test Cases', playwright: 'Building Playwright Tests' };
      const label   = labels[msg.step]  || msg.step;
      const icon    = icons[msg.step]   || '⚗️';

      // Route progress to the relevant exec pane
      const paneMap = { scenarios: 3, testcases: 4, playwright: 6 };
      const paneStep = paneMap[msg.step];
      if (paneStep) xlog(paneStep, `${label} — ${msg.status}`, 'progress');

      const match = msg.status?.match(/group\s+(\d+)\s+of\s+(\d+)/i);
      const pct   = match ? Math.round((parseInt(match[1]) / parseInt(match[2])) * 90) : null;
      Progress.setIcon(icon);
      Progress.update(`${label} — ${msg.status}`, pct);
      break;
    }
    case 'scenarios_generated':
      Progress.update('Scenarios ready ✓', 95);
      xlog(3, `${msg.count} scenarios generated`, 'success');
      toast(`${msg.count} scenarios generated`, 'success'); break;
    case 'testcases_generated':
      Progress.update('Test cases ready ✓', 95);
      xlog(4, `${msg.count} test cases generated`, 'success');
      toast(`${msg.count} test cases generated`, 'success'); break;
    case 'playwright_generated':
      Progress.update('Playwright files ready ✓', 95);
      xlog(6, `${msg.count} Playwright files ready`, 'success');
      toast(`${msg.count} Playwright files ready`, 'success'); break;
    case 'pipeline_triggered':
      xlog(7, `Pipeline #${msg.pipelineId} triggered — ${msg.status}`, 'success');
      toast(`Pipeline #${msg.pipelineId} triggered — ${msg.status}`, 'info'); break;
    case 'jira_ticket_created':
      xlog(4, `Created ${msg.jiraKey} for ${msg.tcId}`, 'jira');
      appendJiraLog(`✅ Created ${msg.jiraKey} for ${msg.tcId}`); break;
    case 'agent_status':
      // Refresh pipeline nodes with live statuses when any agent changes state
      refreshAgents();
      break;
    case 'orchestrator_log':
      xlog(1, msg.message, 'ai');
      appendOrchLog(msg.message); break;
    case 'orchestrator_done':
      xlog(1, 'Orchestration complete ✓', 'success');
      toast('Orchestration complete!', 'success'); refreshAgents(); break;
    case 'orchestrator_error':
      xlog(1, `Orchestration failed: ${msg.error}`, 'error');
      toast(`Orchestration failed: ${msg.error}`, 'error'); refreshAgents(); break;
    case 'reference_library_updated':
      xlog(2, `Reference library updated — ${msg.tcCount || '?'} TCs`, 'success');
      loadRefLibraryStatus();
      if (msg.auto) toast(`Reference library auto-loaded from repo (${msg.tcCount || '?'} TCs)`, 'success');
      break;
    case 'schedule_triggered':
      xlog(7, `Schedule "${msg.name}" triggered`, 'info');
      toast(`Schedule "${msg.name}" triggered`, 'info'); break;
    case 'schedule_error':
      xlog(7, `Schedule error: ${msg.error}`, 'error');
      toast(`Schedule error: ${msg.error}`, 'error'); break;

    // ── Browser agent events ──────────────────────────────────────────────
    case 'agent_action':
    case 'agent_done':
      handleAgentWsMessage(msg); break;
    case 'agent_login_required':
      toast(msg.message || 'Please log in in the browser window — the agent will resume automatically.', 'warn'); break;
    case 'agent_login_done':
      toast('Login detected — agent resuming', 'success'); break;

    // ── Repo script run (one-click execution of existing repo specs) ──────
    case 'repo_run_line':
      _repoFeedLine(msg.level || 'output', msg.text || ''); break;
    case 'repo_run_done': {
      const stopBtn = document.getElementById('btnRepoStop');
      if (stopBtn) stopBtn.style.display = 'none';
      if (msg.stopped) _repoFeedLine('warn', '⏹ Stopped by user');
      else {
        _repoFeedLine(msg.success ? 'success' : 'error',
          msg.success ? '✓ Run complete' : `✗ Run failed${msg.error ? ': ' + msg.error : ''}`);
        if (msg.evidence) _repoFeedLine('info', `📄 Evidence: ${msg.evidence.rel}`);
      }
      break;
    }

    // ── Digital Twin crawl ────────────────────────────────────────────────
    case 'twin_start':
      _twinFeedLine('start', `🧬 Crawl started → ${msg.baseUrl}`); break;
    case 'twin_progress':
      _twinFeedLine(msg.level || 'info', msg.text || ''); break;
    case 'twin_guided_page':
      _twinFeedLine('success', `● page ${msg.count}: ${msg.route}`); break;
    case 'twin_done':
      _twinCrawlFinished(msg); break;

    // ── Script Library (codegen + run output) ────────────────────────────
    case 'pw_lib_codegen_status':
    case 'pw_lib_codegen_log':
    case 'pw_lib_codegen_done':
    case 'pw_lib_convert_done':
    case 'pw_lib_line':
    case 'pw_lib_done':
      handlePwLibWs(msg); break;

    // ── Playwright run terminal ───────────────────────────────────────────
    case 'pw_run_line':
      _pwTermLine(msg.text, msg.level);
      break;
    case 'pw_run_done': {
      const badge = document.getElementById('pwRunBadge');
      const btn   = document.getElementById('btnRunTests');
      if (btn)   { btn.disabled = false; btn.textContent = '▶ Run Tests'; }
      if (msg.success) {
        if (badge) { badge.textContent = '✅ Passed'; badge.style.color = '#7fcf8f'; }
        toast('All Playwright tests passed!', 'success');
        xlog(6, 'Playwright run: all tests passed ✅', 'success');
      } else {
        if (badge) { badge.textContent = '❌ Failed'; badge.style.color = '#e0786b'; }
        toast('Playwright tests failed — see terminal output', 'error');
        xlog(6, `Playwright run failed (exit ${msg.exitCode ?? '?'})`, 'error');
      }
      break;
    }

    // ── History persistence events ────────────────────────────────────────
    case 'generation_saved':
      if (State.currentStep === 3) loadScenHistory();
      if (State.currentStep === 4) loadTcHistory();
      break;
    case 'tcs_saved':
      if (State.currentStep === 4) loadTcHistory();
      break;

    // ── Exec Pane: structured agent step events ────────────────────────────
    case 'exec:step':     window.EP?.wsStep(msg);     break;
    case 'exec:progress': window.EP?.wsProgress(msg); break;
    case 'exec:log':      window.EP?.wsLog(msg);      break;

    // ── Real-time AI call events from providers/index.js ──────────────────
    case 'ai_log': {
      if (msg.subtype === 'token') {
        // Token chunks go to the exec pane feed ONLY (too many to put in xlog)
        window.EP?.wsToken(msg.message);
        break;
      }
      // Non-token AI telemetry (call start, token counts, timing) → xlog + exec pane
      const step = msg.logStep || State.currentStep || 3;
      const type = msg.subtype === 'error' ? 'error' : 'ai';
      xlog(step, msg.message, type);
      // Also surface in exec pane feed as an action line
      if (msg.message && !msg.message.startsWith('→') && !msg.message.startsWith('←')) break;
      window.EP?.wsLog({ type: 'exec:log', stepKey: _stepKeyForLogStep(step), text: msg.message, level: 'think' });
      break;
    }
  }
}

// ── Step Navigation ────────────────────────────────────────────────────────────
function goToStep(n) {
  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.step-item').forEach(s => s.classList.remove('active'));
  document.getElementById(`step${n}`).classList.add('active');
  document.querySelector(`.step-item[data-step="${n}"]`).classList.add('active');
  State.currentStep = n;
  _advanceFlowStrip(n);
  document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
  // Refresh history panels on navigation (deferred so the panel is visible first)
  setTimeout(() => {
    if (n === 3) { if (typeof loadScenHistory === 'function') loadScenHistory(); _syncAddScenBtn(); _syncRegenScenBtn(); }
    if (n === 4) { if (typeof loadTcHistory === 'function') loadTcHistory(); _syncAddTcBtn(); _syncRegenTcBtn(); }
    if (n === 5) { _refreshJiraTcSummary(); populateJiraFields(); }
    if (n === 6) {
      if (typeof initBrowserAgent    === 'function') initBrowserAgent();
      if (typeof _pwLibPopulateTcSelector === 'function') _pwLibPopulateTcSelector();
    }
    if (n === 7) { if (typeof loadKnowledge      === 'function') loadKnowledge(); }
    if (typeof updateAiChatCtxLabel === 'function') updateAiChatCtxLabel();
  }, 0);
}

// Advance the workflow progress strip to reflect the current step.
function _advanceFlowStrip(activeStep) {
  const fsteps = document.querySelectorAll('.fstep');
  const fconns = document.querySelectorAll('.fconn');
  // Map app step → strip position (1-based). Max strip = 7.
  const stripPos = Math.min(activeStep, 7);
  fsteps.forEach((s, i) => {
    const sNum = i + 1;
    s.classList.remove('done', 'live');
    if (sNum < stripPos)  s.classList.add('done');
    if (sNum === stripPos) s.classList.add('live');
  });
  fconns.forEach((c, i) => {
    c.classList.toggle('done', i + 1 < stripPos);
  });
}

// ── Input Tab Switching ────────────────────────────────────────────────────────
function switchInputTab(id, el) {
  ['userStory', 'requirements', 'rules', 'figma', 'confluence', 'codebase'].forEach(t => {
    document.getElementById(`tab-${t}`).style.display = t === id ? '' : 'none';
  });
  el.parentElement.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

// ── File Upload ────────────────────────────────────────────────────────────────
const FILE_ICONS = { pdf: '📕', excel: '📗', word: '📘', pptx: '📙', csv: '📊', text: '📄', markdown: '📝' };

function getFileType(name) {
  const ext = name.split('.').pop().toLowerCase();
  return { pdf: 'pdf', xlsx: 'excel', xls: 'excel', docx: 'word', doc: 'word',
           pptx: 'pptx', ppt: 'pptx', csv: 'csv', txt: 'text', md: 'markdown' }[ext] || 'text';
}

document.getElementById('fileInput').addEventListener('change', (e) => {
  [...e.target.files].forEach(addFileToList);
  e.target.value = '';
});

const uploadZone = document.getElementById('uploadZone');
uploadZone.addEventListener('dragover', (e) => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  [...e.dataTransfer.files].forEach(addFileToList);
});

function addFileToList(file) {
  if (State.uploadedFiles.find(f => f.name === file.name)) return;
  State.uploadedFiles.push(file);
  renderFileList();
}

function removeFile(name) {
  State.uploadedFiles = State.uploadedFiles.filter(f => f.name !== name);
  renderFileList();
}

function renderFileList() {
  const list = document.getElementById('fileList');
  list.innerHTML = State.uploadedFiles.map(f => {
    const type = getFileType(f.name);
    return `<div class="file-chip">
      <span class="type-icon">${FILE_ICONS[type] || '📄'}</span>
      <span>${f.name}</span>
      <span class="remove-btn" onclick="removeFile('${f.name}')">✕</span>
    </div>`;
  }).join('');
}

// ── Step 1 → 2: Parse Inputs & Generate Scenarios ─────────────────────────────
async function parseInputsAndGenerateScenarios() {
  // ── Validate mandatory Generation Name ───────────────────────────────────
  const genNameEl = document.getElementById('generationName');
  const genName   = genNameEl?.value?.trim();
  if (!genName) {
    genNameEl?.focus();
    genNameEl && (genNameEl.style.borderColor = 'rgba(239,68,68,.6)');
    toast('Generation Name is required — enter a name so it appears clearly in history.', 'warn');
    return;
  }
  genNameEl && (genNameEl.style.borderColor = 'rgba(226,173,76,.3)');
  State.currentGenerationName = genName;   // save for later use

  const provider = getSetting('activeProvider') || 'copilot';
  // Claude without a key falls back to the local Claude Code CLI — allow it.
  // Copilot without a key uses the local VS Code bridge on port 3939 — allow it.
  // Other providers always need a key.
  if (!getSetting(activeProviderKey()) && provider !== 'claude' && provider !== 'copilot') {
    const name = PROVIDER_META[provider]?.label || 'AI';
    toast(`Add your ${name} API key in ⚙ Settings → AI Provider first`, 'error');
    openSettings();
    return;
  }
  showLoading('Parsing files and generating test scenarios with AI…');
  try {
    const fileNames = State.uploadedFiles.map(f => f.name).join(', ') || 'text inputs';
    xlog(2, `Starting "${genName}" — files: ${fileNames}`, 'parse');

    const fd = new FormData();
    State.uploadedFiles.forEach(f => fd.append('files', f));
    ['userStory', 'requirements', 'rules'].forEach(id => {
      const v = document.getElementById(id)?.value?.trim();
      if (v) fd.append(id, v);
    });
    // Include Confluence page content if fetched
    if (window._confluenceContent) {
      fd.append('requirements', (fd.get('requirements') || '') + '\n\n--- Confluence: ' + (window._confluenceTitle || 'Page') + ' ---\n' + window._confluenceContent);
    }
    // Include codebase source code as context
    if (window._codebaseContext) {
      fd.append('codebaseContext', window._codebaseContext);
      fd.append('codebaseModule', window._codebaseModule || '');
    }
    fd.append('generationName', genName);   // pass to backend

    xlog(2, 'Parsing uploaded files…', 'progress');
    const parseRes = await apiFetch('/api/ai/parse-inputs', { method: 'POST', body: fd }).then(r => r.json());
    if (!parseRes.success) throw new Error(parseRes.error);
    State.parsedInputs = parseRes.inputs;
    xlog(2, `Parsed ${State.parsedInputs.length} input section(s)`, 'success');

    if (!State.parsedInputs.length) throw new Error('No inputs found. Please upload a file or enter requirements.');

    xlog(2, 'Sending to AI for scenario generation…', 'ai');
    const scenRes = await apiFetch('/api/ai/generate-scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: State.parsedInputs,
        generationName: genName,             // ← the user's chosen name
        applicationName: document.getElementById('appName').value || 'Web Application',
        applicationContext: document.getElementById('appContext').value,
        ...aiOpts(),
      }),
    }).then(r => r.json());

    if (!scenRes.success) throw new Error(scenRes.error);
    State.scenarios = scenRes.scenarios || [];
    State.selectedScenarioIds.clear();
    // Store generationId so TC generation links to the same history entry
    if (scenRes.generationId) State.currentGenerationId = scenRes.generationId;

    xlog(2, `${State.scenarios.length} scenarios generated ✓`, 'success');
    xlog(3, `${State.scenarios.length} scenarios loaded — ready for test case generation`, 'success');

    renderScenarios();
    showWarnings(scenRes.warnings, 'scenarioWarnings');
    markStepDone(2);
    goToStep(3);
    toast(`${State.scenarios.length} scenarios generated`, 'success');
  } catch (err) {
    xlog(2, `Error: ${err.message}`, 'error');
    toast(err.message, 'error');
  } finally {
    hideLoading();
  }
}

// ── Reference Library ──────────────────────────────────────────────────────────
let _refLibOpen = false;

function toggleRefLibrary() {
  _refLibOpen = !_refLibOpen;
  document.getElementById('refLibBody').style.display = _refLibOpen ? '' : 'none';
  document.getElementById('refLibChevron').style.transform = _refLibOpen ? 'rotate(180deg)' : '';
}

async function loadRefLibraryStatus() {
  try {
    const [libRes, srcRes] = await Promise.all([
      apiFetch('/api/ai/reference-library').then(r => r.json()),
      apiFetch('/api/ai/reference-library/sources').then(r => r.json()).catch(() => ({ sources: [] })),
    ]);
    renderRefLibSources(srcRes.sources || [], srcRes.stale);
    if (libRes.exists && libRes.analysis) {
      renderRefLibStats(libRes.analysis, libRes.lastUpdated);
    }
  } catch {}
}

function renderRefLibSources(sources, stale) {
  const el = document.getElementById('refLibSources');
  if (!el) return;
  if (!sources.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  el.innerHTML = `
    <div style="margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.04em">
          Source files in repo <span style="color:var(--text-dim);font-size:10px;font-family:'JetBrains Mono',monospace;margin-left:4px">(${sources.length})</span>
        </span>
        <button class="btn btn-sm btn-outline" onclick="reanalyzeRefLib()" id="refLibReanalyzeBtn">
          ${stale ? '⚠ Stale — ' : ''}↺ Re-analyze
        </button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px">
        ${sources.map(s => `
          <div class="rl-src-file">
            <span class="rl-src-file-icon">📄</span>
            <span class="rl-src-file-name">${escHtml(s)}</span>
            <button class="rl-src-file-remove" onclick="removeRefLibSource('${escHtml(s).replace(/'/g,"\\'")}')">
              ✕ Remove
            </button>
          </div>`).join('')}
      </div>
    </div>
    <hr style="border-color:var(--border);margin-bottom:12px">
  `;
}

async function removeRefLibSource(filename) {
  if (!confirm(`Remove "${filename}" from the source library?`)) return;
  const btn = [...document.querySelectorAll('.rl-src-file-remove')]
    .find(b => b.textContent.trim() === '✕ Remove' && b.closest('.rl-src-file')?.querySelector('.rl-src-file-name')?.textContent === filename);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    const res = await apiFetch(`/api/ai/reference-library/sources/${encodeURIComponent(filename)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiOpts()),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);

    if (res.analysis) {
      renderRefLibStats(res.analysis, new Date().toISOString());
      toast(`"${filename}" removed — library re-analyzed`, 'success');
    } else {
      // No files left — clear stats UI
      document.getElementById('refLibBadge').textContent = 'Not loaded';
      document.getElementById('refLibBadge').style.cssText = 'background:rgba(255,255,255,.04);color:var(--text-muted);border:1px solid rgba(255,255,255,.1);font-size:11px;padding:2px 10px;border-radius:999px';
      document.getElementById('refLibStats').style.display  = 'none';
      document.getElementById('refLibClearBtn').style.display = 'none';
      document.querySelector('.ref-lib-card')?.classList.remove('loaded');
      toast(`"${filename}" removed — no source files remaining`, 'success');
    }
    // Refresh the sources list
    await loadRefLibraryStatus();
  } catch (err) {
    toast(`Remove failed: ${err.message}`, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '✕ Remove'; }
  }
}

async function reanalyzeRefLib() {
  const btn = document.getElementById('refLibReanalyzeBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Analysing…'; }
  document.getElementById('refLibProgress').style.display = '';
  try {
    const res = await apiFetch('/api/ai/reference-library/reanalyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(aiOpts()),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    renderRefLibStats(res.analysis, new Date().toISOString());
    const srcRes = await apiFetch('/api/ai/reference-library/sources').then(r => r.json()).catch(() => ({ sources: [] }));
    renderRefLibSources(srcRes.sources || [], false);
    toast(`Reference library re-analysed — ${res.analysis?.tc_count || 0} TCs`, 'success');
  } catch (err) {
    toast(`Re-analysis failed: ${err.message}`, 'error');
  } finally {
    document.getElementById('refLibProgress').style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = '↺ Re-analyze'; }
  }
}

function renderRefLibStats(a, lastUpdated) {
  const badge   = document.getElementById('refLibBadge');
  const statsEl = document.getElementById('refLibStats');
  const clearBtn = document.getElementById('refLibClearBtn');
  const card    = document.querySelector('.ref-lib-card');

  badge.textContent = `${a.tc_count || 0} TCs loaded`;
  badge.style.background = 'var(--primary-dim)';
  badge.style.color = 'var(--primary)';
  badge.style.borderColor = 'var(--primary-dim)';
  card?.classList.add('loaded');
  clearBtn.style.display = '';

  const updated = lastUpdated ? new Date(lastUpdated).toLocaleString() : '—';
  const moduleChips = (a.modules || []).map(m =>
    `<span class="ref-module-chip">${escHtml(m)}</span>`).join('');
  const gapsHtml = a.gaps_identified?.length
    ? `<div class="ref-gap-list"><span class="ref-stat-label">Known gaps</span>
       <ul>${a.gaps_identified.map(g => `<li>${escHtml(g)}</li>`).join('')}</ul></div>`
    : '';

  statsEl.innerHTML = `
    <div class="ref-stat-item">
      <span class="ref-stat-label">Total TCs</span>
      <span class="ref-stat-value">${a.tc_count || 0}</span>
    </div>
    <div class="ref-stat-item">
      <span class="ref-stat-label">Coverage areas</span>
      <span class="ref-stat-value">${(a.coverage_areas || []).length}</span>
    </div>
    <div class="ref-stat-item">
      <span class="ref-stat-label">Last updated</span>
      <span class="ref-stat-value" style="font-size:12px;font-weight:400">${updated}</span>
    </div>
    <div class="ref-stat-item">
      <span class="ref-stat-label">Naming convention</span>
      <span class="ref-stat-value" style="font-size:12px;font-weight:400">${escHtml(a.naming_convention || '—')}</span>
    </div>
    ${a.summary ? `<div class="ref-stat-item" style="grid-column:1/-1">
      <span class="ref-stat-label">Summary</span>
      <span class="ref-stat-value" style="font-size:13px;font-weight:400">${escHtml(a.summary)}</span>
    </div>` : ''}
    <div class="ref-module-chips">${moduleChips}</div>
    ${gapsHtml}
  `;
  statsEl.style.display = '';
}

async function handleRefLibUpload(e) {
  const files = [...(e.target.files || [])];
  if (!files.length) return;
  e.target.value = '';

  const progress = document.getElementById('refLibProgress');
  const uploadZone = document.getElementById('refLibUploadZone');
  progress.style.display = '';
  uploadZone.style.opacity = '0.5';

  // Upload files one by one — each adds to the source directory and accumulates
  let lastAnalysis = null;
  for (const file of files) {
    try {
      const progressEl = document.getElementById('refLibProgress');
      if (progressEl) progressEl.textContent = files.length > 1
        ? `⏳ Uploading ${file.name} (${files.indexOf(file)+1}/${files.length})…`
        : '⏳ Analysing test case dump with AI…';

      const fd = new FormData();
      fd.append('file', file);
      Object.entries(aiOpts()).forEach(([k, v]) => v && fd.append(k, v));

      const res = await apiFetch('/api/ai/reference-library', { method: 'POST', body: fd }).then(r => r.json());
      if (!res.success) throw new Error(res.error);
      lastAnalysis = res.analysis;
    } catch (err) {
      toast(`Error uploading "${file.name}": ${err.message}`, 'error');
    }
  }

  try {
    if (lastAnalysis) renderRefLibStats(lastAnalysis, new Date().toISOString());
    await loadRefLibraryStatus();
    const count = lastAnalysis?.tc_count || 0;
    toast(`Reference library updated — ${count} TCs from ${files.length} file(s)`, 'success');
  } finally {
    progress.style.display = 'none';
    uploadZone.style.opacity = '';
  }
}

async function clearRefLibrary(e) {
  e?.stopPropagation();
  if (!confirm('Clear the reference library? Future generations will not use existing TC patterns.')) return;
  try {
    await apiFetch('/api/ai/reference-library', { method: 'DELETE' });
    document.getElementById('refLibBadge').textContent = 'Not loaded';
    document.getElementById('refLibBadge').style.background = 'var(--bg)';
    document.getElementById('refLibBadge').style.color = 'var(--text-muted)';
    document.getElementById('refLibBadge').style.borderColor = 'var(--border)';
    document.getElementById('refLibStats').style.display = 'none';
    document.getElementById('refLibClearBtn').style.display = 'none';
    document.querySelector('.ref-lib-card')?.classList.remove('loaded');
    toast('Reference library cleared', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function updateRefLibraryWithTCs(testcases) {
  if (!document.getElementById('refLibAutoUpdate')?.checked) return;
  try {
    const res = await apiFetch('/api/ai/reference-library/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testcases, ...aiOpts() }),
    }).then(r => r.json());
    if (res.success) {
      renderRefLibStats(res.analysis, new Date().toISOString());
      toast(`Reference library updated — now ${res.analysis.tc_count || 0} TCs`, 'success');
    }
  } catch {}
}

// ── Render Scenarios ───────────────────────────────────────────────────────────
function renderScenarios(scenarios = State.scenarios) {
  document.getElementById('scenarioCount').textContent = scenarios.length;
  const grid = document.getElementById('scenarioGrid');

  if (!scenarios.length) {
    grid.innerHTML = `<div style="color:var(--text-dim);padding:40px;text-align:center;grid-column:1/-1">No scenarios to display.</div>`;
    return;
  }

  // Populate module filter
  const modules = [...new Set(scenarios.map(s => s.module).filter(Boolean))];
  const modSel = document.getElementById('scenarioModule');
  modSel.innerHTML = `<option value="">All Modules</option>` +
    modules.map(m => `<option>${m}</option>`).join('');

  grid.innerHTML = scenarios.map(sc => `
    <div class="scenario-card${State.selectedScenarioIds.has(sc.id) ? ' selected' : ''}" data-id="${sc.id}">
      <div class="sc-header">
        <div style="display:flex;align-items:center;gap:7px">
          <input type="checkbox" class="sc-select-cb" value="${sc.id}"
            ${State.selectedScenarioIds.has(sc.id) ? 'checked' : ''}
            onclick="event.stopPropagation()"
            onchange="updateScenarioSelectionCount()" />
          <span class="sc-id">${sc.id}</span>
        </div>
        <span class="tag priority-${sc.priority}">${sc.priority?.toUpperCase()}</span>
      </div>
      <div class="sc-title">${sc.title}</div>
      <div class="sc-module">📦 ${sc.module || 'General'}</div>
      <div class="sc-tags">
        <span class="tag type-${sc.type}">${sc.type}</span>
        ${(sc.tags || []).map(t => `<span class="tag">${t}</span>`).join('')}
      </div>
      <div class="sc-actions">
        <button class="btn btn-outline btn-sm" onclick="editScenario('${sc.id}')">✏ Edit</button>
        <button class="btn btn-danger btn-sm" onclick="deleteScenario('${sc.id}')">✕ Delete</button>
      </div>
    </div>
  `).join('');

  // Sync master checkbox and counter after every render
  updateScenarioSelectionCount();
}

function filterScenarios() {
  const q = document.getElementById('scenarioFilter').value.toLowerCase();
  const p = document.getElementById('scenarioPriority').value;
  const m = document.getElementById('scenarioModule').value;
  renderScenarios(State.scenarios.filter(s =>
    (!q || s.title.toLowerCase().includes(q) || s.module?.toLowerCase().includes(q)) &&
    (!p || s.priority === p) &&
    (!m || s.module === m)
  ));
}

// ── Scenario selection helpers ─────────────────────────────────────────────────
function toggleSelectAllScenarios() {
  const master = document.getElementById('selectAllScsCb');
  document.querySelectorAll('.sc-select-cb').forEach(cb => { cb.checked = master.checked; });
  updateScenarioSelectionCount();
}

function selectAllScenarios() {
  // Select every scenario (even filtered-out ones)
  State.scenarios.forEach(s => State.selectedScenarioIds.add(s.id));
  document.querySelectorAll('.sc-select-cb').forEach(cb => { cb.checked = true; });
  document.querySelectorAll('.scenario-card').forEach(c => c.classList.add('selected'));
  updateScenarioSelectionCount();
}

function clearScenarioSelection() {
  State.selectedScenarioIds.clear();
  document.querySelectorAll('.sc-select-cb').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('.scenario-card').forEach(c => c.classList.remove('selected'));
  updateScenarioSelectionCount();
}

function updateScenarioSelectionCount() {
  // Sync visible DOM checkboxes → State set
  document.querySelectorAll('.sc-select-cb').forEach(cb => {
    if (cb.checked) State.selectedScenarioIds.add(cb.value);
    else            State.selectedScenarioIds.delete(cb.value);
  });

  // Update card highlight
  document.querySelectorAll('.scenario-card').forEach(card => {
    card.classList.toggle('selected', State.selectedScenarioIds.has(card.dataset.id));
  });

  const selectedCount = State.selectedScenarioIds.size;
  const totalCount    = State.scenarios.length;

  // Counter label
  const el = document.getElementById('scSelectionCount');
  if (el) el.textContent = selectedCount > 0 ? `${selectedCount} of ${totalCount}` : `0 of ${totalCount}`;

  // Master checkbox state
  const visibleCbs      = document.querySelectorAll('.sc-select-cb');
  const visibleChecked  = [...visibleCbs].filter(cb => cb.checked).length;
  const master = document.getElementById('selectAllScsCb');
  if (master && visibleCbs.length > 0) {
    master.checked       = visibleChecked === visibleCbs.length;
    master.indeterminate = visibleChecked > 0 && visibleChecked < visibleCbs.length;
  }

  // "Generate Test Cases" button label
  const btn = document.getElementById('btnGenerateTestCases');
  if (btn) {
    btn.textContent = selectedCount > 0
      ? `📋 Generate Test Cases (${selectedCount} of ${totalCount}) →`
      : `📋 Generate Test Cases (ALL ${totalCount}) →`;
  }
}

function getSelectedScenarioIds() {
  // Returns array of selected IDs, or null meaning "use all"
  return State.selectedScenarioIds.size > 0 ? [...State.selectedScenarioIds] : null;
}

async function regenerateScenarios() {
  const genId = HistState.selectedScenGenId;
  if (!genId) { toast('Select a generation from the History panel first.', 'warn'); return; }

  // Load the generation's stored requirements
  showLoading('Loading generation data…');
  let inputs, appName;
  try {
    const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) throw new Error('Could not load generation');
    const gen = r.generation;
    appName   = gen.app_name || document.getElementById('appName')?.value || 'Web Application';
    inputs    = gen.requirement_text
      ? [{ section: gen.title, content: gen.requirement_text }]
      : State.parsedInputs;
    if (!inputs.length) throw new Error('No requirements found for this generation. Run from Step 1 to regenerate.');
  } catch (e) { hideLoading(); toast(e.message, 'warn'); return; }

  showLoading('Regenerating scenarios…');
  try {
    const res = await apiFetch('/api/ai/generate-scenarios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs, applicationName: appName, generationId: genId, ...aiOpts() }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    State.scenarios = res.scenarios || [];
    State.selectedScenarioIds.clear();
    renderScenarios();
    showWarnings(res.warnings, 'scenarioWarnings');
    await selectScenGeneration(genId);
    toast(`Regenerated ${State.scenarios.length} scenarios for this generation`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

async function regenerateTestCases() {
  const genId = HistState.selectedTcGenId;
  if (!genId) { toast('Select a generation from the History panel first.', 'warn'); return; }

  // Load the generation's scenarios
  showLoading('Loading generation data…');
  let scenarios, appName;
  try {
    const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) throw new Error('Could not load generation');
    appName   = r.generation.app_name || document.getElementById('appName')?.value || 'Web Application';
    scenarios = (r.scenarios || []).map(s => ({
      id: s.sc_id || s.id, title: s.title, module: s.module || '',
      priority: s.priority || 'medium', type: s.type || 'functional',
      tags: s.tags || [], acceptance_criteria: s.acceptance_criteria || [],
    }));
    if (!scenarios.length) throw new Error('No scenarios in this generation. Add scenarios first.');
  } catch (e) { hideLoading(); toast(e.message, 'warn'); return; }

  showLoading(`Regenerating test cases for ${scenarios.length} scenario${scenarios.length > 1 ? 's' : ''}…`);
  try {
    const res = await apiFetch('/api/ai/generate-testcases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarios, applicationName: appName, generationId: genId, ...aiOpts() }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    const newTcs = res.testcases || [];
    State.testcases = newTcs;
    renderTestCases();
    await selectTcGeneration(genId);
    updateRefLibraryWithTCs(newTcs);
    toast(`Regenerated ${newTcs.length} test cases for this generation`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

function exportScenariosJSON() {
  downloadJSON(State.scenarios, 'test-scenarios.json');
}

function exportScenariosCSV() {
  if (!State.scenarios.length) { toast('No scenarios to export', 'warn'); return; }
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const header = ['Scenario ID','Title','Module','Priority','Type','Tags','Description','Acceptance Criteria'].join(',');
  const rows = State.scenarios.map(s =>
    [q(s.id), q(s.title), q(s.module||''), q(s.priority||''), q(s.type||''),
     q((s.tags||[]).join('; ')), q(s.description||''),
     q((s.acceptance_criteria||[]).join('; '))].join(',')
  );
  const csv = [header, ...rows].join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'scenarios.csv');
  toast('Scenarios exported as CSV', 'success');
}

// ── CSV / Excel Import helpers ─────────────────────────────────────────────────

// Robust CSV parser: handles quoted fields, embedded commas, escaped quotes
function parseCSVToRows(text) {
  const rows = [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = [];
    let field = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQ && line[i + 1] === '"') { field += '"'; i++; }
        else inQ = !inQ;
      } else if (c === ',' && !inQ) {
        row.push(field.trim()); field = '';
      } else {
        field += c;
      }
    }
    row.push(field.trim());
    rows.push(row);
  }
  return rows;
}

// Lazy-load SheetJS from CDN (only for .xlsx/.xls)
function ensureXLSX() {
  if (window.XLSX) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/libs/xlsx.full.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load Excel parser. Check server is running.'));
    document.head.appendChild(s);
  });
}

// Parse a File object → array of string rows (first row = headers)
async function parseFileToRows(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    throw new Error('Unsupported file type. Please use .csv, .xlsx or .xls');
  }
  if (ext === 'csv') {
    const text = await file.text();
    return parseCSVToRows(text);
  }
  await ensureXLSX();
  const buf = await file.arrayBuffer();
  const wb  = XLSX.read(buf, { type: 'array' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })
    .map(r => r.map(c => String(c ?? '').trim()));
}

// Normalize header: lowercase, strip ALL non-alphanumeric characters.
// Handles spaces, underscores, hyphens, non-breaking spaces, smart quotes,
// invisible Unicode chars that Excel/CSV editors sometimes inject.
const normH = h => (h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Capitalize first letter, lowercase rest
const capFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : 'Medium';

// Build a helper that tries a list of normalized column names on a row
function makeGetter(headers) {
  return (row, ...names) => {
    for (const n of names) {
      const i = headers.indexOf(normH(n));
      if (i >= 0 && row[i] != null && String(row[i]).trim()) return String(row[i]).trim();
    }
    return '';
  };
}

// ── Step 2: Import Scenarios from CSV / Excel ──────────────────────────────────
async function importScenariosFile(event) {
  const file = event.target.files[0];
  event.target.value = '';    // allow re-selecting the same file
  if (!file) return;

  try {
    showLoading(`Parsing ${file.name}…`);
    const rows = await parseFileToRows(file);
    hideLoading();

    if (rows.length < 2) { toast('File has no data rows', 'warn'); return; }

    const headers = rows[0].map(normH);
    const get     = makeGetter(headers);

    // Running counter so imported IDs don't collide with existing ones
    let nextNum = State.scenarios.reduce((max, s) => {
      const n = parseInt((s.id || '').replace(/\D/g, ''));
      return isNaN(n) ? max : Math.max(max, n);
    }, 0) + 1;

    const imported = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.every(c => !c)) continue;

      const title    = get(r, 'scenario', 'title', 'name', 'description', 'test scenario') || '';
      const module   = get(r, 'module', 'feature', 'component', 'area', 'category')        || 'General';
      const priority = capFirst(get(r, 'priority') || 'Medium');
      const desc     = get(r, 'description', 'details', 'notes', 'overview')                || title;

      if (!title) continue;

      imported.push({
        id:          `S${String(nextNum++).padStart(3, '0')}`,
        title,
        module,
        priority,
        description: desc,
      });
    }

    if (!imported.length) {
      toast('No valid scenarios found. Make sure the file has a "Scenario" or "Title" column.', 'warn');
      return;
    }

    // Save to DB so data persists on refresh
    showLoading('Saving imported scenarios…');
    try {
      const saveRes = await apiFetch('/api/history/scenarios/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, title: `Imported — ${file.name}`, scenarios: imported }),
      }).then(r => r.json());
      hideLoading();
      if (saveRes.success) {
        State.currentGenerationId = saveRes.generationId;
        // Map DB rows back to frontend format (sc_id → id)
        State.scenarios = saveRes.scenarios.map(s => ({
          id: s.sc_id || s.id, title: s.title, module: s.module || '',
          description: s.description || '', type: s.type || 'functional',
          priority: s.priority || 'medium',
          tags: s.tags || [], acceptance_criteria: s.acceptance_criteria || [],
        }));
      } else {
        State.scenarios.push(...imported);
      }
    } catch (_) {
      hideLoading();
      State.scenarios.push(...imported);
    }
    State.selectedScenarioIds.clear();
    renderScenarios();
    markStepDone(2);
    goToStep(3);
    toast(`Imported ${imported.length} scenario${imported.length > 1 ? 's' : ''} ✓ saved`, 'success');
  } catch (err) {
    hideLoading();
    toast('Import failed: ' + err.message, 'error');
  }
}

// Download a CSV template for scenarios
function downloadScenarioTemplate() {
  const csv = [
    'Module,Scenario,Priority,Description',
    'Authentication,Admin Login,High,"Admin user can login with valid credentials"',
    'User Management,Create New User,Medium,"New user can be created by admin"',
    'API Access,Subscribe to API,High,"User can subscribe to a transactional API"',
  ].join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'scenarios-template.csv');
}

// ── Step 3: Import Test Cases from CSV / Excel ─────────────────────────────────
// Supported formats:
//   A) One row per STEP, grouped by TC ID (app's own export format):
//      TC ID | Title | Module | Priority | Preconditions | Expected Result | Step No | Action | Test Data | Step Expected Result
//   B) Flat (no steps): each row = one TC (Title, Module, Priority, …)
//   C) Xray-style: Action | Data | Expected Result (steps only, no title column)
async function importTestCasesFile(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;

  try {
    showLoading(`Parsing ${file.name}…`);
    xlog(4, `Importing: ${file.name}`, 'parse');
    const rows = await parseFileToRows(file);
    hideLoading();

    if (rows.length < 2) { toast('File has no data rows', 'warn'); return; }

    const rawHeaders = rows[0];
    const headers    = rawHeaders.map(normH);
    xlog(4, `${rows.length - 1} data row(s) · columns: ${rawHeaders.join(', ')}`, 'info');
    console.log('[Import] File:', file.name, '| Data rows:', rows.length - 1);
    console.log('[Import] Headers (raw):', rawHeaders);
    console.log('[Import] Headers (norm):', headers);

    const get = makeGetter(headers);

    // Detect if file has an action/step column (broad match)
    const hasActionCol = headers.some(h =>
      h === 'action' || h === 'stepaction' || h === 'teststep' || h === 'testaction' ||
      h === 'steps'  || h === 'step'       || h.includes('action')
    );
    console.log('[Import] hasActionCol:', hasActionCol);

    // Starting number so auto-generated IDs don't collide with existing ones
    let nextNum = State.testcases.reduce((max, t) => {
      const n = parseInt((t.id || '').replace(/\D/g, ''));
      return isNaN(n) ? max : Math.max(max, n);
    }, 0) + 1;

    // ── PASS 1: Group all rows into TC "buckets" ──────────────────────────────
    // A bucket collects the header data + all step rows for one test case.
    // Continuation rule: a row belongs to the previous TC if it has no new
    // title AND its TC-ID column is blank OR equal to the previous TC's ID.
    const buckets   = [];        // ordered list of buckets
    const bucketMap = new Map(); // rawId → bucket
    let lastRawId   = null;

    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.every(c => !c)) continue; // skip fully-blank rows

      const rawId_col = get(r, 'tc id', 'tcid', 'id', 'test id', 'testid', 'case id', 'tc no', 'tcno');
      const title     = get(r, 'title', 'name', 'test case', 'testcase', 'summary', 'test case name', 'testname', 'test case title');
      const action    = get(r, 'action', 'step action', 'stepaction', 'test step', 'teststep', 'test action', 'steps', 'step description', 'step');

      // A row is a continuation when: no new title AND TC ID is blank or same as last
      const isBlankOrSame  = !rawId_col || rawId_col === lastRawId;
      const isContinuation = lastRawId !== null && !title && isBlankOrSame;

      let rawId;
      if (isContinuation) {
        rawId = lastRawId;
      } else if (rawId_col) {
        rawId = rawId_col;
      } else {
        // Auto-assign: use title-based slug when possible, else TC###
        rawId = `TC${String(nextNum++).padStart(3, '0')}`;
      }
      lastRawId = rawId;

      console.log(`[Import] row ${i}: id="${rawId}" title="${title.substring(0,30)}" action="${action.substring(0,30)}" continuation=${isContinuation}`);

      // Create new bucket if first row for this TC
      if (!bucketMap.has(rawId)) {
        const bucket = {
          rawId,
          title:    title || '',
          module:   get(r, 'module', 'feature', 'component', 'area', 'category', 'suite') || '',
          priority: capFirst(get(r, 'priority') || 'Medium'),
          preRaw:   get(r, 'preconditions', 'precondition', 'prerequisites', 'precond')   || '',
          expRes:   get(r, 'expected result', 'expectedresult', 'expected', 'result',
                        'tc expected result', 'overall expected')                           || '',
          stepRows: [],
        };
        buckets.push(bucket);
        bucketMap.set(rawId, bucket);
      } else {
        // Patch missing TC-level fields from later rows with same ID
        const b = bucketMap.get(rawId);
        if (!b.title   && title)  b.title  = title;
        if (!b.module)  { const m = get(r, 'module', 'feature', 'component', 'area', 'category', 'suite'); if (m) b.module = m; }
        if (!b.expRes)  { const e = get(r, 'expected result', 'expectedresult', 'expected', 'result', 'tc expected result'); if (e) b.expRes = e; }
      }

      // Collect step data from this row (works for ALL rows including the first of a TC)
      if (hasActionCol && action) {
        const testData = get(r, 'test data', 'testdata', 'data', 'input', 'input data', 'inputdata') || '';
        // Step expected result: prefer dedicated column, fall back to "Expected Result"
        // (covers Xray-style CSVs where "Expected Result" IS the step-level result)
        const stepExp  = get(r,
          'step expected result', 'stepexpectedresult', 'step expected', 'stepresult', 'step result',
          'expected result',      'expectedresult'           // fallback for Xray / single-column files
        ) || '';
        bucketMap.get(rawId).stepRows.push({ action, testData, stepExp });
      }
    }

    console.log('[Import] Buckets:', buckets.length,
      buckets.map(b => ({ id: b.rawId, title: b.title, steps: b.stepRows.length })));

    // ── PASS 2: Build TC objects from buckets ─────────────────────────────────
    const newTcs = buckets.map(b => ({
      id:               b.rawId,
      // Fallback title: first action text (for Xray-only files that have no Title column)
      title:            b.title || (b.stepRows[0]?.action.substring(0, 80)) || 'Untitled',
      module:           b.module,
      priority:         b.priority,
      preconditions:    b.preRaw ? b.preRaw.split(/[;|]/).map(s => s.trim()).filter(Boolean) : [],
      expected_result:  b.expRes,
      steps:            b.stepRows.map((s, idx) => ({
        step_number:     idx + 1,
        action:          s.action,
        test_data:       s.testData,
        expected_result: s.stepExp,
      })),
      labels:           [],
      automation_notes: '',
      jira_fields:      { issue_type: '', priority: b.priority, labels: [], components: [] },
      status:           'draft',
    }));

    console.log('[Import] TCs ready:', newTcs.length,
      newTcs.map(t => ({ id: t.id, title: t.title, steps: t.steps.length })));

    if (!newTcs.length) {
      toast('No test cases found. Make sure the file has a "Title" or "Action" column.', 'warn');
      return;
    }

    // Save to DB so data persists on refresh
    showLoading('Saving imported test cases…');
    const totalSteps = newTcs.reduce((n, tc) => n + tc.steps.length, 0);
    try {
      const saveRes = await apiFetch('/api/history/test-cases/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, title: `Imported — ${file.name}`, testcases: newTcs }),
      }).then(r => r.json());
      hideLoading();
      if (saveRes.success) {
        State.currentGenerationId = saveRes.generationId;
        // Map DB rows back to frontend format (tc_id → id)
        State.testcases = saveRes.testcases.map(tc => ({
          id: tc.tc_id || tc.id, title: tc.title, module: tc.module || '',
          priority: tc.priority || 'Medium', type: tc.type || 'Functional',
          preconditions: tc.preconditions || [], steps: tc.steps || [],
          expected_result: tc.expected_result || '', automation_notes: tc.automation_notes || '',
          labels: tc.labels || [], status: tc.status || 'Not Executed',
          jira_fields: { issue_type: '', priority: tc.priority || 'Medium', labels: [], components: [] },
        }));
      } else {
        State.testcases.push(...newTcs);
      }
    } catch (_) {
      hideLoading();
      State.testcases.push(...newTcs);
    }
    renderTestCases();
    markStepDone(3);
    goToStep(4);
    xlog(4, `Import complete — ${newTcs.length} test case(s) · ${totalSteps} step(s)`, 'success');
    newTcs.forEach(tc => xlog(4, `${tc.id}: ${tc.title} (${tc.steps.length} steps)`, 'muted'));
    toast(`Imported ${newTcs.length} TC${newTcs.length > 1 ? 's' : ''} · ${totalSteps} step${totalSteps !== 1 ? 's' : ''} ✓ saved`, 'success');
  } catch (err) {
    hideLoading();
    console.error('[Import] Error:', err);
    xlog(4, `Import failed: ${err.message}`, 'error');
    toast('Import failed: ' + err.message, 'error');
  }
}

// Download a CSV template for test cases (shows multi-step grouping by TC ID)
function downloadTcTemplate() {
  const csv = [
    'TC ID,Title,Module,Priority,Preconditions,Expected Result,Step No,Action,Test Data,Step Expected Result',
    'TC001,Login as Admin,Authentication,High,User must be registered,User logs in and sees dashboard,1,Navigate to app URL,https://app.com,Login page is displayed',
    'TC001,,,,,, 2,Enter valid credentials,admin@test.com / Pass123,Credentials accepted',
    'TC001,,,,,, 3,Click Login button,,Dashboard is displayed',
    'TC002,Logout from app,Authentication,Medium,User is logged in,User is redirected to login page,1,Click the logout button,,Confirmation dialog shown',
    'TC002,,,,,, 2,Confirm logout,,User redirected to login page',
    'TC003,Subscribe to API,API Access,High,,Subscription confirmed,1,Open API Marketplace,,Marketplace loads',
    'TC003,,,,,, 2,Select Transactional API,,API detail page shown',
    'TC003,,,,,, 3,Click Subscribe,SP - Unregistered User,Login page shown',
  ].join('\r\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'testcases-template.csv');
}

// ── Step 2 → 3: Generate Test Cases ───────────────────────────────────────────
async function generateTestCases() {
  // If a generation is selected in history and user has checked scenarios there,
  // delegate to the history-aware path which fetches fresh data and filters properly.
  if (HistState.selectedScenGenId && HistState.checkedScenIds.size > 0 && !State.selectedScenarioIds.size) {
    return generateTcsFromHistory(HistState.selectedScenGenId);
  }

  if (!State.scenarios.length) { toast('No scenarios available', 'warn'); return; }

  // Use only checked scenarios; if none checked, use ALL
  const selectedIds = getSelectedScenarioIds();
  const scenariosToUse = selectedIds
    ? State.scenarios.filter(s => selectedIds.includes(s.id))
    : State.scenarios;

  if (!scenariosToUse.length) { toast('No matching scenarios found', 'warn'); return; }

  const label = selectedIds
    ? `${scenariosToUse.length} selected scenario${scenariosToUse.length > 1 ? 's' : ''}`
    : `all ${scenariosToUse.length} scenarios`;

  showLoading(`Generating test cases for ${label}…`);
  xlog(4, `Generating test cases for ${label}…`, 'ai');
  try {
    const res = await apiFetch('/api/ai/generate-testcases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenarios: scenariosToUse,
        applicationName: document.getElementById('appName').value || 'Web Application',
        baseUrl: document.getElementById('baseUrl').value || 'https://your-app.com',
        generationName: State.currentGenerationName || document.getElementById('generationName')?.value?.trim(),
        generationId: State.currentGenerationId || null,
        tcOffset: State.testcases.length,  // continue numbering from existing TCs
        ...aiOpts(),
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);

    // Track the generation ID for subsequent appends and history selection
    if (res.generationId) State.currentGenerationId = res.generationId;

    // Append to existing test cases instead of replacing — so generating
    // for a subset of scenarios accumulates results across multiple runs.
    const existingCount = State.testcases.length;
    const newTcs = res.testcases || [];
    State.testcases = [...State.testcases, ...newTcs];

    const totalSteps = newTcs.reduce((n, tc) => n + (tc.steps?.length || 0), 0);
    xlog(4, `+${newTcs.length} new test cases · ${totalSteps} steps — total now: ${State.testcases.length}`, 'success');

    renderTestCases();
    showWarnings(res.warnings, 'tcWarnings');
    markStepDone(3);
    goToStep(4);
    // Auto-select the current generation in the TC history panel so cards are visible
    const genToSelect = State.currentGenerationId || res.generationId;
    if (genToSelect) {
      setTimeout(() => selectTcGeneration(genToSelect), 300);
    }
    const msg = existingCount
      ? `+${newTcs.length} new test cases added (total: ${State.testcases.length}) from ${label}`
      : `${newTcs.length} test cases generated from ${label}`;
    toast(msg, 'success');
    renderWorkflowPipeline();
    updateRefLibraryWithTCs(State.testcases);
  } catch (e) {
    xlog(4, `Generation failed: ${e.message}`, 'error');
    toast(e.message, 'error');
  } finally { hideLoading(); }
}

// ── Render Test Cases ──────────────────────────────────────────────────────────
function renderTestCases() {
  const tcs = State.testcases;
  document.getElementById('tcCount').textContent = tcs.length;
  document.getElementById('statTotal').textContent   = tcs.length;
  document.getElementById('statCritical').textContent = tcs.filter(t => t.priority === 'Critical').length;
  document.getElementById('statHigh').textContent     = tcs.filter(t => t.priority === 'High').length;
  document.getElementById('statMedLow').textContent   = tcs.filter(t => ['Medium','Low'].includes(t.priority)).length;

  const tbody = document.getElementById('tcTableBody');
  if (!tcs.length) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-dim);padding:40px">No test cases yet.</td></tr>`;
    updateTcSelectionCount();
    return;
  }

  tbody.innerHTML = tcs.map(tc => `
    <tr>
      <td style="padding:10px 8px;width:36px"><input type="checkbox" class="tc-select-cb" value="${tc.id}" onchange="updateTcSelectionCount()" /></td>
      <td class="tc-id">${tc.id}</td>
      <td>${tc.title}</td>
      <td>${tc.module || '—'}</td>
      <td><span class="tag priority-${tc.priority?.toLowerCase()}">${tc.priority}</span></td>
      <td>${tc.type || '—'}</td>
      <td>${tc.steps?.length || 0} steps</td>
      <td><span class="status-badge not-executed">${tc.status || 'Not Executed'}</span></td>
      <td style="white-space:nowrap">
        <div style="display:flex;gap:4px;align-items:center">
          <button class="btn btn-outline btn-sm" onclick="viewTc('${tc.id}')">View</button>
          <button class="btn btn-outline btn-sm" onclick="editTc('${tc.id}')">✏</button>
          <button class="btn btn-outline btn-sm" onclick="selectTcForAgent('${tc.id}')" title="Automate with Browser Agent" style="color:#f4c869;border-color:rgba(244,200,105,.3)">🤖</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTc('${tc.id}')">✕</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function viewTc(id) {
  const tc = State.testcases.find(t => t.id === id);
  if (!tc) return;
  document.getElementById('tcModalTitle').textContent = `${tc.id} — ${tc.title}`;
  document.getElementById('tcModalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
      <div><span style="color:var(--text-muted);font-size:11px">MODULE</span><br>${tc.module || '—'}</div>
      <div><span style="color:var(--text-muted);font-size:11px">PRIORITY</span><br><span class="tag priority-${tc.priority?.toLowerCase()}">${tc.priority}</span></div>
      <div><span style="color:var(--text-muted);font-size:11px">TYPE</span><br>${tc.type}</div>
      <div><span style="color:var(--text-muted);font-size:11px">STATUS</span><br>${tc.status}</div>
    </div>
    ${tc.preconditions?.length ? `<div style="margin-bottom:12px"><div class="form-label">Preconditions</div>${tc.preconditions.map(p=>`<div>• ${p}</div>`).join('')}</div>` : ''}
    <div style="margin-bottom:12px">
      <div class="form-label">Test Steps</div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:var(--bg)">
          <th style="padding:6px 8px;border:1px solid var(--border);text-align:left">#</th>
          <th style="padding:6px 8px;border:1px solid var(--border);text-align:left">Action</th>
          <th style="padding:6px 8px;border:1px solid var(--border);text-align:left">Test Data</th>
          <th style="padding:6px 8px;border:1px solid var(--border);text-align:left">Expected Result</th>
        </tr></thead>
        <tbody>${(tc.steps||[]).map(s=>`
          <tr>
            <td style="padding:6px 8px;border:1px solid var(--border)">${s.step_number}</td>
            <td style="padding:6px 8px;border:1px solid var(--border)">${s.action}</td>
            <td style="padding:6px 8px;border:1px solid var(--border);color:var(--text-muted)">${s.test_data||'—'}</td>
            <td style="padding:6px 8px;border:1px solid var(--border)">${s.expected_result}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="margin-bottom:8px"><span class="form-label">Expected Result</span><br>${tc.expected_result}</div>
    ${tc.automation_notes ? `<div><span class="form-label">Automation Notes</span><br><code style="font-size:11px;color:var(--primary)">${tc.automation_notes}</code></div>` : ''}
  `;
  document.getElementById('tcModal').style.display = 'flex';
  document.getElementById('tcModalEditBtn').onclick = () => { closeTcModal(); editTc(id); };
}

function closeTcModal() { document.getElementById('tcModal').style.display = 'none'; }
function closeTcModalOutside(e) { if (e.target === document.getElementById('tcModal')) closeTcModal(); }

// ── TC Selection helpers ───────────────────────────────────────────────────────
function toggleSelectAllTcs(cb) {
  document.querySelectorAll('.tc-select-cb').forEach(c => c.checked = cb.checked);
  updateTcSelectionCount();
}

function selectAllTcs() {
  const master = document.getElementById('selectAllTcsCb');
  if (master) master.checked = true;
  document.querySelectorAll('.tc-select-cb').forEach(c => c.checked = true);
  updateTcSelectionCount();
}

function clearTcSelection() {
  const master = document.getElementById('selectAllTcsCb');
  if (master) master.checked = false;
  document.querySelectorAll('.tc-select-cb').forEach(c => c.checked = false);
  updateTcSelectionCount();
}

function updateTcSelectionCount() {
  const checked = document.querySelectorAll('.tc-select-cb:checked').length;
  const total   = document.querySelectorAll('.tc-select-cb').length;
  const el = document.getElementById('tcSelectionCount');
  if (el) el.textContent = checked > 0 ? `${checked} of ${total}` : total > 0 ? `0 of ${total}` : '0';
  // sync master checkbox
  const master = document.getElementById('selectAllTcsCb');
  if (master && total > 0) {
    master.checked = checked === total;
    master.indeterminate = checked > 0 && checked < total;
  }
}

function getSelectedTcIds() {
  const ids = [...document.querySelectorAll('.tc-select-cb:checked')].map(cb => cb.value);
  return ids.length ? ids : null; // null means "use all"
}

function populateJiraFields(force = false) {
  // Pre-fill Step-3 inline Jira fields from saved settings
  // force=true  → overwrite even if the field already has a value
  // force=false → only fill empty fields
  const map = {
    jiraUrl:          'jiraUrl',
    jiraEmail:        'jiraEmail',
    jiraToken:        'jiraToken',
    jiraProjectKey:   'jiraProjectKey',
    jiraTestType:     'jiraTestType',
    jiraTestPath:     'jiraTestPath',
    jiraLabels:       'jiraLabels',
    xrayClientId:     'xrayClientId',
    xrayClientSecret: 'xrayClientSecret',
  };
  Object.entries(map).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el && (force || !el.value)) el.value = getSetting(key) || '';
  });
}

function toggleJiraConfig() {
  const panel = document.getElementById('jiraConfigPanel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  if (!open) populateJiraFields(); // populate when opening
  panel.style.display = open ? 'none' : '';
  const btn = document.querySelector('[onclick="toggleJiraConfig()"]');
  if (btn) btn.textContent = open ? '⚙ Config ▾' : '⚙ Config ▴';
}

function openJiraConfig() {
  const panel = document.getElementById('jiraConfigPanel');
  if (panel && panel.style.display === 'none') toggleJiraConfig();
}

async function exportTcCsv() {
  // Block if no test cases exist at all
  if (!State.testcases.length) {
    toast('No test cases to export. Generate or import test cases first.', 'warn');
    return;
  }

  // Collect checked TC IDs from the table
  const checkedIds = [...document.querySelectorAll('.tc-select-cb:checked')].map(cb => cb.value);

  let tcsToExport;
  if (checkedIds.length > 0) {
    // Export only selected
    tcsToExport = State.testcases.filter(tc => checkedIds.includes(tc.id));
  } else {
    // No selection — ask user
    const confirmed = confirm(
      `No test cases selected.\n\nExport all ${State.testcases.length} test case${State.testcases.length > 1 ? 's' : ''}?\n\nTip: Tick checkboxes in the table to export specific test cases.`
    );
    if (!confirmed) return;
    tcsToExport = State.testcases;
  }

  showLoading(`Exporting ${tcsToExport.length} test case${tcsToExport.length > 1 ? 's' : ''}…`);
  try {
    const res = await apiFetch('/api/ai/export-jira-csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testcases: tcsToExport }),
    });
    const blob = await res.blob();
    downloadBlob(blob, 'jira-testcases.csv');
    toast(`Exported ${tcsToExport.length} test case${tcsToExport.length > 1 ? 's' : ''} as CSV`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

function exportTcJson() {
  downloadJSON(State.testcases, 'testcases.json');
}

// ── Step 3 → 4: Generate Playwright Scripts ────────────────────────────────────
async function generatePlaywright() {
  if (!State.testcases.length) { toast('No test cases available', 'warn'); return; }
  showLoading('Generating Playwright JavaScript tests with AI…');
  xlog(6, `Generating Playwright tests for ${State.testcases.length} test case(s)…`, 'ai');
  try {
    const res = await apiFetch('/api/ai/generate-playwright', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testcases: State.testcases,
        baseUrl: document.getElementById('baseUrl').value || 'https://your-app.com',
        applicationName: document.getElementById('appName').value || 'App',
        repoPath: document.getElementById('agentRepoPath')?.value?.trim() || getSetting('autoRepoPath') || '',
        ...aiOpts(),
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    State.playwrightFiles = res.files || [];

    xlog(6, `${State.playwrightFiles.length} Playwright file(s) generated ✓`, 'success');
    State.playwrightFiles.forEach(f => xlog(6, f.path, 'muted'));

    renderFileTree();
    markStepDone(6);
    goToStep(6);
    toast(`${State.playwrightFiles.length} files generated`, 'success');
  } catch (e) {
    xlog(6, `Generation failed: ${e.message}`, 'error');
    toast(e.message, 'error');
  } finally { hideLoading(); }
}

// ── Render File Tree ───────────────────────────────────────────────────────────
function renderFileTree() {
  const tree = document.getElementById('fileTree');
  tree.innerHTML = State.playwrightFiles.map((f, i) => {
    const icon = f.path.endsWith('.spec.js') ? '🧪' : f.path.endsWith('.js') ? '📘' : '📄';
    return `<li class="file-tree-item${i === 0 ? ' active' : ''}" onclick="previewFile(${i}, this)">
      ${icon} ${f.path}
    </li>`;
  }).join('');
  if (State.playwrightFiles.length) previewFile(0, tree.firstElementChild);
}

function previewFile(idx, el) {
  const file = State.playwrightFiles[idx];
  if (!file) return;
  document.querySelectorAll('.file-tree-item').forEach(i => i.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('previewFileName').textContent = file.path;
  document.getElementById('codeFileLabel').textContent = file.path;
  const codeEl = document.getElementById('codeContent');
  codeEl.textContent = file.content;
  Prism.highlightElement(codeEl);
}

function copyCode() {
  const active = State.playwrightFiles.find((_, i) => {
    const el = document.querySelectorAll('.file-tree-item')[i];
    return el && el.classList.contains('active');
  });
  const content = active?.content || document.getElementById('codeContent').textContent;
  navigator.clipboard.writeText(content).then(() => toast('Code copied', 'success'));
}

// ── Demo requirements loader ──────────────────────────────────────────────────
async function loadDemoRequirements(target) {
  try {
    const res  = await fetch('/demo/demo-requirements.txt');
    if (!res.ok) throw new Error('Demo file not found');
    const text = await res.text();

    if (target === 'quick') {
      // Step 1 quick card
      const el = document.getElementById('orchQuickInput');
      if (el) { el.value = text; el.dispatchEvent(new Event('input')); }
    } else {
      // Step 2 requirements tab — switch to that tab first
      const tab = document.querySelector('[onclick*="requirements"]');
      if (tab && !tab.classList.contains('active')) tab.click();
      const el = document.getElementById('requirements');
      if (el) { el.value = text; el.dispatchEvent(new Event('input')); }
    }
    toast('Demo requirements loaded — only 3 test cases will be generated', 'success');
  } catch (e) {
    toast('Could not load demo file: ' + e.message, 'error');
  }
}

// ── Playwright Run Terminal ───────────────────────────────────────────────────
function _pwTermLine(text, level) {
  const term = document.getElementById('pwRunTerminal');
  if (!term) return;
  const colours = { info:'#8ca0b8', output:'#d0d6e0', error:'#e0786b', success:'#7fcf8f', warn:'#f4c869' };
  const span = document.createElement('span');
  span.style.cssText = `color:${colours[level] || colours.output};display:block`;
  span.textContent = text;
  term.appendChild(span);
  term.scrollTop = term.scrollHeight;
}

async function runPlaywrightScripts() {
  if (!State.playwrightFiles.length) { toast('No generated files to run — generate first', 'warn'); return; }

  // Show & clear terminal
  const card  = document.getElementById('pwRunCard');
  const term  = document.getElementById('pwRunTerminal');
  const badge = document.getElementById('pwRunBadge');
  const btn   = document.getElementById('btnRunTests');
  if (card)  { card.style.display = ''; }
  if (term)  { term.innerHTML = ''; }
  if (badge) { badge.textContent = '⏳ Running…'; badge.style.color = '#f4c869'; }
  if (btn)   { btn.disabled = true; btn.textContent = '⏳ Running…'; }
  card?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const r = await apiFetch('/api/playwright/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: State.playwrightFiles, clientId: State.clientId }),
    }).then(res => res.json());

    if (!r.success) {
      toast(r.error || 'Run failed to start', 'error');
      if (badge) badge.textContent = '✗ Error';
      if (btn)   { btn.disabled = false; btn.textContent = '▶ Run Tests'; }
    }
    // Actual output streamed via WS → pw_run_line / pw_run_done handlers
  } catch (e) {
    toast(e.message, 'error');
    if (badge) { badge.textContent = '✗ Error'; badge.style.color = '#e0786b'; }
    if (btn)   { btn.disabled = false; btn.textContent = '▶ Run Tests'; }
  }
}

function clearPlaywrightFiles() {
  if (!State.playwrightFiles.length) { toast('No files to clear', 'warn'); return; }
  if (!confirm(`Clear all ${State.playwrightFiles.length} generated file(s)?`)) return;
  State.playwrightFiles = [];
  // Reset file tree and code preview
  const tree = document.getElementById('fileTree');
  if (tree) tree.innerHTML = '<li style="color:var(--text-dim);padding:20px;text-align:center">No files yet. Click Generate Playwright above.</li>';
  const codeContent = document.getElementById('codeContent');
  if (codeContent) codeContent.textContent = '// Select a file from the tree to preview its content';
  const previewFileName = document.getElementById('previewFileName');
  if (previewFileName) previewFileName.textContent = 'Code Preview';
  const codeFileLabel = document.getElementById('codeFileLabel');
  if (codeFileLabel) codeFileLabel.textContent = 'Select a file';
  toast('Generated files cleared', 'success');
}

async function downloadPlaywright() {
  if (!State.playwrightFiles.length) { toast('No files to download', 'warn'); return; }
  showLoading('Packaging ZIP…');
  try {
    const res = await apiFetch('/api/playwright/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: State.playwrightFiles, projectName: 'playwright-tests' }),
    });
    const blob = await res.blob();
    downloadBlob(blob, 'playwright-tests.zip');
    toast('playwright-tests.zip downloaded', 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

async function saveToLocal() {
  if (!State.playwrightFiles.length) { toast('No files to save', 'warn'); return; }
  showLoading('Saving to playwright-tests/generated/…');
  try {
    const res = await apiFetch('/api/playwright/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: State.playwrightFiles }),
    }).then(r => r.json());
    toast(`Saved ${res.saved?.length} files to ${res.directory}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

// ── Step 5: Trigger Pipeline ───────────────────────────────────────────────────
async function triggerPipeline() {
  const glUrl          = document.getElementById('glUrl').value || getSetting('glUrl') || 'https://gitlab.com';
  const projectId      = document.getElementById('glProjectId').value || getSetting('glProjectId');
  const triggerToken   = document.getElementById('glTriggerToken').value || getSetting('glTriggerToken');
  const branch         = document.getElementById('glBranch').value || 'main';
  const varsRaw        = document.getElementById('glVars').value;

  if (!projectId || !triggerToken) { toast('Project ID and Trigger Token are required', 'error'); return; }

  let variables = {};
  try { if (varsRaw) variables = JSON.parse(varsRaw); } catch { toast('Pipeline Variables must be valid JSON', 'error'); return; }

  showLoading('Triggering GitLab pipeline…');
  xlog(7, `Triggering pipeline on branch "${branch}"…`, 'progress');
  try {
    const res = await apiFetch('/api/gitlab/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gitlabUrl: glUrl, projectId, triggerToken, branch, variables }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    const p = res.pipeline;
    State.lastPipelineId = p.id;
    State.lastPipelineWebUrl = p.web_url;
    updatePipelineUI(p);
    document.getElementById('btnRefreshPipeline').style.display = '';
    if (p.web_url) {
      const link = document.getElementById('pipelineWebUrl');
      link.href = p.web_url;
      link.style.display = '';
    }
    xlog(7, `Pipeline #${p.id} triggered — status: ${p.status}`, 'success');
    if (p.web_url) xlog(7, p.web_url, 'muted');
    toast(`Pipeline #${p.id} triggered`, 'success');
    markStepDone(7);
  } catch (e) {
    xlog(7, `Pipeline trigger failed: ${e.message}`, 'error');
    toast(e.message, 'error');
  } finally { hideLoading(); }
}

async function refreshPipeline() {
  if (!State.lastPipelineId) return;
  const glUrl     = document.getElementById('glUrl').value || 'https://gitlab.com';
  const projectId = document.getElementById('glProjectId').value;
  try {
    const res = await fetch(`/api/gitlab/pipeline/${State.lastPipelineId}?gitlabUrl=${glUrl}&projectId=${projectId}`).then(r => r.json());
    if (res.success) updatePipelineUI(res.pipeline);
  } catch {}
}

function updatePipelineUI(p) {
  document.getElementById('pipelineId').textContent = `#${p.id}`;
  document.getElementById('pipelineDuration').textContent = p.duration ? `${p.duration}s` : '—';
  const el = document.getElementById('psValue');
  el.textContent = p.status;
  el.className = `ps-value ${p.status === 'success' ? 'success' : p.status === 'failed' ? 'failed' : p.status === 'running' ? 'running' : 'pending'}`;
}

// ── Jira helpers ──────────────────────────────────────────────────────────────
function getJiraCfg() {
  // Inline Step-3 fields take priority; fall back to saved settings
  return {
    jiraUrl:         document.getElementById('jiraUrl')?.value          || getSetting('jiraUrl'),
    jiraEmail:       document.getElementById('jiraEmail')?.value        || getSetting('jiraEmail'),
    jiraToken:       document.getElementById('jiraToken')?.value        || getSetting('jiraToken'),
    jiraTestType:    document.getElementById('jiraTestType')?.value     || getSetting('jiraTestType')     || 'Test Xray',
    jiraTestPath:    document.getElementById('jiraTestPath')?.value     || getSetting('jiraTestPath')     || '',
    jiraLabels:      document.getElementById('jiraLabels')?.value       || getSetting('jiraLabels')       || '',
    xrayClientId:    document.getElementById('xrayClientId')?.value     || getSetting('xrayClientId')     || '',
    xrayClientSecret:document.getElementById('xrayClientSecret')?.value || getSetting('xrayClientSecret') || '',
  };
}

function getJiraProjectKey() {
  return document.getElementById('jiraProjectKey')?.value || getSetting('jiraProjectKey');
}

function validateJiraCfg() {
  populateJiraFields(); // ensure fields are filled from settings
  const cfg = getJiraCfg();
  const pk  = getJiraProjectKey();
  const missing = [];
  if (!cfg.jiraUrl)   missing.push('Jira Base URL');
  if (!cfg.jiraEmail) missing.push('Email');
  if (!cfg.jiraToken) missing.push('API Token');
  if (!pk)            missing.push('Project Key');
  if (missing.length) {
    openJiraConfig();
    toast(`Fill in Jira config: ${missing.join(', ')}`, 'error');
    return false;
  }
  return true;
}

// ── Step 5: Jira Publisher — unified TC selection ─────────────────────────────
// Checks BOTH selection systems and returns { tcs, source, count }
function _getJiraTcsToUpload() {
  // Priority 1: history panel selections (HistState.checkedTcIds — DB UUIDs)
  if (HistState.checkedTcIds && HistState.checkedTcIds.size > 0) {
    const tcs = [...HistState.checkedTcIds]
      .map(id => window._histTcCache?.[id])
      .filter(Boolean)
      .map(tc => ({
        id:               tc.tc_id || tc.id,
        title:            tc.title || '',
        module:           tc.module || '',
        priority:         tc.priority || 'Medium',
        type:             tc.type || 'Functional',
        preconditions:    tc.preconditions || [],
        steps:            tc.steps || [],
        expected_result:  tc.expected_result || '',
        labels:           tc.labels || [],
        automation_notes: tc.automation_notes || '',
        status:           tc.status || 'Not Executed',
        jira_fields:      { issue_type: '', priority: tc.priority || 'Medium', labels: [], components: [] },
      }));
    if (tcs.length) return { tcs, source: 'history', count: tcs.length };
  }

  // Priority 2: live TC table checkboxes (.tc-select-cb)
  const liveIds = getSelectedTcIds();
  if (liveIds) {
    const tcs = State.testcases.filter(tc => liveIds.includes(tc.id));
    if (tcs.length) return { tcs, source: 'editor', count: tcs.length };
  }

  // Priority 3: all TCs in State (nothing selected → upload all)
  return { tcs: State.testcases, source: 'all', count: State.testcases.length };
}

function _refreshJiraTcSummary() {
  const textEl = document.getElementById('jiraTcSummaryText');
  if (!textEl) return;

  const total = State.testcases.length;
  const histCount = HistState.checkedTcIds?.size || 0;

  if (!total && !histCount) {
    textEl.innerHTML = '⚠ No test cases loaded — <span class="lnk" onclick="goToStep(4)">go to Step 4 to generate or select test cases</span>';
    textEl.style.color = '#e0786b';
    return;
  }

  const { tcs, source, count } = _getJiraTcsToUpload();
  const names = tcs.slice(0, 4).map(tc => `<code style="font-size:10.5px">${escHtml(tc.id || tc.title?.slice(0,20) || '?')}</code>`).join(' · ');
  const extra = count > 4 ? ` <span style="color:var(--text-dim)">+${count - 4} more</span>` : '';

  if (source === 'history') {
    textEl.innerHTML = `<span style="color:#5dcaa5">✓ ${count} test case${count !== 1 ? 's' : ''} selected from history panel</span> — ${names}${extra}`;
  } else if (source === 'editor') {
    textEl.innerHTML = `<span style="color:#5dcaa5">✓ ${count} test case${count !== 1 ? 's' : ''} selected from editor</span> — ${names}${extra}`;
  } else {
    textEl.innerHTML = `<span style="color:#f4c869">All ${count} test case${count !== 1 ? 's' : ''} will be uploaded</span> <span style="color:var(--text-muted);font-size:11.5px">(select specific ones in Step 4 to narrow the upload)</span>`;
  }
  textEl.style.color = '';
}

// silent=true skips the confirmation dialog (used by Run All Agents pipeline)
async function bulkCreateTestCases({ silent = false } = {}) {
  if (!validateJiraCfg()) return;
  const pk = getJiraProjectKey();

  const { tcs: tcsToUpload, source } = _getJiraTcsToUpload();
  if (!tcsToUpload.length) { toast('No test cases to upload — generate or select test cases in Step 4', 'warn'); return; }

  // Confirmation dialog — skipped when called from the automated pipeline
  if (!silent) {
    const sourceLabel = source === 'history' ? 'from history panel'
                      : source === 'editor'  ? 'from editor selection'
                      : '(all — no specific selection)';
    const scope = source === 'all'
      ? `all ${tcsToUpload.length} test case${tcsToUpload.length !== 1 ? 's' : ''}`
      : `${tcsToUpload.length} selected test case${tcsToUpload.length !== 1 ? 's' : ''}`;
    if (!confirm(`Upload ${scope} ${sourceLabel} to Jira project "${pk}"?\n\nThis will create new Jira issues for each test case.`)) return;
  }

  const cfg = getJiraCfg();
  xlog(5, `Uploading ${tcsToUpload.length} test case(s) to Jira project ${pk}…`, 'upload');
  if (cfg.xrayClientId) xlog(5, 'Xray credentials present — steps + folder upload active', 'jira');
  else                  xlog(5, 'No Xray credentials — only Jira issues will be created', 'warn');
  showLoading(`Uploading ${tcsToUpload.length} test case${tcsToUpload.length > 1 ? 's' : ''} to Jira…`);
  try {
    const httpRes = await apiFetch('/api/jira/bulk-create-testcases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ testcases: tcsToUpload, projectKey: pk, cfg }),
    });

    // Guard against non-JSON (e.g. 404 HTML page)
    const contentType = httpRes.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      const text = await httpRes.text();
      throw new Error(`Server error ${httpRes.status}: ${text.slice(0, 120)}`);
    }

    const res = await httpRes.json();
    if (!res.success) throw new Error(res.error || 'Upload failed');

    appendJiraLog(`✅ Created ${res.created.length} | ❌ ${res.errors.length} errors`);
    xlog(5, `Jira upload complete — ${res.created.length} created, ${res.errors.length} errors`, res.errors.length ? 'warn' : 'success');
    res.created.forEach(c => {
      const stepTag   = c.stepsImported ? '🪜 steps ✓' : '🪜 steps —';
      const folderTag = c.folderSet     ? '📁 folder ✓' : '';
      const line = `  ✓ ${c.jiraKey}  (${c.tcId})  ${stepTag}  ${folderTag}`.trimEnd();
      appendJiraLog(line);
      xlog(5, `${c.jiraKey} — ${c.tcId} · ${stepTag} ${folderTag}`.trimEnd(), 'jira');
    });
    if (res.errors.length) {
      res.errors.forEach(e => appendJiraLog(`  ✗ ${e.tcId}: ${e.error}`));
      if (!res.created.length) throw new Error(`All uploads failed — see Activity Log for details`);
    }
    toast(`${res.created.length} test case${res.created.length !== 1 ? 's' : ''} uploaded to Jira`, 'success');
    markStepDone(4);
  } catch (e) { toast(e.message, 'error'); appendJiraLog(`❌ ${e.message}`); }
  finally { hideLoading(); }
}

// ── Create Bug Modal ──────────────────────────────────────────────────────────
let _bugScreenshotFiles = [];

function openCreateBugModal() {
  if (!validateJiraCfg()) return;

  // Show failed tests info
  const failed = State.testcases.filter(tc => tc.status === 'Failed');
  const infoEl = document.getElementById('bugModalFailedInfo');
  if (infoEl) {
    if (!failed.length) {
      infoEl.innerHTML = '⚠ No test cases currently marked as <strong>Failed</strong>. A bug will be created as a general defect.';
      infoEl.style.background = 'rgba(244,200,105,.07)';
      infoEl.style.borderColor = 'rgba(244,200,105,.3)';
      infoEl.style.color = '#f4c869';
    } else {
      infoEl.innerHTML = `🐛 Bug ticket will be created for <strong>${failed.length} failed test case${failed.length !== 1 ? 's' : ''}</strong>: ${
        failed.slice(0, 3).map(tc => `<code>${escHtml(tc.id || tc.title?.slice(0,20))}</code>`).join(', ')
      }${failed.length > 3 ? ` +${failed.length - 3} more` : ''}`;
      infoEl.style.background = 'rgba(224,120,107,.07)';
      infoEl.style.borderColor = 'rgba(224,120,107,.25)';
      infoEl.style.color = '#e0786b';
    }
  }

  // Reset fields
  document.getElementById('bugSummary').value = failed.length === 1
    ? `[BUG] ${failed[0].id || ''} ${failed[0].title || ''}`.trim()
    : failed.length > 1
      ? `[BUG] ${failed.length} automated test failures`
      : '[BUG] Defect found during testing';
  document.getElementById('bugDesc').value = failed.length
    ? `Bug found in automated test execution.\n\nFailed test cases:\n${failed.map(tc => `- ${tc.id || tc.title}: ${tc.expected_result || ''}`).join('\n')}`
    : '';
  document.getElementById('bugAssignee').value = '';
  document.getElementById('bugLabels').value = 'automation, bug';
  document.getElementById('bugPriority').value = 'High';
  _bugScreenshotFiles = [];
  _updateBugScreenshotUI();

  document.getElementById('createBugModal').style.display = 'flex';
}

function closeCreateBugModal() {
  document.getElementById('createBugModal').style.display = 'none';
}

function onBugScreenshotChange(e) {
  _bugScreenshotFiles = [...(e.target.files || [])];
  _updateBugScreenshotUI();
}

function clearBugScreenshots() {
  _bugScreenshotFiles = [];
  document.getElementById('bugScreenshotInput').value = '';
  _updateBugScreenshotUI();
}

function _updateBugScreenshotUI() {
  const display  = document.getElementById('bugScreenshotDisplay');
  const clearBtn = document.getElementById('bugScreenshotClearBtn');
  const listEl   = document.getElementById('bugScreenshotList');

  if (!_bugScreenshotFiles.length) {
    if (display)  display.textContent = 'Choose screenshots…';
    if (clearBtn) clearBtn.style.display = 'none';
    if (listEl)   listEl.innerHTML = '';
    return;
  }

  if (display)  display.textContent = `${_bugScreenshotFiles.length} file${_bugScreenshotFiles.length !== 1 ? 's' : ''} selected`;
  if (clearBtn) clearBtn.style.display = '';
  if (listEl) {
    listEl.innerHTML = _bugScreenshotFiles.map(f =>
      `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:6px;font-size:11px;color:var(--text-muted)">
        📎 ${escHtml(f.name)}
      </span>`
    ).join('');
  }
}

async function submitCreateBug() {
  const summary  = document.getElementById('bugSummary').value.trim();
  const desc     = document.getElementById('bugDesc').value.trim();
  const assignee = document.getElementById('bugAssignee').value.trim();
  const labels   = document.getElementById('bugLabels').value.split(',').map(l => l.trim()).filter(Boolean);
  const priority = document.getElementById('bugPriority').value;

  if (!summary) { toast('Summary is required', 'warn'); document.getElementById('bugSummary').focus(); return; }

  const pk     = getJiraProjectKey();
  const cfg    = getJiraCfg();
  const failed = State.testcases.filter(tc => tc.status === 'Failed');

  const btn = document.getElementById('bugCreateBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }

  try {
    // Create bug(s) — one per failed TC or a single general bug
    const targets = failed.length ? failed : [{ id: 'BUG', title: 'Defect', steps: [], expected_result: '' }];

    for (const tc of targets) {
      const fd = new FormData();
      fd.append('failedTest',   JSON.stringify({ ...tc, description: desc }));
      fd.append('projectKey',   pk);
      fd.append('summary',      summary);
      fd.append('assignee',     assignee);
      fd.append('labels',       JSON.stringify(labels));
      fd.append('priority',     priority);
      fd.append('description',  desc);
      fd.append('executionUrl', State.lastPipelineWebUrl || '');
      fd.append('cfg',          JSON.stringify(cfg));

      // Attach screenshots
      _bugScreenshotFiles.forEach((f, i) => fd.append(`screenshot_${i}`, f, f.name));

      const res = await apiFetch('/api/jira/create-bug', { method: 'POST', body: fd }).then(r => r.json());
      if (res.success) appendJiraLog(`🐛 Bug ${res.issue?.key || '?'} created for ${tc.id || tc.title}`);
      else             appendJiraLog(`❌ Failed for ${tc.id}: ${res.error || 'unknown error'}`);
    }

    toast(`Bug ticket${targets.length > 1 ? 's' : ''} created ✓`, 'success');
    closeCreateBugModal();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '🐛 Create Bug'; }
  }
}

// Legacy direct call (kept for any existing references)
async function createBugTickets() { openCreateBugModal(); }

// ── Result file picker helpers ────────────────────────────────────────────────
function onResultFileChange(e) {
  const file = e.target.files?.[0];
  const display = document.getElementById('resultFileNameDisplay');
  const clearBtn = document.getElementById('resultFileClearBtn');
  if (file) {
    if (display) display.textContent = file.name;
    if (clearBtn) clearBtn.style.display = '';
  }
}
function clearResultFile() {
  const input   = document.getElementById('resultFileInput');
  const display = document.getElementById('resultFileNameDisplay');
  const clearBtn = document.getElementById('resultFileClearBtn');
  if (input)   input.value = '';
  if (display) display.textContent = 'Choose file…';
  if (clearBtn) clearBtn.style.display = 'none';
}

async function uploadResults() {
  if (!validateJiraCfg()) return;
  const issueKey = document.getElementById('resultIssueKey').value.trim();
  if (!issueKey) { toast('Enter a Jira issue key (e.g. QA-123)', 'warn'); return; }

  const fileInput = document.getElementById('resultFileInput');
  const file = fileInput?.files?.[0];

  showLoading(file ? `Attaching ${file.name} to ${issueKey}…` : 'Uploading results…');
  try {
    let res;
    if (file) {
      // Send actual selected file as multipart form-data
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('issueKey', issueKey);
      fd.append('cfg', JSON.stringify(getJiraCfg()));
      res = await apiFetch('/api/jira/upload-attachment', {
        method: 'POST',
        body: fd,   // no Content-Type header — browser sets it with boundary
      }).then(r => r.json());
    } else {
      // Fall back: attach a JSON export of the current test cases
      const content = JSON.stringify({
        testcases: State.testcases,
        pipeline: State.lastPipelineId,
        timestamp: new Date().toISOString(),
      }, null, 2);
      res = await apiFetch('/api/jira/upload-attachment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ issueKey, content, filename: `test-results-${Date.now()}.json`, cfg: getJiraCfg() }),
      }).then(r => r.json());
    }
    if (!res.success) throw new Error(res.error);
    appendJiraLog(`📎 ${file ? file.name : 'test-results.json'} attached to ${issueKey}`);
    toast(`Attached to ${issueKey} ✓`, 'success');
    clearResultFile();
  } catch (e) { toast(e.message, 'error'); }
  finally { hideLoading(); }
}

async function testJiraConnection() {
  populateJiraFields();
  const cfg = getJiraCfg();
  const pk  = getJiraProjectKey();

  const banner = document.getElementById('jiraConnStatus');
  const btn    = document.getElementById('btnTestJira');

  // Show missing fields immediately (no network call needed)
  const missing = [];
  if (!cfg.jiraUrl)   missing.push('Jira URL');
  if (!cfg.jiraEmail) missing.push('Email');
  if (!cfg.jiraToken) missing.push('API Token');
  if (missing.length) {
    openJiraConfig();
    banner.style.display = '';
    banner.style.background = 'rgba(248,81,73,.12)';
    banner.style.color      = 'var(--danger)';
    banner.textContent = `⚠ Missing config: ${missing.join(', ')} — open ⚙ Config panel above to fill in.`;
    return;
  }

  btn.textContent = '⏳ Testing…';
  btn.disabled    = true;
  banner.style.display = '';
  banner.style.background = 'rgba(139,148,158,.1)';
  banner.style.color      = 'var(--text-muted)';
  banner.textContent      = 'Connecting to Jira…';

  try {
    const params = new URLSearchParams({ jiraUrl: cfg.jiraUrl, jiraEmail: cfg.jiraEmail, jiraToken: cfg.jiraToken, jiraProjectKey: pk });
    const res = await apiFetch(`/api/jira/test-connection?${params}`).then(r => r.json());

    if (res.success) {
      banner.style.background = 'rgba(63,185,80,.12)';
      banner.style.color      = 'var(--success)';
      banner.textContent      = `✅ ${res.message}`;
      appendJiraLog(`✅ Connection OK — ${res.message}`);
      setHeaderProject(res.project ? res.project.name : pk);
    } else {
      banner.style.background = 'rgba(248,81,73,.12)';
      banner.style.color      = 'var(--danger)';
      banner.textContent      = `❌ ${res.error}`;
      appendJiraLog(`❌ Connection failed: ${res.error}`);
      if (res.error.toLowerCase().includes('token') || res.error.toLowerCase().includes('credentials')) {
        openJiraConfig();
      }
    }
  } catch (e) {
    banner.style.background = 'rgba(248,81,73,.12)';
    banner.style.color      = 'var(--danger)';
    banner.textContent      = `❌ ${e.message}`;
  } finally {
    btn.textContent = '🔌 Test Connection';
    btn.disabled    = false;
  }
}

async function testXrayConnection() {
  const clientId     = document.getElementById('xrayClientId')?.value.trim();
  const clientSecret = document.getElementById('xrayClientSecret')?.value.trim();
  const banner       = document.getElementById('xrayConnStatus');
  const btn          = document.getElementById('btnTestXray');

  banner.style.display = '';

  if (!clientId || !clientSecret) {
    banner.style.background = 'rgba(248,81,73,.12)';
    banner.style.color      = 'var(--danger)';
    banner.textContent      = '⚠ Enter both Xray Client ID and Client Secret first.';
    return;
  }

  btn.textContent = '⏳ Testing…';
  btn.disabled    = true;
  banner.style.background = 'rgba(139,148,158,.1)';
  banner.style.color      = 'var(--text-muted)';
  banner.textContent      = 'Connecting to Xray Cloud…';

  try {
    const params = new URLSearchParams({ xrayClientId: clientId, xrayClientSecret: clientSecret });
    const res = await apiFetch(`/api/jira/test-xray?${params}`).then(r => r.json());

    if (res.success) {
      banner.style.background = 'rgba(63,185,80,.12)';
      banner.style.color      = 'var(--success)';
      banner.textContent      = `✅ ${res.message}`;
      appendJiraLog(`✅ Xray Auth OK — ${res.message}`);
    } else {
      banner.style.background = 'rgba(248,81,73,.12)';
      banner.style.color      = 'var(--danger)';
      banner.textContent      = `❌ ${res.error}`;
      appendJiraLog(`❌ Xray Auth failed: ${res.error}`);
    }
  } catch (e) {
    banner.style.background = 'rgba(248,81,73,.12)';
    banner.style.color      = 'var(--danger)';
    banner.textContent      = `❌ ${e.message}`;
  } finally {
    btn.textContent = '🔬 Test Xray Auth';
    btn.disabled    = false;
  }
}

function appendJiraLog(msg) {
  const log = document.getElementById('jiraLog');
  log.textContent += `\n[${new Date().toLocaleTimeString()}] ${msg}`;
  log.scrollTop = log.scrollHeight;
}

function showSummary() {
  toast(`Done! ${State.testcases.length} TCs | ${State.playwrightFiles.length} PW files | Pipeline #${State.lastPipelineId || 'N/A'}`, 'success');
}

// ── Settings ───────────────────────────────────────────────────────────────────
function openSettings() {
  loadSettings();
  document.getElementById('settingsModal').style.display = 'flex';
}
function closeSettings() { document.getElementById('settingsModal').style.display = 'none'; }
function closeSettingsOutside(e) { if (e.target === document.getElementById('settingsModal')) closeSettings(); }

const PROVIDER_META = {
  claude:  { label: 'Claude',  emoji: '🟣', keyField: 'settAnthropicKey', modelField: 'settModelClaude' },
  openai:  { label: 'ChatGPT', emoji: '🟢', keyField: 'settOpenaiKey',    modelField: 'settModelOpenai' },
  gemini:  { label: 'Gemini',  emoji: '🔵', keyField: 'settGeminiKey',    modelField: 'settModelGemini' },
  copilot: { label: 'Copilot', emoji: '⚡', keyField: 'settCopilotToken', modelField: 'settModelCopilot' },
  custom:  { label: 'Custom',  emoji: '🧩', keyField: 'settCustomKey',    modelField: 'settCustomModel', freeModel: true },
};

function selectProvider(provider) {
  State.settings.activeProvider = provider;
  // Update card highlight
  document.querySelectorAll('.provider-card').forEach(c =>
    c.classList.toggle('active', c.dataset.provider === provider));
  // Show correct fields
  ['claude','openai','gemini','copilot','custom'].forEach(p =>
    document.getElementById(`provider-fields-${p}`).style.display = p === provider ? '' : 'none');
}

function switchSettingsTab(id, el) {
  ['ai','gitlab','jira','figma','confluence'].forEach(t => {
    document.getElementById(`settings-${t}`).style.display = t === id ? '' : 'none';
  });
  document.querySelectorAll('#settingsModal .tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

function saveSettings() {
  const p = State.settings.activeProvider || 'copilot';
  State.settings = {
    ...State.settings,
    activeProvider: p,
    anthropicKey:   document.getElementById('settAnthropicKey').value,
    openaiKey:      document.getElementById('settOpenaiKey').value,
    geminiKey:      document.getElementById('settGeminiKey').value,
    copilotToken:   document.getElementById('settCopilotToken').value,
    modelClaude:    document.getElementById('settModelClaude').value,
    modelOpenai:    document.getElementById('settModelOpenai').value,
    modelGemini:    document.getElementById('settModelGemini').value,
    modelCopilot:   document.getElementById('settModelCopilot').value,
    customBaseUrl:    document.getElementById('settCustomBaseUrl').value,
    customKey:        document.getElementById('settCustomKey').value,
    customModel:      document.getElementById('settCustomModel').value,
    customApiVersion: document.getElementById('settCustomApiVersion').value,
    glUrl:          document.getElementById('settGlUrl').value,
    glToken:        document.getElementById('settGlToken').value,
    glProjectId:    document.getElementById('settGlProjectId').value,
    glTriggerToken: document.getElementById('settGlTriggerToken').value,
    autoRepoPath:   document.getElementById('settAutoRepoPath').value,
    jiraUrl:        document.getElementById('settJiraUrl').value,
    jiraEmail:      document.getElementById('settJiraEmail').value,
    jiraToken:      document.getElementById('settJiraToken').value,
    jiraProjectKey: document.getElementById('settJiraProjectKey').value,
    figmaToken:     document.getElementById('settFigmaToken').value,
    confluenceBaseUrl: document.getElementById('settConfluenceBaseUrl').value,
  };
  localStorage.setItem('qahub_settings', JSON.stringify(State.settings));
  updateProviderBadge();
  populateJiraFields(); // keep Step-3 inline fields in sync
  _updateXrayPill();
  refreshHeaderProject(); // header project name follows the Jira connection
  closeSettings();
  toast('Settings saved', 'success');
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('qahub_settings') || '{}');
    State.settings = saved;
    // Restore simple text/password fields
    const fieldMap = {
      settAnthropicKey: 'anthropicKey', settOpenaiKey: 'openaiKey', settGeminiKey: 'geminiKey',
      settCopilotToken: 'copilotToken',
      settModelClaude: 'modelClaude',   settModelOpenai: 'modelOpenai', settModelGemini: 'modelGemini',
      settModelCopilot: 'modelCopilot',
      settCustomBaseUrl: 'customBaseUrl', settCustomKey: 'customKey',
      settCustomModel: 'customModel',    settCustomApiVersion: 'customApiVersion',
      settGlUrl: 'glUrl', settGlToken: 'glToken',
      settGlProjectId: 'glProjectId',   settGlTriggerToken: 'glTriggerToken',
      settAutoRepoPath: 'autoRepoPath',
      settJiraUrl: 'jiraUrl',           settJiraEmail: 'jiraEmail',
      settJiraToken: 'jiraToken',       settJiraProjectKey: 'jiraProjectKey',
      settFigmaToken: 'figmaToken',
      settConfluenceBaseUrl: 'confluenceBaseUrl',
    };
    Object.entries(fieldMap).forEach(([elId, key]) => {
      const el = document.getElementById(elId);
      if (el && saved[key]) el.value = saved[key];
    });
    // Restore active provider card + fields
    selectProvider(saved.activeProvider || 'copilot');
    updateProviderBadge();
  } catch {}
}

const MODEL_KEY     = { claude: 'modelClaude', openai: 'modelOpenai', gemini: 'modelGemini', copilot: 'modelCopilot', custom: 'customModel' };
const MODEL_DEFAULT = { claude: 'claude-opus-4-8', openai: 'gpt-4o', gemini: 'gemini-2.0-flash', copilot: 'claude-sonnet-4.6', custom: '' };

function persistSettings() {
  localStorage.setItem('qahub_settings', JSON.stringify(State.settings));
}

// Fill the header model dropdown by cloning the Settings <select> options for this
// provider — single source of truth, so header and Settings never drift.
function populateHeaderModels(provider) {
  const hdr = document.getElementById('hdrModel');
  if (!hdr) return;
  // Custom uses a free-text model (no fixed catalogue) — show the configured value.
  if (PROVIDER_META[provider].freeModel) {
    const m = getSetting(MODEL_KEY[provider]);
    hdr.innerHTML = `<option value="${m || ''}">${m || 'set in ⚙ Settings'}</option>`;
    hdr.disabled = true;   // change it in Settings → Custom
    return;
  }
  hdr.disabled = false;
  const src = document.getElementById(PROVIDER_META[provider].modelField);
  if (!src) return;
  hdr.innerHTML = src.innerHTML;
  hdr.value = getSetting(MODEL_KEY[provider]) || MODEL_DEFAULT[provider];
}

// Sync the header switcher (provider dropdown, model list, mode caption) to state.
// Named updateProviderBadge for back-compat with existing call sites.
function updateProviderBadge() {
  const p = State.settings.activeProvider || 'copilot';
  const hdrP = document.getElementById('hdrProvider');
  if (hdrP) hdrP.value = p;
  populateHeaderModels(p);
  // Keyless modes: Claude with no API key → local CLI; Copilot with no token → VS Code bridge.
  const usingCLI    = p === 'claude'  && !getSetting('anthropicKey');
  const usingBridge = p === 'copilot' && !getSetting('copilotToken');
  const mode = document.getElementById('hdrAiMode');
  if (mode) mode.textContent = usingCLI ? 'local CLI' : usingBridge ? 'VS Code' : p === 'custom' ? (getSetting('customApiVersion') ? 'Azure' : 'custom') : '';
}

// Header → change provider on the fly (also keeps the Settings modal in sync).
function onHeaderProviderChange(provider) {
  State.settings.activeProvider = provider;
  selectProvider(provider);      // toggles Settings modal cards/fields (present in DOM even when closed)
  updateProviderBadge();         // repopulates the model list + mode caption
  persistSettings();
}

// Header → change model on the fly for the active provider.
function onHeaderModelChange(model) {
  const p = State.settings.activeProvider || 'copilot';
  State.settings[MODEL_KEY[p]] = model;
  const src = document.getElementById(PROVIDER_META[p].modelField);
  if (src) src.value = model;    // keep the Settings modal select in sync
  updateProviderBadge();         // refresh mode caption (model doesn't change it, but harmless)
  persistSettings();
}

async function testClaudeCLI() {
  const dot  = document.getElementById('cliStatusDot');
  const text = document.getElementById('cliStatusText');
  dot.style.background  = 'var(--warn)';
  text.textContent      = 'Testing Claude Code CLI…';
  try {
    const res = await apiFetch('/api/ai/test-cli').then(r => r.json());
    if (res.ok) {
      dot.style.background = 'var(--success)';
      text.textContent     = `✅ Claude Code CLI available (${res.version || 'ready'})`;
    } else {
      throw new Error(res.error || 'CLI test failed');
    }
  } catch (err) {
    dot.style.background = 'var(--danger)';
    text.textContent     = `❌ ${err.message}`;
  }
}

async function testCopilotToken() {
  const dot  = document.getElementById('copilotStatusDot');
  const text = document.getElementById('copilotStatusText');
  dot.style.background  = 'var(--warn)';
  text.textContent      = 'Testing GitHub Copilot connection…';
  try {
    const token = document.getElementById('settCopilotToken').value;
    const res = await apiFetch('/api/ai/test-copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }).then(r => r.json());
    if (res.ok) {
      dot.style.background = 'var(--success)';
      text.textContent     = `✅ ${res.message || 'GitHub Copilot connected'}`;
    } else {
      throw new Error(res.error || 'Copilot test failed');
    }
  } catch (err) {
    dot.style.background = 'var(--danger)';
    text.textContent     = `❌ ${err.message}`;
  }
}

async function testCustomEndpoint() {
  const dot  = document.getElementById('customStatusDot');
  const text = document.getElementById('customStatusText');
  dot.style.background = 'var(--warn)';
  text.textContent     = 'Testing custom endpoint…';
  try {
    const res = await apiFetch('/api/ai/test-custom', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customBaseUrl:    document.getElementById('settCustomBaseUrl').value,
        customApiKey:     document.getElementById('settCustomKey').value,
        model:            document.getElementById('settCustomModel').value,
        customApiVersion: document.getElementById('settCustomApiVersion').value,
      }),
    }).then(r => r.json());
    if (res.ok) {
      dot.style.background = 'var(--success)';
      text.textContent     = `✅ ${res.message || 'Connected'}`;
    } else {
      throw new Error(res.error || 'Test failed');
    }
  } catch (err) {
    dot.style.background = 'var(--danger)';
    text.textContent     = `❌ ${err.message}`;
  }
}

function getSetting(key) { return State.settings[key] || ''; }

// Returns AI provider credentials for the currently selected provider.
function aiOpts() {
  const provider = getSetting('activeProvider') || 'copilot';
  const modelKey = { claude: 'modelClaude', openai: 'modelOpenai', gemini: 'modelGemini', copilot: 'modelCopilot', custom: 'customModel' }[provider];
  const defaults = { claude: 'claude-opus-4-8', openai: 'gpt-4o', gemini: 'gemini-2.0-flash', copilot: 'claude-sonnet-4.6', custom: '' };
  return {
    clientId:        CLIENT_ID,
    provider,
    model:           getSetting(modelKey) || defaults[provider],
    anthropicApiKey: getSetting('anthropicKey'),
    openaiApiKey:    getSetting('openaiKey'),
    geminiApiKey:    getSetting('geminiKey'),
    copilotToken:    getSetting('copilotToken'),
    // Custom / OpenAI-compatible endpoint
    customBaseUrl:    getSetting('customBaseUrl'),
    customApiKey:     getSetting('customKey'),
    customApiVersion: getSetting('customApiVersion'),
  };
}

function activeProviderKey() {
  const p = getSetting('activeProvider') || 'copilot';
  return { claude: 'anthropicKey', openai: 'openaiKey', gemini: 'geminiKey', copilot: 'copilotToken' }[p];
}

// ── Progress Bar Controller ────────────────────────────────────────────────────
const Progress = (() => {
  let _pct    = 0;
  let _timer  = null;
  let _driven = false; // true = WS is driving %, false = auto-advance

  const el = (id) => document.getElementById(id);

  function _set(pct) {
    _pct = Math.min(100, Math.max(0, pct));
    const p = Math.round(_pct);
    el('pgbarFill').style.width = p + '%';
    el('pgBar').style.width     = p + '%';
    el('pgPct').textContent      = p + '%';
  }

  function _show() {
    el('pgbarTrack').classList.add('active');
    el('pgCard').classList.add('show');
  }

  function _hide() {
    el('pgbarTrack').classList.remove('active');
    el('pgCard').classList.remove('show');
    // Reset bar after card slides out
    setTimeout(() => _set(0), 350);
  }

  // Step icon map — aligns with the work being done
  const ICONS = {
    scenarios:  '🎯',
    testcases:  '⚗️',
    playwright: '🎭',
    pipeline:   '🚀',
    jira:       '🔖',
    verify:     '🔍',
    orchestrat: '🤖',
    default:    '⚗️',
  };

  return {
    start(label = 'Processing…', step = '') {
      _driven = false;
      clearInterval(_timer);
      el('pgLabel').textContent = label;
      el('pgIcon').textContent  = ICONS[step] || ICONS.default;
      _set(0);
      _show();
      // Quick jump to 8% so the bar is visibly started
      setTimeout(() => _set(8), 60);
      // Auto-advance slowly up to 75% while waiting for WS signals
      _timer = setInterval(() => {
        if (!_driven && _pct < 75) _set(_pct + (Math.random() * 2.5 + 0.5));
      }, 1800);
    },

    update(label, pct) {
      el('pgLabel').textContent = label;
      if (pct != null) {
        _driven = true;
        clearInterval(_timer);
        _set(pct);
      }
    },

    done() {
      _driven = true;
      clearInterval(_timer);
      _set(100);
      setTimeout(_hide, 650);
    },

    setIcon(icon) { el('pgIcon').textContent = icon; },
  };
})();

// Keep existing call-sites unchanged
function showLoading(text = 'Processing…') {
  // Guess the step icon from the label text
  const step = /scenario/i.test(text) ? 'scenarios'
             : /test case/i.test(text) ? 'testcases'
             : /playwright/i.test(text) ? 'playwright'
             : /pipeline|gitlab/i.test(text) ? 'pipeline'
             : /jira/i.test(text) ? 'jira'
             : /verif/i.test(text) ? 'verify'
             : /orchestrat/i.test(text) ? 'orchestrat'
             : 'default';
  Progress.start(text, step);
}
function hideLoading() { Progress.done(); }

function toast(msg, type = 'info') {
  const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type]}</span><span>${msg}</span>`;
  document.getElementById('toast-container').prepend(el);
  setTimeout(() => el.remove(), 4000);
}

function markStepDone(n) {
  const item = document.querySelector(`.step-item[data-step="${n}"]`);
  if (item) item.classList.add('completed');
  // Mark the matching flow strip step as done
  const fstep = document.querySelector(`.fstep[data-s="${n - 1}"]`);
  if (fstep && !fstep.classList.contains('live')) fstep.classList.add('done');
}

// Show/hide the Xray "connected" pill in the header based on whether credentials exist
function _updateXrayPill() {
  const pill = document.getElementById('xrayStatusPill');
  if (!pill) return;
  const cfg = getJiraCfg();
  pill.style.display = (cfg.xrayClientId && cfg.xrayClientSecret) ? '' : 'none';
}

// Set the header project name. Source of truth is the Jira connection, so callers
// pass the project name/key returned by Jira. Falls back to the configured project
// key, then to a neutral placeholder when Jira isn't connected.
function setHeaderProject(name) {
  const label = document.getElementById('projectStatusLabel');
  if (!label) return;
  const project = (name || getJiraProjectKey() || '').trim();
  label.textContent = `Project · ${project || '—'}`;
}

// Resolve the project name straight from the Jira connection (display name when
// available, otherwise the project key) and reflect it in the header.
async function refreshHeaderProject() {
  const cfg = getJiraCfg();
  const pk  = getJiraProjectKey();
  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken || !pk) {
    setHeaderProject('');   // not connected → neutral placeholder
    return;
  }
  try {
    const params = new URLSearchParams({ jiraUrl: cfg.jiraUrl, jiraEmail: cfg.jiraEmail, jiraToken: cfg.jiraToken, jiraProjectKey: pk });
    const res = await apiFetch(`/api/jira/test-connection?${params}`).then(r => r.json());
    setHeaderProject(res.success && res.project ? res.project.name : pk);
  } catch {
    setHeaderProject(pk);   // offline / error → show the configured key
  }
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  downloadBlob(blob, filename);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Scenario Editing ──────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function addNewScenario() {
  // Block Add unless a generation is selected in history
  if (!HistState.selectedScenGenId && !State.currentGenerationId) {
    toast('Select a generation from the History panel on the left before adding a Scenario.', 'warn');
    return;
  }
  const maxNum = State.scenarios.reduce((max, s) => {
    const n = parseInt((s.id || '').replace(/\D/g, ''));
    return isNaN(n) ? max : Math.max(max, n);
  }, State.scenarios.length);
  openScenarioEditModal({
    id: `TS-${String(maxNum + 1).padStart(3, '0')}`,
    title: '', module: '', description: '', type: 'functional',
    priority: 'medium', tags: [], acceptance_criteria: [],
  }, true);
}

function editScenario(id) {
  const sc = State.scenarios.find(s => s.id === id);
  if (sc) openScenarioEditModal(sc, false);
}

let _scenModalCurrent = null;

function openScenarioEditModal(sc, isNew, mode = 'view') {
  _scenModalCurrent = sc;
  document.getElementById('scenarioEditTitle').textContent = sc.id || 'Test Scenario';
  // Populate edit fields
  document.getElementById('seOriginalId').value = sc.id;
  document.getElementById('seId').value         = sc.id;
  document.getElementById('seTitle').value      = sc.title || '';
  document.getElementById('seModule').value     = sc.module || '';
  document.getElementById('seDesc').value       = sc.description || '';
  document.getElementById('seType').value       = sc.type || 'functional';
  document.getElementById('sePriority').value   = sc.priority || 'medium';
  document.getElementById('seTags').value       = (sc.tags || []).join(', ');
  document.getElementById('seAC').value         = (sc.acceptance_criteria || []).join('\n');
  _scenModalSetMode(isNew ? 'edit' : mode);
  document.getElementById('scenarioEditModal').style.display = 'flex';
}

function _scenModalSetMode(mode) {
  const viewPane   = document.getElementById('scenModalViewPane');
  const editPane   = document.getElementById('scenModalEditPane');
  const viewBtn    = document.getElementById('scenModeViewBtn');
  const editBtn    = document.getElementById('scenModeEditBtn');
  const saveBtn    = document.getElementById('scenModalSaveBtn');
  const editToggle = document.getElementById('scenModalEditToggleBtn');

  if (mode === 'view') {
    viewPane.style.display = '';
    editPane.style.display = 'none';
    viewBtn.classList.add('active');
    editBtn.classList.remove('active');
    saveBtn.style.display = 'none';
    editToggle.style.display = '';
    if (_scenModalCurrent) renderScenViewPane(_scenModalCurrent);
  } else {
    viewPane.style.display = 'none';
    editPane.style.display = '';
    viewBtn.classList.remove('active');
    editBtn.classList.add('active');
    saveBtn.style.display = 'inline-flex';
    editToggle.style.display = 'none';
  }
}

function renderScenViewPane(sc) {
  const el = document.getElementById('scenModalViewPane');
  if (!el) return;
  const ac   = sc.acceptance_criteria || [];
  const tags = sc.tags || [];

  el.innerHTML = `
    <div style="padding:16px 0">
      <!-- Meta chips -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        ${sc.id ? `<span class="tsb" style="color:#6fd6c9;background:rgba(93,202,165,.14);border-color:rgba(93,202,165,.3)">${escHtml(sc.id)}</span>` : ''}
        ${sc.module ? `<span class="tg out">${escHtml(sc.module)}</span>` : ''}
        ${sc.priority ? `<span class="tg" style="color:#f4c869;border:1px solid rgba(244,200,105,.4)">${escHtml(sc.priority.toUpperCase())}</span>` : ''}
        ${sc.type ? `<span class="tg fn">${escHtml(sc.type.toUpperCase())}</span>` : ''}
      </div>

      <!-- Title -->
      <div style="font-size:15px;font-weight:600;color:#ece6d6;margin-bottom:18px;line-height:1.4">${escHtml(_cleanScenTitle(sc.title || ''))}</div>

      <!-- Description -->
      ${sc.description ? `
      <div class="tcv-section">
        <div class="tcv-head">Description</div>
        <div class="tcv-body">${escHtml(sc.description)}</div>
      </div>` : ''}

      <!-- Acceptance Criteria -->
      ${ac.length ? `
      <div class="tcv-section">
        <div class="tcv-head">Acceptance Criteria</div>
        <ol class="tcv-list">
          ${ac.map(a => `<li>${escHtml(String(a))}</li>`).join('')}
        </ol>
      </div>` : ''}

      <!-- Tags -->
      ${tags.length ? `
      <div class="tcv-section">
        <div class="tcv-head">Tags</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${tags.map(t => `<span class="tg out">${escHtml(t)}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>`;
}

function closeScenarioEditModal() { document.getElementById('scenarioEditModal').style.display = 'none'; }
function closeScenarioEditOutside(e) { if (e.target === document.getElementById('scenarioEditModal')) closeScenarioEditModal(); }

function saveScenario() {
  const title = document.getElementById('seTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const originalId = document.getElementById('seOriginalId').value;
  const updated = {
    id:                   document.getElementById('seId').value.trim() || originalId,
    title,
    module:               document.getElementById('seModule').value.trim(),
    description:          document.getElementById('seDesc').value.trim(),
    type:                 document.getElementById('seType').value,
    priority:             document.getElementById('sePriority').value,
    tags:                 document.getElementById('seTags').value.split(',').map(t => t.trim()).filter(Boolean),
    acceptance_criteria:  document.getElementById('seAC').value.split('\n').map(l => l.trim()).filter(Boolean),
  };

  const idx = State.scenarios.findIndex(s => s.id === originalId);
  if (idx === -1) {
    State.scenarios.push(updated);
    toast(`Scenario ${updated.id} added`, 'success');
  } else {
    State.scenarios[idx] = updated;
    toast(`Scenario ${updated.id} updated`, 'success');
  }

  closeScenarioEditModal();
  renderScenarios();

  // If editing from history, update the existing DB record (not import a new one)
  const histScenId = window._histEditScenId;
  const histGenId  = window._histEditGenId;
  if (histScenId) {
    apiFetch(`/api/history/scenarios/${histScenId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, ...updated }),
    }).then(r => r.json()).then(res => {
      if (res.success) {
        loadScenHistory();
        if (histGenId) selectScenGeneration(histGenId);
      }
    }).catch(() => {});
    window._histEditScenId = null;
    window._histEditGenId  = null;
    return;
  }

  // Otherwise, import as a new scenario under the selected generation
  const targetGenId = HistState.selectedScenGenId || State.currentGenerationId || null;
  apiFetch('/api/history/scenarios/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      title: targetGenId ? null : `Manual — ${new Date().toLocaleDateString()}`,
      generationId: targetGenId,
      scenarios: [updated],
    }),
  }).then(r => r.json()).then(res => {
    if (res.success) {
      if (!State.currentGenerationId) State.currentGenerationId = res.generationId;
      const genToRefresh = targetGenId || res.generationId;
      loadScenHistory();
      if (genToRefresh) selectScenGeneration(genToRefresh);
    }
  }).catch(() => {});
}

function deleteScenario(id) {
  if (!confirm(`Delete scenario ${id}?`)) return;
  State.scenarios = State.scenarios.filter(s => s.id !== id);
  renderScenarios();
  toast(`Scenario ${id} deleted`, 'success');
}

async function deleteSelectedScenarios() {
  const ids = [...HistState.checkedScenIds];
  if (!ids.length) { toast('No scenarios selected — tick some checkboxes first', 'warn'); return; }
  if (!confirm(`Delete ${ids.length} selected scenario${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  // Archive in DB
  await Promise.all(ids.map(id =>
    apiFetch(`/api/history/scenarios/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, status: 'archived' }),
    }).catch(() => {})
  ));
  // Also remove from local State if they match
  const cachedScIds = ids.map(id => window._histScenCache?.[id]?.sc_id).filter(Boolean);
  State.scenarios = State.scenarios.filter(s => !ids.includes(s.id) && !cachedScIds.includes(s.id));
  HistState.checkedScenIds.clear();
  renderScenarios();
  // Refresh history panel
  if (HistState.selectedScenGenId) await selectScenGeneration(HistState.selectedScenGenId);
  toast(`Deleted ${ids.length} scenario${ids.length > 1 ? 's' : ''}`, 'success');
}

async function deleteSelectedTestCases() {
  const ids = [...HistState.checkedTcIds];
  if (!ids.length) { toast('No test cases selected — tick some checkboxes first', 'warn'); return; }
  if (!confirm(`Delete ${ids.length} selected test case${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  // Archive in DB
  await Promise.all(ids.map(id =>
    apiFetch(`/api/history/test-cases/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, status: 'archived' }),
    }).catch(() => {})
  ));
  // Also remove from local State if they match
  const cachedTcIds = ids.map(id => window._histTcCache?.[id]?.tc_id).filter(Boolean);
  State.testcases = State.testcases.filter(t => !ids.includes(t.id) && !cachedTcIds.includes(t.id));
  HistState.checkedTcIds.clear();
  renderTestCases();
  // Refresh history panel
  if (HistState.selectedTcGenId) await selectTcGeneration(HistState.selectedTcGenId);
  toast(`Deleted ${ids.length} test case${ids.length > 1 ? 's' : ''}`, 'success');
}

// ── Test Case Editing ──────────────────────────────────────────────────────────

function addNewTestCase() {
  // Block Add unless a generation is selected in history
  const activeGenId = HistState.selectedTcGenId || State.currentGenerationId;
  if (!activeGenId) {
    toast('Select a generation from the History panel on the left before adding a Test Case.', 'warn');
    return;
  }
  // Also ensure there are scenarios to link against (skip check if working from history)
  if (!State.scenarios.length && !State.currentGenerationId && !HistState.selectedTcGenId) {
    toast('Generate or import Test Scenarios first before adding Test Cases.', 'warn');
    return;
  }

  // Derive prefix and next number from existing TCs (same logic as backend)
  let tcPrefix = 'TC';
  let tcPadding = 3;
  let maxNum = 0;

  if (State.testcases.length) {
    // Extract prefix by stripping trailing separator+digits
    const prefixes = State.testcases
      .map(t => (t.id || '').replace(/[-_]?\d+$/, ''))
      .filter(Boolean);
    if (prefixes.length) {
      const freq = {};
      prefixes.forEach(p => { freq[p] = (freq[p] || 0) + 1; });
      tcPrefix = Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }
    // Find max number among IDs with this prefix
    State.testcases.forEach(t => {
      const id = t.id || '';
      if (id.startsWith(tcPrefix)) {
        const m = id.match(/(\d+)$/);
        if (m) {
          maxNum = Math.max(maxNum, parseInt(m[1], 10));
          tcPadding = Math.max(tcPadding, m[1].length);
        }
      }
    });
  }

  // Ensure prefix ends with a separator
  const sep = tcPrefix.endsWith('-') || tcPrefix.endsWith('_') ? '' : '-';

  // Pre-fill module from the active scenario generation if available
  const firstScen = State.scenarios[0];
  openTcEditModal({
    id: `${tcPrefix}${sep}${String(maxNum + 1).padStart(tcPadding, '0')}`,
    scenario_id: firstScen?.id || '',
    title: '', module: firstScen?.module || '', priority: 'Medium', type: 'Functional',
    preconditions: [], steps: [{ step_number: 1, action: '', test_data: '', expected_result: '' }],
    expected_result: '', automation_notes: '', labels: [],
  }, true);
}

function editTc(id) {
  const tc = State.testcases.find(t => t.id === id);
  if (tc) openTcEditModal(tc, false);
}

// Store current TC for mode switching
let _tcModalCurrent = null;

function openTcEditModal(tc, isNew, mode = 'view') {
  _tcModalCurrent = tc;
  document.getElementById('tcEditTitle').textContent = tc.id || 'Test Case';
  // Populate edit fields
  document.getElementById('tceOriginalId').value    = tc.id;
  document.getElementById('tceId').value            = tc.id;
  document.getElementById('tceScenarioId').value    = tc.parent_sc_id || tc.scenario_id || '';
  document.getElementById('tceTitle').value         = tc.title || '';
  document.getElementById('tceModule').value        = tc.module || '';
  document.getElementById('tcePriority').value      = tc.priority || 'Medium';
  document.getElementById('tceType').value          = tc.type || 'Functional';
  document.getElementById('tcePreconditions').value = (tc.preconditions || []).join('\n');
  document.getElementById('tceExpected').value      = tc.expected_result || '';
  document.getElementById('tceAutoNotes').value     = tc.automation_notes || '';
  document.getElementById('tceLabels').value        = (tc.labels || []).join(', ');
  renderTcEditSteps(tc.steps || []);
  _tcModalSetMode(isNew ? 'edit' : mode);
  document.getElementById('tcEditModal').style.display = 'flex';
}

function _tcModalSetMode(mode) {
  const viewPane = document.getElementById('tcModalViewPane');
  const editPane = document.getElementById('tcModalEditPane');
  const viewBtn  = document.getElementById('tcModeViewBtn');
  const editBtn  = document.getElementById('tcModeEditBtn');
  const saveBtn  = document.getElementById('tcModalSaveBtn');
  const editToggle = document.getElementById('tcModalEditToggleBtn');

  if (mode === 'view') {
    viewPane.style.display = '';
    editPane.style.display = 'none';
    viewBtn.classList.add('active');
    editBtn.classList.remove('active');
    saveBtn.style.display = 'none';
    editToggle.style.display = '';
    if (_tcModalCurrent) renderTcViewPane(_tcModalCurrent);
  } else {
    viewPane.style.display = 'none';
    editPane.style.display = '';
    viewBtn.classList.remove('active');
    editBtn.classList.add('active');
    saveBtn.style.display = 'inline-flex';
    editToggle.style.display = 'none';
  }
}

function renderTcViewPane(tc) {
  const steps = tc.steps || [];
  const preconds = tc.preconditions || [];
  const el = document.getElementById('tcModalViewPane');
  if (!el) return;

  el.innerHTML = `
    <div style="padding:16px 0">
      <!-- Header meta chips -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
        ${tc.id ? `<span class="tsb">${escHtml(tc.id)}</span>` : ''}
        ${(() => { const sid = tc.parent_sc_id || (tc.scenario_id && !tc.scenario_id.includes('-') ? tc.scenario_id : ''); return sid ? `<span class="tsb" style="color:#b8d4f5;background:rgba(93,140,202,.14);border-color:rgba(93,140,202,.3)" title="Parent Scenario">${escHtml(sid)}</span>` : ''; })()}
        ${tc.module ? `<span class="tg out">${escHtml(tc.module)}</span>` : ''}
        ${tc.priority ? `<span class="tg" style="color:#f4c869;border:1px solid rgba(244,200,105,.4)">${escHtml(tc.priority)}</span>` : ''}
        ${tc.type ? `<span class="tg fn">${escHtml(tc.type)}</span>` : ''}
      </div>

      <!-- Title -->
      <div style="font-size:15px;font-weight:600;color:#ece6d6;margin-bottom:18px;line-height:1.4">${escHtml(tc.title || '')}</div>

      <!-- Preconditions -->
      ${preconds.length ? `
      <div class="tcv-section">
        <div class="tcv-head">Preconditions</div>
        <ul class="tcv-list">${preconds.map(p => `<li>${escHtml(String(p))}</li>`).join('')}</ul>
      </div>` : ''}

      <!-- Steps table -->
      ${steps.length ? `
      <div class="tcv-section">
        <div class="tcv-head">Test Steps</div>
        <table class="tcv-table">
          <thead>
            <tr><th style="width:32px">#</th><th>Action</th><th style="width:22%">Test Data</th><th style="width:28%">Expected Result</th></tr>
          </thead>
          <tbody>
            ${steps.map((s, i) => `
            <tr>
              <td class="tcv-num">${i + 1}</td>
              <td>${escHtml(s.action || s.description || '')}</td>
              <td class="tcv-data">${escHtml(s.test_data || '—')}</td>
              <td class="tcv-expected">${escHtml(s.expected_result || '—')}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>` : '<div style="color:var(--text-dim);font-size:12px;margin-bottom:14px">No steps recorded.</div>'}

      <!-- Expected Result -->
      ${tc.expected_result ? `
      <div class="tcv-section">
        <div class="tcv-head">Overall Expected Result</div>
        <div class="tcv-body">${escHtml(tc.expected_result)}</div>
      </div>` : ''}

      <!-- Automation Notes -->
      ${tc.automation_notes ? `
      <div class="tcv-section">
        <div class="tcv-head">Automation Notes</div>
        <div class="tcv-body tcv-notes">${escHtml(tc.automation_notes)}</div>
      </div>` : ''}

      <!-- Labels -->
      ${(tc.labels || []).length ? `
      <div class="tcv-section">
        <div class="tcv-head">Labels</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${(tc.labels || []).map(l => `<span class="tg out">${escHtml(l)}</span>`).join('')}
        </div>
      </div>` : ''}
    </div>`;
}

function closeTcEditModal() { document.getElementById('tcEditModal').style.display = 'none'; }
function closeTcEditOutside(e) { if (e.target === document.getElementById('tcEditModal')) closeTcEditModal(); }

function renderTcEditSteps(steps) {
  const c = document.getElementById('tceStepsContainer');
  c.innerHTML = steps.map((s, i) => tcStepRowHtml(i, s)).join('');
}

function tcStepRowHtml(i, s = {}) {
  return `<div class="tc-step-row" data-idx="${i}">
    <span class="step-num-badge">${i + 1}</span>
    <textarea class="form-control" placeholder="Action" rows="2" data-field="action">${escHtml(s.action || '')}</textarea>
    <textarea class="form-control" placeholder="Test Data" rows="2" data-field="test_data">${escHtml(s.test_data || '')}</textarea>
    <textarea class="form-control" placeholder="Expected Result" rows="2" data-field="expected_result">${escHtml(s.expected_result || '')}</textarea>
    <button class="btn btn-danger btn-sm" onclick="removeTcEditStep(${i})" title="Remove step">✕</button>
  </div>`;
}

function addTcEditStep() {
  const c = document.getElementById('tceStepsContainer');
  const idx = c.querySelectorAll('.tc-step-row').length;
  c.insertAdjacentHTML('beforeend', tcStepRowHtml(idx));
}

function removeTcEditStep(idx) {
  const rows = [...document.querySelectorAll('#tceStepsContainer .tc-step-row')];
  rows[idx]?.remove();
  // Renumber remaining rows
  document.querySelectorAll('#tceStepsContainer .tc-step-row').forEach((row, i) => {
    row.dataset.idx = i;
    row.querySelector('.step-num-badge').textContent = i + 1;
    row.querySelector('button').setAttribute('onclick', `removeTcEditStep(${i})`);
  });
}

function collectTcEditSteps() {
  return [...document.querySelectorAll('#tceStepsContainer .tc-step-row')].map((row, i) => ({
    step_number:     i + 1,
    action:          (row.querySelector('[data-field="action"]')?.value || '').trim(),
    test_data:       (row.querySelector('[data-field="test_data"]')?.value || '').trim(),
    expected_result: (row.querySelector('[data-field="expected_result"]')?.value || '').trim(),
  }));
}

function saveTcEdit() {
  const title = document.getElementById('tceTitle').value.trim();
  if (!title) { toast('Title is required', 'error'); return; }

  const originalId = document.getElementById('tceOriginalId').value;
  const updated = {
    id:              document.getElementById('tceId').value.trim() || originalId,
    scenario_id:     document.getElementById('tceScenarioId').value.trim(),
    title,
    module:          document.getElementById('tceModule').value.trim(),
    priority:        document.getElementById('tcePriority').value,
    type:            document.getElementById('tceType').value,
    preconditions:   document.getElementById('tcePreconditions').value.split('\n').map(l => l.trim()).filter(Boolean),
    steps:           collectTcEditSteps(),
    expected_result: document.getElementById('tceExpected').value.trim(),
    automation_notes: document.getElementById('tceAutoNotes').value.trim(),
    labels:          document.getElementById('tceLabels').value.split(',').map(l => l.trim()).filter(Boolean),
    status:          'Not Executed',
    jira_fields:     { issue_type: 'Test' },
  };

  const idx = State.testcases.findIndex(t => t.id === originalId);
  if (idx === -1) {
    State.testcases.push(updated);
    toast(`Test case ${updated.id} added`, 'success');
  } else {
    State.testcases[idx] = updated;
    toast(`Test case ${updated.id} updated`, 'success');
  }

  closeTcEditModal();
  renderTestCases();

  // If editing from history, update the existing DB record (not import a new one)
  const histTcId    = window._histEditTcId;
  const histTcGenId = window._histEditTcGenId;
  if (histTcId) {
    apiFetch(`/api/history/test-cases/${histTcId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, ...updated }),
    }).then(r => r.json()).then(res => {
      if (res.success) {
        loadTcHistory();
        if (histTcGenId) selectTcGeneration(histTcGenId);
      }
    }).catch(() => {});
    window._histEditTcId    = null;
    window._histEditTcGenId = null;
    return;
  }

  // Otherwise, import as a new test case under the selected generation
  const targetGenId = HistState.selectedTcGenId || State.currentGenerationId || null;
  apiFetch('/api/history/test-cases/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: CLIENT_ID,
      title: targetGenId ? null : `Manual — ${new Date().toLocaleDateString()}`,
      generationId: targetGenId,
      testcases: [updated],
    }),
  }).then(r => r.json()).then(res => {
    if (res.success) {
      if (!State.currentGenerationId) State.currentGenerationId = res.generationId;
      loadTcHistory();
      if (HistState.selectedTcGenId) selectTcGeneration(HistState.selectedTcGenId);
    }
  }).catch(() => {});
}

function deleteTc(id) {
  if (!confirm(`Delete test case ${id}?`)) return;
  State.testcases = State.testcases.filter(t => t.id !== id);
  renderTestCases();
  toast(`Test case ${id} deleted`, 'success');
  // Persist to session so refresh doesn't restore deleted TC
  apiFetch(`/api/session/${CLIENT_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testcases: State.testcases }),
  }).catch(() => {});
  // Persist archive to DB (fire-and-forget)
  apiFetch(`/api/history/test-cases/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, status: 'archived' }),
  }).catch(() => {});
}

function deleteSelectedTcs() {
  const ids = [...document.querySelectorAll('.tc-select-cb:checked')].map(cb => cb.value);
  if (!ids.length) { toast('No test cases selected — tick some checkboxes first', 'warn'); return; }
  if (!confirm(`Delete ${ids.length} selected test case${ids.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  State.testcases = State.testcases.filter(t => !ids.includes(t.id));
  renderTestCases();
  // Persist to session
  apiFetch(`/api/session/${CLIENT_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testcases: State.testcases }),
  }).catch(() => {});
  toast(`Deleted ${ids.length} test case${ids.length > 1 ? 's' : ''}`, 'success');
}

function deleteAllTcs() {
  if (!State.testcases.length) { toast('No test cases to delete', 'warn'); return; }
  if (!confirm(`Delete all ${State.testcases.length} test case${State.testcases.length > 1 ? 's' : ''}? This cannot be undone.`)) return;
  State.testcases = [];
  renderTestCases();
  // Persist the cleared state so refresh doesn't restore deleted TCs
  apiFetch(`/api/session/${CLIENT_ID}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ testcases: [] }),
  }).catch(() => {});
  toast('All test cases cleared', 'success');
}

// ── Coverage Verification ──────────────────────────────────────────────────────

async function verifyScenarioCoverage() {
  if (!State.scenarios.length) { toast('No scenarios to verify', 'warn'); return; }
  await runVerify('coverageReport2');
}

async function verifyTestCaseCoverage() {
  if (!State.testcases.length) { toast('No test cases to verify', 'warn'); return; }
  await runVerify('coverageReport3');
}

async function runVerify(reportElId) {
  showLoading('Running coverage verification…');
  try {
    const res = await apiFetch('/api/agents/verify/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs:          State.parsedInputs,
        scenarios:       State.scenarios,
        testcases:       State.testcases,
        applicationName: document.getElementById('appName')?.value || 'App',
        ...aiOpts(),
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    renderCoverageReport(reportElId, res);
    toast(`Coverage score: ${res.overall_score}%`, res.overall_score >= 70 ? 'success' : 'warn');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    hideLoading();
  }
}

function renderCoverageReport(elId, data) {
  const el = document.getElementById(elId);
  if (!el) return;

  const score    = data.overall_score ?? 0;
  const ringCls  = score >= 75 ? 'good' : score >= 50 ? 'warn' : 'low';
  const covPct   = data.coverage?.coverage_pct ?? 0;
  const typeDist = data.type_distribution || {};
  const gaps     = data.gaps || [];
  const recs     = data.recommendations || [];
  const modules  = data.module_coverage || [];

  const typeChips = Object.entries(typeDist).map(([type, count]) =>
    `<span class="type-dist-chip ${count === 0 ? 'zero' : ''}">
      <span class="count">${count}</span>
      <span>${type}</span>
    </span>`
  ).join('');

  const gapsHtml = gaps.length
    ? gaps.map(g => `
        <div class="coverage-gap">
          <div class="coverage-gap-area">${escHtml(g.area || g.requirement || 'Gap')}</div>
          <div class="coverage-gap-issue">${escHtml(g.issue || '')}
            ${g.test_types_missing?.length ? `<span style="color:var(--warn);margin-left:6px">Missing: ${g.test_types_missing.join(', ')}</span>` : ''}
          </div>
          ${g.suggested_scenario ? `<div class="coverage-gap-suggest">💡 ${escHtml(g.suggested_scenario)}</div>` : ''}
        </div>`).join('')
    : `<div style="color:var(--success);font-size:13px">✅ No significant gaps found</div>`;

  const modulesHtml = modules.length
    ? `<div class="module-coverage-list">${modules.map(m =>
        `<div class="module-cov-row">
          <span>${escHtml(m.module)}</span>
          <span class="module-cov-counts">${m.scenario_count} scenarios · ${m.tc_count} TCs</span>
          <span class="module-cov-status ${m.status || 'fair'}">${m.status || 'fair'}</span>
        </div>`).join('')}</div>`
    : '';

  el.innerHTML = `
    <div class="coverage-header">
      <div class="coverage-score">
        <div class="score-ring ${ringCls}">${score}%</div>
        <div>
          <div style="font-weight:600;font-size:15px">Coverage Analysis</div>
          <div class="coverage-summary">${escHtml(data.summary || '')}</div>
          <div style="margin-top:6px;font-size:12px;color:var(--text-muted)">
            Requirements covered: <strong style="color:var(--text)">${data.coverage?.covered_count ?? '?'} / ${data.coverage?.total_requirements ?? '?'}</strong>
            (${covPct}%)
          </div>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="document.getElementById('${elId}').style.display='none'">✕ Close</button>
    </div>

    <div class="coverage-section-title">Test Type Distribution</div>
    <div class="type-dist-grid">${typeChips || '<span style="color:var(--text-dim)">No data</span>'}</div>

    ${modules.length ? `<div class="coverage-section-title" style="margin-top:14px">Module Coverage</div>${modulesHtml}` : ''}

    <div class="coverage-section-title" style="margin-top:16px">Gaps &amp; Missing Coverage</div>
    ${gapsHtml}

    ${recs.length ? `
      <div class="coverage-section-title" style="margin-top:16px">Recommendations</div>
      <ul style="margin:0;padding-left:18px;font-size:13px;color:var(--text-muted);line-height:1.8">
        ${recs.map(r => `<li>${escHtml(r)}</li>`).join('')}
      </ul>` : ''}
  `;
  el.style.display = '';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Step 7: Agents & Scheduler ─────────────────────────────────────────────────

// ── Agent Workflow Pipeline (orbital design) ───────────────────────────────

const WF_AGENTS = [
  { icon:'📄', title:'Input Parser',         desc:'Parse requirements, user stories & uploaded files',  opt:false, step:2,
    msgs:['reading files','extracting stories','structuring'] },
  { icon:'🎯', title:'Scenario Agent',        desc:'Generate test scenarios from parsed requirements',   opt:false, step:3,
    msgs:['analyzing','drafting scenarios','prioritizing'] },
  { icon:'📋', title:'TC Generator',          desc:'Create detailed E2E test cases with steps',          opt:false, step:4,
    msgs:['expanding','writing steps','expected results'] },
  { icon:'🏷️', title:'Jira Publisher',       desc:'Upload test cases & steps to Jira / Xray Cloud',     opt:true,  step:5,
    msgs:['connecting Xray','mapping fields','uploading'], optCb:'orchCreateJira' },
  // Standalone agents — shown in the track but never triggered by Run All Agents
  { icon:'🎭', title:'Playwright Builder',    desc:'Record & generate JS POM test scripts',               opt:false, step:6,
    msgs:['recording','generating','formatting'], standalone:true },
  { icon:'🚀', title:'Pipeline & Scheduler', desc:'Trigger GitLab CI/CD and schedule recurring runs',   opt:false, step:7,
    msgs:['configuring','scheduling','triggering'], standalone:true },
];

let _wfIncludeOpt        = true;
let _wfRunning           = false;
let _wfMsgTimers         = [];
let _wfAbortController   = null;

// Build the track HTML (orbital nodes + animated links)
function renderWorkflowPipeline(agents) {
  const track = document.getElementById('wfTrack');
  if (!track) return;
  track.innerHTML = '';

  WF_AGENTS.forEach((a, i) => {
    // Standalone agents are always in their own state — never touched by Run All
    const isStandalone = !!a.standalone;
    const skip = !isStandalone && a.opt && a.optCb && !document.getElementById(a.optCb)?.checked;

    let status = isStandalone ? 'standalone' : 'idle';
    if (skip) {
      status = 'skipped';
    } else if (!isStandalone && agents && agents.length) {
      const found = agents.find(x => (x.name||'').toLowerCase().includes(a.title.split(' ')[0].toLowerCase()));
      if (found) status = { running:'running', done:'done', error:'error' }[found.status] || 'idle';
    }

    const statusLbl = { idle:'IDLE', running:'RUNNING', done:'DONE', error:'ERROR', skipped:'SKIPPED', standalone:'STANDALONE' }[status];

    // Separator line between pipeline agents and standalone agents
    const needsSep = i > 0 && isStandalone && !WF_AGENTS[i-1].standalone;

    const node = document.createElement('div');
    node.className = 'node ' + status;
    node.dataset.i  = i;
    node.innerHTML  =
      (a.opt ? '<div class="optb">OPT</div>' : '') +
      '<div class="orb">' +
        '<div class="halo"></div><div class="track-ring"></div><div class="ring"></div>' +
        '<div class="orbit"><span class="p"></span></div>' +
        '<div class="core">' + a.icon + '</div>' +
        '<div class="check">✓</div>' +
      '</div>' +
      '<div class="lbl">' + a.title + '</div>' +
      '<div class="st"><span class="d"></span><span class="sl">' + statusLbl + '</span></div>' +
      '<button class="go" data-step="' + a.step + '">→ Go</button>' +
      '<div class="tip">' + a.desc + '</div>';
    track.appendChild(node);

    if (i < WF_AGENTS.length - 1) {
      const link = document.createElement('div');
      // Dashed separator between pipeline and standalone sections
      const nextIsStandalone = WF_AGENTS[i + 1]?.standalone;
      link.className = 'link' + (status === 'done' ? ' done' : '') + (nextIsStandalone ? ' solo-sep' : '');
      link.dataset.c = i;
      link.innerHTML = '<span class="dash"></span><span class="pulse"></span>';
      track.appendChild(link);
    }
  });

  // Wire every Go button to navigate to its step
  track.querySelectorAll('.go').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var step = parseInt(btn.dataset.step);
      if (step) goToStep(step);
    });
  });
}

// Update a single node's class + status label
function _wfSetNode(i, state, sub) {
  const n = document.querySelector('#wfTrack .node[data-i="' + i + '"]');
  if (!n) return;
  n.className = 'node ' + state;
  const sl = n.querySelector('.sl');
  if (sl) sl.textContent = (sub || state).toUpperCase();
}

function _wfSetLink(i, cls) {
  const l = document.querySelector('#wfTrack .link[data-c="' + i + '"]');
  if (l) l.className = 'link ' + (cls || '');
}

function _wfStartMsgCycle(i) {
  const msgs = WF_AGENTS[i] && WF_AGENTS[i].msgs || [];
  let m = 0;
  const n = document.querySelector('#wfTrack .node[data-i="' + i + '"]');
  if (!n) return;
  const sl = n.querySelector('.sl');
  const t  = setInterval(function() {
    m = (m + 1) % msgs.length;
    if (sl) sl.textContent = msgs[m].toUpperCase();
  }, 680);
  _wfMsgTimers.push(t);
  return t;
}

function _wfClearTimers() { _wfMsgTimers.forEach(clearInterval); _wfMsgTimers = []; }

// Stop every animated element in the WF track — call after pipeline finishes/errors/resets
function _wfStopAllAnimations() {
  // Only stop pipeline links (not the solo-sep connector before standalone agents)
  for (let i = 0; i < WF_AGENTS.length - 1; i++) {
    if (!WF_AGENTS[i + 1]?.standalone) _wfSetLink(i, 'done');
  }
  // Remove footer run-animation (pulsing dot in footer bar)
  const pf = document.getElementById('wfPf');
  if (pf) pf.classList.remove('run');
  // Stop exec-pane dot & timers
  window.EP?.end();
}

function _wfSetFooter(state, msg) {
  const pf  = document.getElementById('wfPf');
  const txt = document.getElementById('wfPfTxt');
  if (pf)  pf.className = 'wf-pf' + (state === 'run' ? ' run' : state === 'fin' ? ' fin' : '');
  if (txt) txt.textContent = msg;
}

// Toggle a single optional agent on/off by its hidden checkbox ID
function wfToggleAgent(cbId, toggleEl) {
  if (_wfRunning) return;
  const cb = document.getElementById(cbId);
  if (cb) cb.checked = !cb.checked;
  if (toggleEl) toggleEl.classList.toggle('on', !!cb?.checked);
  renderWorkflowPipeline();
  _wfSetFooter('', 'Ready — press Run All Agents.');
}

// Legacy alias (kept for any old references)
function wfToggleOpt() { /* replaced by per-agent wfToggleAgent */ }

// ── Stop the running pipeline immediately ─────────────────────────────────────
function wfStop() {
  if (!_wfRunning && !_wfAbortController) return;
  if (_wfAbortController) { _wfAbortController.abort(); _wfAbortController = null; }
  _wfRunning = false;
  _wfClearTimers();
  _wfStopAllAnimations();
  // Mark any spinning nodes as stopped
  for (var i = 0; i < WF_AGENTS.length; i++) {
    var n = document.querySelector('#wfTrack .node[data-i="' + i + '"]');
    if (n && n.classList.contains('running')) _wfSetNode(i, 'skipped', 'STOPPED');
  }
  _wfSetFooter('', 'Stopped — click Run All Agents to start again.');
  toast('Pipeline stopped.', 'warn');
  xlog(1, 'Pipeline stopped by user', 'warn');
  appendOrchLog('⏹ Stopped by user.');
  var rb = document.getElementById('runBtn');
  var sb = document.getElementById('stopBtn');
  if (rb) { rb.disabled = false; rb.innerHTML = '&#9654; Run All Agents'; }
  if (sb) sb.style.display = 'none';
  hideLoading();
}

// Reset to idle — also resets backend agent states
async function wfReset() {
  _wfClearTimers();
  _wfStopAllAnimations();
  _wfRunning = false;
  // Re-enable the Run button in case it got stuck
  const rb = document.getElementById('runBtn');
  if (rb) { rb.disabled = false; rb.innerHTML = '&#9654; Run All Agents'; }
  const sb = document.getElementById('stopBtn');
  if (sb) sb.style.display = 'none';
  const ot = document.getElementById('optToggle');
  if (ot) ot.style.pointerEvents = '';
  // Hit backend reset endpoint
  try { await apiFetch('/api/agents/reset', { method: 'POST' }); } catch {}
  renderWorkflowPipeline();
  _wfSetFooter('', 'Reset — ready to run.');
  toast('Pipeline reset', 'success');
}

// ── wfRun — the master run function ─────────────────────────────────────────
// 1. Pre-flight checks BEFORE any animation starts
// 2. Fires real API call; animation runs in parallel
// 3. After animation, waits for real result and reports success/failure
async function wfRun() {
  if (_wfRunning) { toast('Already running — click Reset to cancel.', 'warn'); return; }

  // ── Pre-flight: collect every possible input source ───────────────────────
  const userStoryVal    = document.getElementById('userStory')?.value?.trim()    || '';
  const requirementsVal = document.getElementById('requirements')?.value?.trim() || '';
  const quickInputVal   = document.getElementById('orchQuickInput')?.value?.trim() || '';
  const hasRawText   = userStoryVal || requirementsVal || quickInputVal;
  const hasFiles     = State.uploadedFiles?.length  > 0;
  const hasParsed    = State.parsedInputs?.length   > 0;
  const hasScenarios = State.scenarios?.length      > 0;
  const hasTestcases = State.testcases?.length      > 0;
  const hasAnything  = hasRawText || hasFiles || hasParsed || hasScenarios || hasTestcases;

  if (!hasAnything) {
    const logEl0 = document.getElementById('orchLog');
    if (logEl0) logEl0.textContent =
      '⚠ Nothing to run yet.\n\nType your requirements in the box below, then click Run All Agents again.';
    toast('Add requirements first — use the box below.', 'warn');
    return;   // ← stop here, animation never starts
  }

  // ── Check not already running on the server ───────────────────────────────
  try {
    const st = await apiFetch('/api/agents').then(r => r.json());
    if (st.orchestrator?.status === 'running') {
      toast('Server is already running — click Reset to cancel.', 'warn');
      return;
    }
  } catch {}

  // ── Lock UI ───────────────────────────────────────────────────────────────
  const runBtn = document.getElementById('runBtn');
  _wfRunning = true;
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⟳ Running…'; }
  _wfClearTimers();

  const logEl = document.getElementById('orchLog');
  if (logEl) { logEl.textContent = ''; logEl.style.display = ''; }

  renderWorkflowPipeline();
  _wfSetFooter('run', 'Starting pipeline…');
  xlog(1, 'Starting full E2E orchestration…', 'progress');

  // ── Build request body ────────────────────────────────────────────────────
  const opts = aiOpts();
  const body = {
    inputs:    State.parsedInputs,
    userStory:    userStoryVal,
    requirements: requirementsVal || quickInputVal,
    applicationName:    document.getElementById('appName')?.value    || 'Web Application',
    applicationContext: document.getElementById('appContext')?.value  || '',
    baseUrl:            document.getElementById('baseUrl')?.value     || 'https://your-app.com',
    generatePlaywright: false,   // standalone only
    triggerPipeline:    false,   // standalone only
    createJiraTickets:  document.getElementById('orchCreateJira')?.checked || false,
    gitlabUrl:    document.getElementById('glUrl')?.value          || '',
    projectId:    document.getElementById('glProjectId')?.value    || '',
    triggerToken: document.getElementById('glTriggerToken')?.value  || '',
    branch:       document.getElementById('glBranch')?.value       || 'main',
    jiraUrl:        document.getElementById('jiraUrl')?.value        || '',
    jiraEmail:      document.getElementById('jiraEmail')?.value      || '',
    jiraToken:      document.getElementById('jiraToken')?.value      || '',
    jiraProjectKey: document.getElementById('jiraProjectKey')?.value || '',
    ...opts,
  };

  // ── Fire the real API (track success/failure) ─────────────────────────────
  let apiSuccess = false;
  let apiError   = null;
  let apiDone    = false;

  const apiPromise = apiFetch('/api/agents/orchestrate', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }).then(r => r.json()).then(res => {
    if (!res.success) throw new Error(res.error || 'Orchestration failed');
    // Hydrate state
    if (res.scenarios?.length)      { State.scenarios       = res.scenarios;       State.selectedScenarioIds.clear(); renderScenarios();  markStepDone(3); }
    if (res.testcases?.length)       { State.testcases       = res.testcases;       renderTestCases();  markStepDone(4); updateRefLibraryWithTCs(res.testcases); }
    if (res.playwrightFiles?.length) { State.playwrightFiles = res.playwrightFiles; renderFileTree();   markStepDone(6); }
    (res.log || []).forEach(l => appendOrchLog(l));
    apiSuccess = true;
  }).catch(err => {
    apiError = err.message;
    appendOrchLog('❌ Error: ' + err.message);
    xlog(1, 'Orchestration failed: ' + err.message, 'error');
    console.error('[wfRun] Orchestration error:', err);
  }).finally(() => {
    apiDone = true;
    console.log('[wfRun] apiDone — success:', apiSuccess, 'error:', apiError);
  });

  // ── Animate nodes; break immediately if API fails ────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let animFailed = false;

  for (let i = 0; i < WF_AGENTS.length; i++) {
    if (!_wfRunning) break;

    // ← API already failed? Stop animation, mark all remaining as error
    if (apiDone && !apiSuccess) {
      animFailed = true;
      for (let j = i; j < WF_AGENTS.length; j++) {
        const aj   = WF_AGENTS[j];
        const skipj = aj.opt && aj.optCb && !document.getElementById(aj.optCb)?.checked;
        if (!skipj) _wfSetNode(j, 'error', 'FAILED');
      }
      break;
    }

    const a    = WF_AGENTS[i];
    const skip = a.opt && a.optCb && !document.getElementById(a.optCb)?.checked;
    if (skip) { _wfSetNode(i, 'skipped', 'SKIPPED'); continue; }

    _wfSetNode(i, 'running', a.msgs[0]);
    _wfSetFooter('run', 'Running — ' + a.title);
    if (i < WF_AGENTS.length - 1) _wfSetLink(i, 'flow');
    const timer = _wfStartMsgCycle(i);
    await sleep(2400);
    clearInterval(timer);

    // Check again after the sleep in case API failed while we were waiting
    if (apiDone && !apiSuccess) {
      animFailed = true;
      _wfSetNode(i, 'error', 'FAILED');
      for (let j = i + 1; j < WF_AGENTS.length; j++) {
        const aj   = WF_AGENTS[j];
        const skipj = aj.opt && aj.optCb && !document.getElementById(aj.optCb)?.checked;
        if (!skipj) _wfSetNode(j, 'error', 'FAILED');
      }
      break;
    }

    _wfSetNode(i, 'done', 'DONE');
    if (i < WF_AGENTS.length - 1) _wfSetLink(i, 'done');
    await sleep(250);
  }

  // ── Wait for the real API to finish (if animation completed first) ────────
  if (!apiDone) {
    _wfSetFooter('run', 'Waiting for AI response…');
    await apiPromise;
  }

  // ── Final result ──────────────────────────────────────────────────────────
  if (!_wfRunning) {
    // Reset was clicked — nothing to do
  } else if (apiSuccess) {
    _wfSetFooter('fin', 'Pipeline complete — all agents finished successfully.');
    toast('Orchestration complete!', 'success');
    xlog(1, 'Pipeline complete ✓', 'success');
    markStepDone(1);
    renderWorkflowPipeline();
    refreshAgents();
  } else {
    const errMsg = apiError || 'Orchestration failed — check the Orchestration Log for details';
    _wfSetFooter('', '❌ ' + errMsg);
    toast(errMsg, 'error');
    appendOrchLog('❌ Failed: ' + errMsg);
    xlog(1, 'Pipeline failed: ' + errMsg, 'error');
    // Ensure all non-done nodes show error
    for (let i = 0; i < WF_AGENTS.length; i++) {
      const n = document.querySelector('#wfTrack .node[data-i="' + i + '"]');
      if (n && (n.classList.contains('running') || n.classList.contains('idle')))
        _wfSetNode(i, 'error', 'FAILED');
    }
  }

  // ── Unlock UI (old path — kept for safety) ───────────────────────────────
  _wfRunning = false;
  if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = '&#9654; Run All Agents'; }
  hideLoading();
}

// ── FINAL wfRun: step-by-step using proven individual API endpoints ─────────────

// ── wfRunReal — real-time, no fake animation ──────────────────────────────────
// Nodes update via live WebSocket agent_status events as each sub-agent completes.
// No fake sleep loop. The floating progress bar + Execution Log show real progress.
(function() {
  wfRun = async function wfRun() {
    if (_wfRunning) { toast('Already running — click Reset to cancel.', 'warn'); return; }

    const uv = document.getElementById('userStory')?.value?.trim()      || '';
    const rv = document.getElementById('requirements')?.value?.trim()   || '';
    const qv = document.getElementById('orchQuickInput')?.value?.trim() || '';
    const appName = document.getElementById('appName')?.value    || 'Web Application';
    const appCtx  = document.getElementById('appContext')?.value || '';
    const baseUrl = document.getElementById('baseUrl')?.value    || 'https://your-app.com';

    const hasAnything = uv || rv || qv
                     || State.uploadedFiles?.length || State.parsedInputs?.length
                     || State.scenarios?.length     || State.testcases?.length;
    if (!hasAnything) {
      const el = document.getElementById('orchLog');
      if (el) el.textContent = '⚠ Nothing to run yet.\n\nType your requirements in the box below.';
      toast('Add requirements in the box below first.', 'warn');
      return;
    }
    try {
      const st = await apiFetch('/api/agents').then(r => r.json());
      if (st.orchestrator?.status === 'running') {
        toast('Already running on server — click Reset first.', 'warn'); return;
      }
    } catch {}

    // Lock UI, show Stop button
    const rb = document.getElementById('runBtn');
    const sb = document.getElementById('stopBtn');
    _wfRunning = true;
    _wfAbortController = new AbortController();
    if (rb) { rb.disabled = true; rb.textContent = '⟳ Running…'; }
    if (sb) sb.style.display = '';
    _wfClearTimers();
    const logEl = document.getElementById('orchLog');
    if (logEl) { logEl.style.display = 'none'; logEl.textContent = ''; }

    // Determine which optional agents are skipped for exec pane
    // Playwright and Pipeline are standalone — always skipped here
    const _skippedKeys = ['playwright', 'pipeline'];
    if (!document.getElementById('orchCreateJira')?.checked) _skippedKeys.push('jira');

    // Reset pipeline display, set node 0 to starting
    renderWorkflowPipeline();
    _wfSetFooter('run', 'Starting pipeline…');
    xlog(1, 'Agent workflow starting…', 'progress');
    showLoading('Agent workflow running…');

    // Open execution pane and initialise agent rows
    window.EP?.start(_skippedKeys);
    window.EP?.agentStart(0); // Input Parser starts immediately

    const opts = aiOpts();

    // Helper: animate a node, run real work, notify exec pane, mark done or error
    async function runNode(idx, asyncFn) {
      if (!_wfRunning) throw new Error('Cancelled');
      _wfSetNode(idx, 'running', WF_AGENTS[idx].msgs[0]);
      _wfStartMsgCycle(idx);
      if (idx > 0) _wfSetLink(idx - 1, 'flow');
      _wfSetFooter('run', 'Running — ' + WF_AGENTS[idx].title);
      // Exec pane: start this agent (idx 0 was already started above)
      if (idx > 0) window.EP?.agentStart(idx);
      try {
        const result = await asyncFn();
        _wfClearTimers();
        _wfSetNode(idx, 'done', 'DONE');
        if (idx < WF_AGENTS.length - 1) _wfSetLink(idx, 'done');
        // Exec pane: mark done (backend-driven exec:step may have already done it,
        //            but we call agentDone here as a reliable fallback)
        window.EP?.agentDone(idx);
        return result;
      } catch (err) {
        _wfClearTimers();
        _wfSetNode(idx, 'error', 'FAILED');
        window.EP?.agentError(idx, err.message);
        throw err;
      }
    }

    try {
      // ── Node 0: Input Parser ─────────────────────────────────────────────
      if (!State.parsedInputs?.length) {
        await runNode(0, async () => {
          const fd = new FormData();
          State.uploadedFiles.forEach(function(f) { fd.append('files', f); });
          if (uv)       fd.append('userStory',    uv);
          if (rv || qv) fd.append('requirements', rv || qv);
          const r = await apiFetch('/api/ai/parse-inputs', { method: 'POST', body: fd, signal: _wfAbortController?.signal }).then(function(x) { return x.json(); });
          if (!r.success || !r.inputs?.length) throw new Error(r.error || 'No inputs extracted — add more detailed requirements.');
          State.parsedInputs = r.inputs;
          xlog(2, 'Parsed ' + r.inputs.length + ' input(s) ✓', 'success');
        });
      } else {
        _wfSetNode(0, 'done', 'DONE'); _wfSetLink(0, 'done');
        xlog(1, 'Using existing parsed inputs (' + State.parsedInputs.length + ')', 'muted');
      }

      // ── Node 1: Scenario Agent ───────────────────────────────────────────
      await runNode(1, async () => {
        const r = await apiFetch('/api/ai/generate-scenarios', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            inputs: State.parsedInputs,
            generationName: State.currentGenerationName || document.getElementById('generationName')?.value?.trim() || appName,
            applicationName: appName, applicationContext: appCtx, ...opts
          }),
          signal: _wfAbortController?.signal,
        }).then(function(x) { return x.json(); });
        if (!r.success) throw new Error(r.error || 'Scenario generation failed');
        if (!r.scenarios?.length) throw new Error('AI returned no scenarios — try more detailed requirements.');
        State.scenarios = r.scenarios;
        State.selectedScenarioIds.clear();
        if (r.generationId) State.currentGenerationId = r.generationId;
        renderScenarios();        // ← Step 3 populates NOW
        showWarnings(r.warnings, 'scenarioWarnings');
        markStepDone(3);
        xlog(1, r.scenarios.length + ' scenarios ✓', 'success');
        xlog(3, r.scenarios.length + ' scenarios ready', 'success');
      });

      // ── Node 2: TC Generator ─────────────────────────────────────────────
      await runNode(2, async () => {
        const r = await apiFetch('/api/ai/generate-testcases', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scenarios: State.scenarios,
            applicationName: appName,
            baseUrl: baseUrl,
            generationName: State.currentGenerationName || document.getElementById('generationName')?.value?.trim(),
            generationId: State.currentGenerationId || null,  // link TCs to the same generation as scenarios
            ...opts
          }),
          signal: _wfAbortController?.signal,
        }).then(function(x) { return x.json(); });
        if (!r.success) throw new Error(r.error || 'Test case generation failed');
        if (!r.testcases?.length) throw new Error('AI returned no test cases.');
        State.testcases = [...State.testcases, ...r.testcases]; // append, don't replace
        renderTestCases();        // ← Step 4 populates NOW
        markStepDone(4);
        updateRefLibraryWithTCs(r.testcases);
        const steps = r.testcases.reduce(function(n, t) { return n + (t.steps?.length||0); }, 0);
        xlog(1, r.testcases.length + ' TCs · ' + steps + ' steps ✓', 'success');
        xlog(4, r.testcases.length + ' test cases ready', 'success');
      });

      // ── Node 3: Jira Publisher (optional — Upload TCs only, no Bug/Results) ──
      if (document.getElementById('orchCreateJira')?.checked) {
        await runNode(3, async () => {
          await bulkCreateTestCases({ silent: true }); // no confirmation in pipeline
          xlog(1, 'Jira upload triggered ✓', 'jira');
        });
      } else { _wfSetNode(3, 'skipped', 'SKIPPED'); window.EP?.agentSkip(3); }

      // ── Done ─────────────────────────────────────────────────────────────
      // Playwright Builder and Pipeline & Scheduler run standalone — not triggered here
      const sum = State.testcases.length + ' TCs · ' + State.scenarios.length + ' scenarios';
      _wfSetFooter('fin', 'Pipeline complete ✓ — ' + sum);
      _wfStopAllAnimations();
      toast('Done! ' + sum, 'success');
      xlog(1, 'Pipeline complete ✓  ' + sum, 'success');
      markStepDone(1);

    } catch (err) {
      const msg = err.message || 'Pipeline failed';
      _wfStopAllAnimations();
      if (msg !== 'Cancelled') {
        _wfSetFooter('', '❌ ' + msg);
        toast(msg, 'error');
        appendOrchLog('❌ ' + msg);
        xlog(1, 'Pipeline failed: ' + msg, 'error');
      } else {
        _wfSetFooter('', 'Stopped.');
      }
    } finally {
      _wfClearTimers();
      _wfRunning = false;
      _wfAbortController = null;
      if (rb) { rb.disabled = false; rb.innerHTML = '&#9654; Run All Agents'; }
      if (sb) sb.style.display = 'none';
      hideLoading();
    }
  };
})();

async function refreshAgents() {
  try {
    const res = await apiFetch('/api/agents').then(r => r.json());
    if (!res.success) return;
    const all = [res.orchestrator, ...res.agents];

    // Update pipeline nodes in real time based on live sub-agent statuses
    // Mapping: WF_AGENTS index → API agent name fragment
    const nameMap = ['parser','scenario','test case','jira','playwright','pipeline'];
    nameMap.forEach(function(frag, i) {
      const found = res.agents.find(a => (a.name||'').toLowerCase().includes(frag));
      if (!found) return;
      const n = document.querySelector('#wfTrack .node[data-i="' + i + '"]');
      if (!n) return;
      const cur = n.className;
      if (found.status === 'running' && !cur.includes('running')) {
        _wfSetNode(i, 'running', WF_AGENTS[i]?.msgs[0] || 'RUNNING');
        _wfStartMsgCycle(i);
        if (i > 0) _wfSetLink(i - 1, 'flow');
      } else if (found.status === 'done' && !cur.includes('done')) {
        _wfClearTimers();
        _wfSetNode(i, 'done', 'DONE');
        if (i > 0) _wfSetLink(i - 1, 'done');
        // Start next node's spinner
        if (i + 1 < WF_AGENTS.length) {
          const next = WF_AGENTS[i + 1];
          const skip = next.opt && next.optCb && !document.getElementById(next.optCb)?.checked;
          if (!skip) {
            _wfSetNode(i + 1, 'running', next.msgs[0]);
            _wfStartMsgCycle(i + 1);
            _wfSetLink(i, 'flow');
            _wfSetFooter('run', 'Running — ' + next.title);
          }
        }
      } else if (found.status === 'error') {
        _wfSetNode(i, 'error', 'ERROR');
      }
    });

    // Re-render full pipeline with actual statuses (fallback / for reset states)
    if (!_wfRunning) renderWorkflowPipeline(all);
    // Keep the hidden agent grid for backwards compat (used by orchestrator view)
    const grid = document.getElementById('agentGrid');
    if (grid) {
      grid.innerHTML = all.map(a => {
        const statusDot = { idle: '⚪', running: '🟡', done: '🟢', error: '🔴' }[a.status] || '⚪';
        const dur = a.durationMs ? ` · ${(a.durationMs / 1000).toFixed(1)}s` : '';
        return `<div class="agent-card status-${a.status}">
          <div class="agent-icon">${a.icon || '🤖'}</div>
          <div class="agent-name">${a.name}</div>
          <div class="agent-desc">${a.description || ''}</div>
          <span class="agent-status-badge ${a.status}">${statusDot} ${a.status}</span>
          ${dur ? `<div class="agent-duration">${dur}</div>` : ''}
          ${a.lastError ? `<div style="font-size:10px;color:var(--danger);margin-top:2px">${a.lastError}</div>` : ''}
        </div>`;
      }).join('');
    }
  } catch {}
}

async function runOrchestrator() {
  // ── Prevent double-click while already running ────────────────────────────
  try {
    const status = await apiFetch('/api/agents').then(r => r.json());
    if (status.orchestrator?.status === 'running') {
      toast('Orchestration already running — please wait for it to finish.', 'warn');
      appendOrchLog('⏳ Already running — wait for the current run to complete.');
      return;
    }
  } catch {}

  // ── Collect all possible input sources ────────────────────────────────────
  const userStoryVal    = document.getElementById('userStory')?.value?.trim()    || '';
  const requirementsVal = document.getElementById('requirements')?.value?.trim() || '';
  const rulesVal        = document.getElementById('rules')?.value?.trim()        || '';
  const quickInputVal   = document.getElementById('orchQuickInput')?.value?.trim() || '';

  // Anything we can work with?
  const hasRawText   = userStoryVal || requirementsVal || rulesVal || quickInputVal;
  const hasFiles     = State.uploadedFiles?.length > 0;
  const hasParsed    = State.parsedInputs?.length  > 0;
  const hasScenarios = State.scenarios?.length     > 0;
  const hasTestcases = State.testcases?.length      > 0;
  const hasAnything  = hasRawText || hasFiles || hasParsed || hasScenarios || hasTestcases;

  if (!hasAnything) {
    const logEl0 = document.getElementById('orchLog');
    if (logEl0) logEl0.textContent =
      '⚠ Nothing to run yet.\n\nDescribe what to test in the Requirements box below, or go to Step 2 → Collect Inputs to upload files.';
    toast('Add requirements in the Quick Input box below, then Run again.', 'warn');
    return;
  }

  // ── Clear log and build body ───────────────────────────────────────────────
  const logEl = document.getElementById('orchLog');
  if (logEl) { logEl.textContent = ''; logEl.style.display = ''; }

  const opts = aiOpts();
  const body = {
    // Only pass already-parsed inputs (avoids re-parsing uploaded files).
    // Do NOT pass scenarios/testcases — always regenerate from scratch so the
    // full pipeline runs: inputs → scenarios → test cases → playwright → jira → pipeline.
    inputs: State.parsedInputs,
    // Raw text — orchestrator Step 1 will parse these if inputs array is empty
    userStory:    userStoryVal,
    requirements: requirementsVal || quickInputVal,
    rules:        rulesVal,
    // App config
    applicationName:    document.getElementById('appName')?.value    || 'Web Application',
    applicationContext: document.getElementById('appContext')?.value  || '',
    baseUrl:            document.getElementById('baseUrl')?.value     || 'https://your-app.com',
    // Optional stage toggles (Playwright & Pipeline are standalone — always false here)
    generatePlaywright: false,
    triggerPipeline:    false,
    createJiraTickets:  document.getElementById('orchCreateJira')?.checked || false,
    // Pipeline config (step 7)
    gitlabUrl:    document.getElementById('glUrl')?.value          || '',
    projectId:    document.getElementById('glProjectId')?.value    || '',
    triggerToken: document.getElementById('glTriggerToken')?.value  || '',
    branch:       document.getElementById('glBranch')?.value       || 'main',
    // Jira config (step 4)
    jiraUrl:        document.getElementById('jiraUrl')?.value        || '',
    jiraEmail:      document.getElementById('jiraEmail')?.value      || '',
    jiraToken:      document.getElementById('jiraToken')?.value      || '',
    jiraProjectKey: document.getElementById('jiraProjectKey')?.value || '',
    ...opts,
  };

  // Button locking is handled by wfRun() — skip here to avoid conflicts

  xlog(1, 'Starting full E2E orchestration…', 'progress');
  renderWorkflowPipeline();
  showLoading('Running full E2E orchestration…');

  try {
    const res = await apiFetch('/api/agents/orchestrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error || 'Orchestration failed');

    // Hydrate state from orchestrator result
    if (res.scenarios?.length)      { State.scenarios       = res.scenarios;       State.selectedScenarioIds.clear(); renderScenarios();  markStepDone(3); }
    if (res.testcases?.length)       { State.testcases       = res.testcases;       renderTestCases();  markStepDone(4); updateRefLibraryWithTCs(res.testcases); }
    if (res.playwrightFiles?.length) { State.playwrightFiles = res.playwrightFiles; renderFileTree();   markStepDone(6); }

    (res.log || []).forEach(l => appendOrchLog(l));

    const summary = `Orchestration done — ${res.testcaseCount || 0} TCs · ${res.playwrightCount || 0} PW files`;
    toast(summary, 'success');
    xlog(1, summary, 'success');
    markStepDone(1);
    renderWorkflowPipeline(); // update pipeline with completed states
    refreshAgents();
  } catch (err) {
    xlog(1, `Orchestration failed: ${err.message}`, 'error');
    appendOrchLog('❌ ' + err.message);
    toast(err.message, 'error');
  } finally {
    hideLoading();
    // Button re-enable is handled by wfRun() after the await
  }
}

function appendOrchLog(msg) {
  const el = document.getElementById('orchLog');
  if (!el) return;
  // Only show for errors (⚡ Exec Pane handles live progress)
  const isError = msg.startsWith('❌') || msg.startsWith('⏹') || msg.startsWith('⚠');
  if (isError) {
    el.style.display = '';
    el.textContent = msg;   // show latest error/status only
  }
}

// ── Scheduler ──────────────────────────────────────────────────────────────────

async function loadSchedules() {
  try {
    const res = await apiFetch('/api/scheduler/schedules').then(r => r.json());
    if (!res.success) return;
    renderSchedules(res.schedules || []);
  } catch {}
}

function renderSchedules(schedules) {
  const el = document.getElementById('scheduleList');
  if (!el) return;

  if (!schedules.length) {
    el.innerHTML = `<div style="color:var(--text-dim);padding:20px;text-align:center">No schedules yet.</div>`;
    return;
  }

  el.innerHTML = schedules.map(s => `
    <div class="schedule-card" id="sched-${s.id}">
      <div class="sched-header">
        <span class="sched-name">${s.name}</span>
        <span class="sched-cron">${s.cronExpression}</span>
      </div>
      <div class="sched-meta">
        <span>Timezone: ${s.timezone}</span> ·
        <span>Branch: ${s.pipelineConfig?.branch || 'main'}</span>
        ${s.lastRun ? ` · Last run: ${new Date(s.lastRun).toLocaleString()}` : ''}
        ${s.lastPipelineId ? ` · Pipeline #${s.lastPipelineId}` : ''}
      </div>
      <div class="sched-meta">
        Status: <span style="color:${s.enabled ? 'var(--success)' : 'var(--text-dim)'}">${s.enabled ? '● Active' : '○ Disabled'}</span>
      </div>
      <div class="sched-actions">
        <button class="btn btn-outline btn-sm" onclick="triggerSchedule('${s.id}')">▶ Run Now</button>
        <button class="btn btn-outline btn-sm" onclick="toggleSchedule('${s.id}', ${!s.enabled})">${s.enabled ? 'Disable' : 'Enable'}</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSchedule('${s.id}')">✕</button>
      </div>
    </div>
  `).join('');
}

async function createSchedule() {
  const name    = document.getElementById('schedName').value.trim();
  const cronExp = document.getElementById('schedCron').value.trim();
  const tz      = document.getElementById('schedTz').value.trim() || 'UTC';
  const glUrl   = document.getElementById('schedGlUrl').value.trim();
  const pid     = document.getElementById('schedProjectId').value.trim();
  const tt      = document.getElementById('schedTriggerToken').value.trim();
  const branch  = document.getElementById('schedBranch').value.trim() || 'main';
  const varsRaw = document.getElementById('schedVars').value.trim();

  if (!name || !cronExp) { toast('Name and cron expression are required', 'error'); return; }

  let variables = {};
  if (varsRaw) { try { variables = JSON.parse(varsRaw); } catch { toast('Variables must be valid JSON', 'error'); return; } }

  try {
    const res = await apiFetch('/api/scheduler/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, cronExpression: cronExp, timezone: tz,
        pipelineConfig: { gitlabUrl: glUrl, projectId: pid, triggerToken: tt, branch, variables },
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    toast(`Schedule "${name}" created`, 'success');
    // Clear form
    ['schedName','schedCron','schedProjectId','schedTriggerToken','schedVars'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    loadSchedules();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function triggerSchedule(id) {
  try {
    const res = await apiFetch(`/api/scheduler/schedules/${id}/trigger`, { method: 'POST' }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    toast(`Pipeline #${res.pipeline?.id} triggered`, 'success');
    loadSchedules();
  } catch (err) { toast(err.message, 'error'); }
}

async function toggleSchedule(id, enabled) {
  try {
    const res = await apiFetch(`/api/scheduler/schedules/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    toast(`Schedule ${enabled ? 'enabled' : 'disabled'}`, 'success');
    loadSchedules();
  } catch (err) { toast(err.message, 'error'); }
}

async function deleteSchedule(id) {
  if (!confirm('Delete this schedule?')) return;
  try {
    const res = await apiFetch(`/api/scheduler/schedules/${id}`, { method: 'DELETE' }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    toast('Schedule deleted', 'success');
    loadSchedules();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Session Persistence ────────────────────────────────────────────────────────

async function restoreSession() {
  try {
    const res = await apiFetch(`/api/session/${CLIENT_ID}`).then(r => r.json());
    if (!res.exists) return;
    const s = res.session;
    const scCount = s.scenarios?.length || 0;
    const tcCount = s.testcases?.length || 0;
    if (!scCount && !tcCount) return;

    // Restore state — Playwright files are intentionally excluded:
    // they are ephemeral and should be generated fresh each session.
    if (s.scenarios?.length)       State.scenarios  = s.scenarios;
    if (s.testcases?.length)       State.testcases  = s.testcases;
    if (s.applicationName) { const el = document.getElementById('appName');  if (el) el.value = s.applicationName; }
    if (s.baseUrl)         { const el = document.getElementById('baseUrl');   if (el) el.value = s.baseUrl; }

    // Render and navigate to furthest completed step
    if (s.scenarios?.length)       { renderScenarios();  markStepDone(2); }
    if (s.testcases?.length)       { renderTestCases();  markStepDone(3); }

    if (s.testcases?.length)       goToStep(4);
    else if (s.scenarios?.length)  goToStep(3);

    // Show restore banner
    const date = s.lastActivity ? new Date(s.lastActivity).toLocaleString() : '';
    const banner = document.getElementById('sessionBanner');
    document.getElementById('sessionBannerText').textContent =
      `Session restored (${date}): ${scCount} scenarios · ${tcCount} test cases`;
    banner.style.display = 'flex';
  } catch {}
}

async function clearSession() {
  if (!confirm('Clear this session? Generated scenarios and test cases will be lost.')) return;
  try {
    await apiFetch(`/api/session/${CLIENT_ID}`, { method: 'DELETE' });
    State.scenarios      = [];
    State.testcases      = [];
    State.playwrightFiles = [];
    State.parsedInputs   = [];
    renderScenarios();
    renderTestCases();
    // Reset step badges
    document.querySelectorAll('.step-item').forEach(item => {
      item.classList.remove('completed');
      const num = item.querySelector('.step-num');
      if (num && num.textContent === '✓') num.textContent = item.dataset.step || '';
    });
    goToStep(1);
    document.getElementById('sessionBanner').style.display = 'none';
    toast('Session cleared — ready for new generation', 'info');
  } catch (err) { toast(err.message, 'error'); }
}

// Show validation warnings returned from the AI generation routes
function showWarnings(warnings, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!warnings?.length) { el.style.display = 'none'; return; }
  el.innerHTML = `
    <div class="warnings-panel">
      <div class="warnings-header" onclick="this.parentElement.classList.toggle('open')">
        ⚠ ${warnings.length} AI validation warning${warnings.length > 1 ? 's' : ''} — click to expand
      </div>
      <ul class="warnings-list">${warnings.map(w => `<li>${escHtml(w)}</li>`).join('')}</ul>
    </div>`;
  el.style.display = '';
}

// ── Apply current State.settings → Settings modal fields (no State reset) ─────
function applyToSettingsModal() {
  const fieldMap = {
    settAnthropicKey:   'anthropicKey',
    settOpenaiKey:      'openaiKey',
    settGeminiKey:      'geminiKey',
    settModelClaude:    'modelClaude',
    settModelOpenai:    'modelOpenai',
    settModelGemini:    'modelGemini',
    settGlUrl:          'glUrl',
    settGlToken:        'glToken',
    settGlProjectId:    'glProjectId',
    settGlTriggerToken: 'glTriggerToken',
    settAutoRepoPath:   'autoRepoPath',
    settJiraUrl:        'jiraUrl',
    settJiraEmail:      'jiraEmail',
    settJiraToken:      'jiraToken',
    settJiraProjectKey: 'jiraProjectKey',
    settFigmaToken:     'figmaToken',
    settConfluenceBaseUrl: 'confluenceBaseUrl',
  };
  Object.entries(fieldMap).forEach(([elId, key]) => {
    const el = document.getElementById(elId);
    if (el) el.value = State.settings[key] || '';
  });
  selectProvider(State.settings.activeProvider || 'copilot');
  updateProviderBadge();
}

// ── Load server-side defaults from .env ───────────────────────────────────────
async function loadDefaultsFromServer(force = false) {
  try {
    const httpRes = await apiFetch('/api/config/defaults');
    if (!httpRes.ok) throw new Error(`HTTP ${httpRes.status}`);
    const defaults = await httpRes.json();

    let loaded = 0;
    Object.entries(defaults).forEach(([key, val]) => {
      if (val && (force || !State.settings[key])) {
        State.settings[key] = val;
        loaded++;
      }
    });

    // Push into UI without calling loadSettings() (which would wipe State.settings)
    applyToSettingsModal();
    populateJiraFields(force);

    // De-dupe: prefill the input form's app fields from the project profile so the
    // user isn't retyping what's already configured (they can still override).
    const appNameEl = document.getElementById('appName');
    const baseUrlEl = document.getElementById('baseUrl');
    if (appNameEl && defaults.appName    && (force || !appNameEl.value)) appNameEl.value = defaults.appName;
    if (baseUrlEl && defaults.appBaseUrl && (force || !baseUrlEl.value)) baseUrlEl.value = defaults.appBaseUrl;

    // Sync repo path to Step 6 agent input
    const agentPathEl = document.getElementById('agentRepoPath');
    if (agentPathEl && State.settings.autoRepoPath && !agentPathEl.value) {
      agentPathEl.value = State.settings.autoRepoPath;
    }

    if (force) {
      // Auto-open the Jira config panel so user can see the loaded values
      const panel = document.getElementById('jiraConfigPanel');
      if (panel && panel.style.display === 'none') {
        panel.style.display = '';
        const btn = document.querySelector('[onclick="toggleJiraConfig()"]');
        if (btn) btn.textContent = '⚙ Config ▴';
      }
      // Update the Xray status pill
      if (typeof _updateXrayPill === 'function') _updateXrayPill();
      toast(`✅ Config loaded from .env (${loaded} values)`, 'success');
    }
    // Reflect the Jira project in the header (after config has populated fields)
    refreshHeaderProject();
  } catch (e) {
    console.warn('[config] Could not load server defaults:', e.message);
    if (force) toast(`Failed to load .env config: ${e.message}`, 'error');
  }
}

// ── Right-side Execution Log Drawer ──────────────────────────────────────────

const EXEC_STEP_LABELS = {
  1: 'Agents', 2: 'Inputs', 3: 'Scen.', 4: 'TC', 5: 'PW', 6: 'Pipeline',
};

const EXEC_ICONS_MAP = {
  info:     'ℹ️', success: '✅', error: '❌', warn: '⚠️',
  progress: '⟳',  ai: '🤖',    jira: '🔖',  upload: '📤',
  parse:    '📄',  step: '▶',   muted: '·',
};

let _logTotal      = 0;          // total entries ever appended
let _logUnread     = 0;          // entries added while drawer is closed
let _logFilter     = 'all';      // current active filter
let _logDrawerOpen = false;

// no-op stubs so old initExecPanes references don't crash
function initExecPanes() {}
function toggleExecPane()  {}
function openExecPane()    {}
function clearExecPane()   {}

// ── Drawer open / close ───────────────────────────────────────────────────────
function toggleLogDrawer() {
  _logDrawerOpen ? closeLogDrawer() : openLogDrawer();
}

function openLogDrawer() {
  _logDrawerOpen = true;
  document.getElementById('logDrawer')?.classList.add('open');
  document.querySelector('.app')?.classList.add('drawer-open');
  const btn = document.getElementById('logDrawerToggleBtn');
  if (btn) btn.classList.add('active');
  // Reset unread badge
  _logUnread = 0;
  _updateLogBadge();
  // Scroll to bottom
  const body = document.getElementById('logDrawerBody');
  if (body) setTimeout(() => { body.scrollTop = body.scrollHeight; }, 50);
}

function closeLogDrawer() {
  _logDrawerOpen = false;
  document.getElementById('logDrawer')?.classList.remove('open');
  document.querySelector('.app')?.classList.remove('drawer-open');
  const btn = document.getElementById('logDrawerToggleBtn');
  if (btn) btn.classList.remove('active');
}

function clearLogDrawer() {
  const log = document.getElementById('logDrawerLog');
  if (log) log.innerHTML = '<div class="exec-placeholder">Log cleared.</div>';
  _logTotal = _logUnread = 0;
  _updateLogBadge();
  const total = document.getElementById('logDrawerTotal');
  if (total) total.textContent = '0 entries';
  const dot = document.getElementById('execLiveDot');
  if (dot) dot.classList.remove('active');
}

function _updateLogBadge() {
  const badge = document.getElementById('logToggleBadge');
  if (!badge) return;
  if (_logUnread > 0 && !_logDrawerOpen) {
    badge.style.display = '';
    badge.textContent   = _logUnread > 99 ? '99+' : _logUnread;
  } else {
    badge.style.display = 'none';
  }
}

// ── Filter chips ──────────────────────────────────────────────────────────────
function setLogFilter(filter, btn) {
  _logFilter = filter;
  document.querySelectorAll('.log-filter-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  // Show/hide entries
  document.querySelectorAll('#logDrawerLog .exec-entry').forEach(el => {
    el.style.display = _entryMatchesFilter(el) ? '' : 'none';
  });
}

function _entryMatchesFilter(el) {
  if (_logFilter === 'all')   return true;
  if (_logFilter === 'error') return el.classList.contains('exec-error');
  if (_logFilter === 'ai')    return el.classList.contains('exec-ai');
  if (_logFilter === 'jira')  return el.classList.contains('exec-jira');
  // Step filter: check data-step attribute
  return el.dataset.step === _logFilter;
}

// ── Core log function ─────────────────────────────────────────────────────────
// xlog(step, msg, type) — call from anywhere in the app
function xlog(step, msg, type = 'info') {
  const log = document.getElementById('logDrawerLog');
  if (!log) return;

  // Clear placeholder on first entry
  const ph = log.querySelector('.exec-placeholder');
  if (ph) ph.remove();

  // Pulse the live dot
  const dot = document.getElementById('execLiveDot');
  if (dot) {
    dot.classList.add('active');
    if (type === 'success' || type === 'error') {
      setTimeout(() => dot.classList.remove('active'), 2500);
    }
  }

  // Counters
  _logTotal++;
  if (!_logDrawerOpen) _logUnread++;
  _updateLogBadge();

  const total = document.getElementById('logDrawerTotal');
  if (total) total.textContent = `${_logTotal} entr${_logTotal === 1 ? 'y' : 'ies'}`;

  const footerStatus = document.getElementById('logFooterStatus');
  if (footerStatus && type !== 'muted') {
    footerStatus.textContent = String(msg).substring(0, 55);
    footerStatus.style.color = type === 'error' ? 'var(--danger)'
                             : type === 'success' ? 'var(--success)'
                             : 'var(--text-dim)';
  }

  const icon     = EXEC_ICONS_MAP[type] || 'ℹ️';
  const stepBadge = EXEC_STEP_LABELS[step] || `S${step}`;
  const now      = new Date().toLocaleTimeString('en-GB', { hour12: false });

  const entry = document.createElement('div');
  entry.className = `exec-entry exec-${type}`;
  entry.dataset.step = String(step);
  entry.dataset.type = type;
  entry.innerHTML =
    `<span class="exec-time">${now}</span>` +
    `<span class="exec-icon">${icon}</span>` +
    `<span class="exec-step-badge">${escHtml(stepBadge)}</span>` +
    `<span class="exec-msg">${escHtml(String(msg))}</span>`;

  // Apply current filter
  if (!_entryMatchesFilter(entry)) entry.style.display = 'none';

  log.appendChild(entry);

  // Auto-scroll if drawer is open
  if (_logDrawerOpen) {
    const body = document.getElementById('logDrawerBody');
    if (body) body.scrollTop = body.scrollHeight;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  BROWSER AGENT — Automate TC + Execute Flow
// ══════════════════════════════════════════════════════════════════════════════

let _agentSelectedTc = null;

// Check repo connection when navigating to Playwright step
function initBrowserAgent() {
  // Populate path from settings
  const pathEl = document.getElementById('agentRepoPath');
  if (pathEl && !pathEl.value) {
    pathEl.value = getSetting('autoRepoPath') || '';
  }
  const repoPath = pathEl?.value?.trim() || '';
  const qs = repoPath ? `?repoPath=${encodeURIComponent(repoPath)}` : '';
  apiFetch(`/api/playwright/repo-status${qs}`).then(r => r.json()).then(status => {
    const badge = document.getElementById('repoStatusBadge');
    if (!badge) return;
    if (status.connected) {
      badge.textContent = `🟢 ${status.message}`;
      badge.style.color = 'var(--success)';
    } else {
      badge.textContent = '🔴 Automation repo not found';
      badge.style.color = 'var(--danger)';
    }
  }).catch(() => {
    const b = document.getElementById('repoStatusBadge');
    if (b) { b.textContent = '⚠ Could not check repo'; b.style.color = 'var(--warn)'; }
  });
}

// Re-check repo when user clicks Connect
function reconnectAgentRepo() {
  const pathEl = document.getElementById('agentRepoPath');
  const repoPath = pathEl?.value?.trim() || '';
  // Save to settings
  State.settings.autoRepoPath = repoPath;
  localStorage.setItem('qahub_settings', JSON.stringify(State.settings));
  const settEl = document.getElementById('settAutoRepoPath');
  if (settEl) settEl.value = repoPath;
  // Re-check
  initBrowserAgent();
  toast('Checking repo connection…', 'info');
}

// ── Cache-based onclick wrappers (avoids JSON-in-HTML attribute encoding bugs) ──
// Scenario cache wrappers
function _openScenChatById(id) {
  const item = window._histScenCache?.[id]; if (!item) return;
  openScenChat(id, item);
}
function _editHistScenById(id) {
  const item = window._histScenCache?.[id]; if (!item) return;
  editHistScenario(id, item, 'view'); // title click → view mode
}
function _editHistScenByIdInEditMode(id) {
  const item = window._histScenCache?.[id]; if (!item) return;
  editHistScenario(id, item, 'edit'); // ✏ Edit button → edit mode
}
// TC cache wrappers
function _openTcChatById(id) {
  const item = window._histTcCache?.[id]; if (!item) return;
  openTcChat(id, item);
}
function _editHistTcById(id) {
  const item = window._histTcCache?.[id]; if (!item) return;
  editHistTc(id, item, 'view'); // title click → open in view mode
}
function _editHistTcByIdInEditMode(id) {
  const item = window._histTcCache?.[id]; if (!item) return;
  editHistTc(id, item, 'edit'); // ✏ Edit button → open directly in edit mode
}
function _automateHistTcById(id) {
  const item = window._histTcCache?.[id]; if (!item) { toast('TC not found in cache', 'warn'); return; }
  selectTcForAgentFromHistory(item);
}

// ── Scenario title cleaner ────────────────────────────────────────────────────
// Strips embedded TC/TS ID codes that the AI occasionally adds to scenario titles
// e.g. "Search_TC04_ProductSearch_Verify_Valid_SKU" → "ProductSearch Verify Valid SKU"
//      "MODULE_TC001_Login happy path" → "Login happy path"
function _cleanScenTitle(title) {
  if (!title) return title;
  // Remove leading MODULE_TC###_ or MODULE_TS###_ prefix
  let t = title.replace(/^[A-Za-z0-9]+_T[CS]\d+_/i, '');
  // Replace remaining underscores used as word separators with spaces
  t = t.replace(/_/g, ' ').trim();
  return t || title;
}

// ── Inline expand: click title to see full details inside the card ────────────
function _expandHistCard(id, type) {
  const item = (type === 'tc' ? window._histTcCache : window._histScenCache)?.[id];
  const el   = document.getElementById(`scex-${id}`);
  const lnk  = document.getElementById(`scti-${id}`);
  if (!el) return;

  // Toggle off
  if (el.style.display !== 'none') {
    el.style.display = 'none';
    if (lnk) lnk.classList.remove('scti-open');
    return;
  }

  if (type === 'tc') {
    const steps = item.steps || [];
    const preconds = item.preconditions || [];
    el.innerHTML = `
      ${preconds.length ? `
        <div class="scex-section">
          <div class="scex-head">Preconditions</div>
          <ul class="scex-list">${preconds.map(p => `<li>${escHtml(String(p))}</li>`).join('')}</ul>
        </div>` : ''}
      ${steps.length ? `
        <div class="scex-section">
          <div class="scex-head">Steps</div>
          <table class="scex-table">
            <thead><tr><th>#</th><th>Action</th><th>Test Data</th><th>Expected</th></tr></thead>
            <tbody>${steps.map((s,i) => `
              <tr>
                <td>${i+1}</td>
                <td>${escHtml(s.action||s.description||String(s))}</td>
                <td>${escHtml(s.test_data||'—')}</td>
                <td>${escHtml(s.expected_result||'—')}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}
      ${item.expected_result ? `
        <div class="scex-section">
          <div class="scex-head">Expected Result</div>
          <div class="scex-body">${escHtml(item.expected_result)}</div>
        </div>` : ''}
      ${item.automation_notes ? `
        <div class="scex-section">
          <div class="scex-head">Automation Notes</div>
          <div class="scex-body scex-notes">${escHtml(item.automation_notes)}</div>
        </div>` : ''}`;
  } else {
    const ac = item.acceptance_criteria || [];
    el.innerHTML = `
      ${item.description ? `
        <div class="scex-section">
          <div class="scex-head">Description</div>
          <div class="scex-body">${escHtml(item.description)}</div>
        </div>` : ''}
      ${ac.length ? `
        <div class="scex-section">
          <div class="scex-head">Acceptance Criteria</div>
          <ul class="scex-list">${ac.map(a => `<li>${escHtml(String(a))}</li>`).join('')}</ul>
        </div>` : ''}`;
  }

  el.style.display = 'block';
  if (lnk) lnk.classList.add('scti-open');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Import tests from a Jira Test Execution / Test Set for automation ──────────
let _agentImportedTcs = [];

async function importTestsForAgent() {
  const key  = document.getElementById('agentImportKey')?.value?.trim();
  const type = document.getElementById('agentImportType')?.value || 'execution';
  if (!key) { toast('Enter a Jira Test Execution / Test Set key (e.g. PROJ-1234)', 'warn'); return; }

  const cfg = getJiraCfg();
  if (!cfg.jiraUrl || !cfg.jiraEmail || !cfg.jiraToken) {
    openJiraConfig();
    toast('Fill in Jira config (URL, email, API token) first', 'error');
    return;
  }

  const btn  = document.getElementById('btnImportTests');
  const list = document.getElementById('agentImportList');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Downloading…'; }

  try {
    const params = new URLSearchParams({
      type,
      jiraUrl:          cfg.jiraUrl,
      jiraEmail:        cfg.jiraEmail,
      jiraToken:        cfg.jiraToken,
      xrayClientId:     cfg.xrayClientId || '',
      xrayClientSecret: cfg.xrayClientSecret || '',
    });
    const res = await apiFetch(`/api/jira/import-tests/${encodeURIComponent(key)}?${params}`).then(r => r.json());
    if (!res.success) throw new Error(res.error || 'Import failed');

    _agentImportedTcs = res.testcases || [];
    if (!_agentImportedTcs.length) {
      if (list) {
        list.style.display = 'block';
        list.innerHTML = `<div style="font-size:11.5px;color:var(--warn)">${escHtml(res.hint || `No tests found in ${key}`)}</div>`;
      }
      toast(res.hint || `No tests found in ${key}`, 'warn');
      return;
    }

    const typeLabel = res.type === 'set' ? 'Test Set' : 'Test Execution';
    const srcLabel  = res.source === 'xray-cloud' ? 'Xray' : res.source === 'jira-rest' ? 'Jira cards' : res.source;
    _renderAgentImportList(key, typeLabel, srcLabel);
    toast(`Downloaded ${_agentImportedTcs.length} test(s) from ${key}`, 'success');
  } catch (e) {
    if (list) { list.style.display = 'block'; list.innerHTML = `<div style="font-size:11.5px;color:var(--danger)">❌ ${escHtml(e.message)}</div>`; }
    toast(`Import failed: ${e.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Download from Jira'; }
  }
}

// Searchable dropdown (combobox) of imported tests
let _agentComboFiltered = [];

function _renderAgentImportList(key, typeLabel, srcLabel) {
  const list = document.getElementById('agentImportList');
  if (!list) return;
  list.style.display = 'block';
  list.innerHTML =
    `<div style="font-size:10.5px;color:var(--text-muted);margin-bottom:6px">${typeLabel} <strong>${escHtml(key)}</strong> — ${_agentImportedTcs.length} test(s) via ${escHtml(srcLabel)} · search &amp; select to automate</div>
     <div class="agent-combo">
       <input id="agentImportSearch" class="form-control" autocomplete="off" placeholder="Select a test… (type to search)"
              style="font-size:12px;padding:6px 8px;width:100%"
              onfocus="_agentComboFilter()" oninput="_agentComboFilter()"
              onkeydown="_agentComboKey(event)" onblur="setTimeout(_agentComboHide, 150)" />
       <div id="agentImportOptions" class="agent-combo-options" style="display:none"></div>
     </div>`;
  _agentComboRender(_agentImportedTcs);
}

function _agentComboRender(items) {
  _agentComboFiltered = items;
  const box = document.getElementById('agentImportOptions');
  if (!box) return;
  if (!items.length) { box.innerHTML = '<div class="agent-combo-empty">No matching tests</div>'; return; }
  box.innerHTML = items.map(tc => {
    const idx    = _agentImportedTcs.indexOf(tc);
    const nSteps = (tc.steps || []).length;
    // onmousedown (not click) so it fires before the input's blur hides the list
    return `<div class="agent-combo-opt" onmousedown="event.preventDefault();selectImportedTcForAgent(${idx})">
      <strong style="color:#f4c869;font-family:'JetBrains Mono',monospace;font-size:11px">${escHtml(tc.key || tc.tc_id)}</strong>
      <span style="font-size:12px;color:var(--text);flex:1">${escHtml(tc.title)}</span>
      <span style="font-size:10.5px;color:${nSteps ? 'var(--text-muted)' : 'var(--warn)'}">${nSteps ? nSteps + ' steps' : 'no steps'}</span>
    </div>`;
  }).join('');
}

function _agentComboFilter() {
  const q = (document.getElementById('agentImportSearch')?.value || '').toLowerCase().trim();
  const items = !q ? _agentImportedTcs : _agentImportedTcs.filter(tc =>
    `${tc.key || ''} ${tc.tc_id || ''} ${tc.title || ''} ${tc.module || ''}`.toLowerCase().includes(q));
  _agentComboShow();
  _agentComboRender(items);
}

function _agentComboShow() { const b = document.getElementById('agentImportOptions'); if (b) b.style.display = 'block'; }
function _agentComboHide() { const b = document.getElementById('agentImportOptions'); if (b) b.style.display = 'none'; }

function _agentComboKey(e) {
  if (e.key === 'Enter') { e.preventDefault(); if (_agentComboFiltered.length) selectImportedTcForAgent(_agentImportedTcs.indexOf(_agentComboFiltered[0])); }
  else if (e.key === 'Escape') { _agentComboHide(); }
}

function selectImportedTcForAgent(idx) {
  const tc = _agentImportedTcs[idx];
  if (!tc) { toast('Test not found', 'warn'); return; }
  _agentSelectedTc = tc;
  _updateAgentSelection(tc);
  // Reflect the choice in the dropdown input and close the list
  const inp = document.getElementById('agentImportSearch');
  if (inp) inp.value = `${tc.key || tc.tc_id} — ${tc.title}`;
  _agentComboHide();
  if (!(tc.steps || []).length) {
    toast(`"${tc.title}" has no parsed steps — the agent will use the title/summary as guidance`, 'warn');
  } else {
    toast(`"${tc.title}" ready to automate (${tc.steps.length} steps)`, 'success');
  }
}

// Called from history TC card — item is a DB TC object
function selectTcForAgentFromHistory(item) {
  // Normalise DB object to the shape runBrowserAgent expects
  const tc = {
    id:              item.id,
    tc_id:           item.tc_id || item.id,
    title:           item.title || 'Untitled',
    module:          item.module || '',
    priority:        item.priority || 'Medium',
    type:            item.type || 'Functional',
    preconditions:   item.preconditions || [],
    steps:           item.steps || [],
    expected_result: item.expected_result || '',
    labels:          item.labels || [],
  };
  _agentSelectedTc = tc;
  _updateAgentSelection(tc);
  goToStep(6);
  switchAgentTab('automate');
  // Scroll the Browser Agent card into view — it's below the file tree in step 6
  setTimeout(() => {
    const agentCard = document.querySelector('#step6 .card:last-of-type');
    if (agentCard) agentCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 350);
  toast(`"${tc.title}" ready to automate — see Browser Agent below ↓`, 'success');
}

// Called when user clicks 🤖 on a TC row in the (hidden) table — still wired for future use
function selectTcForAgent(tcId) {
  const tc = State.testcases.find(t => t.id === tcId);
  if (!tc) { toast('TC not found', 'warn'); return; }
  _agentSelectedTc = tc;

  _updateAgentSelection(tc);
  goToStep(6);
  switchAgentTab('automate');
  toast(`TC "${tc.title}" selected for automation`, 'success');
  xlog(6, `Selected for automation: ${tc.tc_id || tc.id} — ${tc.title}`, 'action');
}

// Shared: update the "selected TC" display card + enable Automate button
function _updateAgentSelection(tc) {
  const el   = document.getElementById('selectedTcForAgent');
  const btn  = document.getElementById('btnAutomateTc');
  const card = document.querySelector('#step6 .card:last-of-type');

  // Highlight the whole Browser Agent card with a gold border
  if (card) {
    card.style.borderColor = 'rgba(244,200,105,.45)';
    card.style.boxShadow   = '0 0 20px rgba(244,200,105,.08)';
  }

  if (el) {
    el.style.background  = 'rgba(244,200,105,.08)';
    el.style.borderColor = 'rgba(244,200,105,.4)';
    el.style.color       = 'var(--text)';
    el.innerHTML =
      `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
         <strong style="color:#f4c869;font-family:'JetBrains Mono',monospace;font-size:13px">${escHtml(tc.tc_id || tc.id)}</strong>
         <span style="color:var(--text);font-size:13px">${escHtml(tc.title)}</span>
         <span style="color:var(--text-muted);font-size:11px">${escHtml(tc.module || '')}${tc.priority ? ' · ' + tc.priority : ''}${(tc.steps||[]).length ? ' · ' + (tc.steps||[]).length + ' steps' : ''}</span>
       </div>`;
  }
  if (btn) {
    btn.disabled    = false;
    btn.textContent = `🤖 Agentic Automate`;
    btn.style.cssText += ';box-shadow:0 0 16px rgba(244,200,105,.4)';
  }
  const recBtn = document.getElementById('btnRecordSelected');
  if (recBtn) recBtn.disabled = false;
  _prefillAgentInstruction(tc);
  _prefillStartUrl(tc);
}

// Pre-fill the editable AI instruction box from the test case's steps so the user can
// tweak it before automating. Only fills when empty / still the previous auto-fill.
function _prefillAgentInstruction(tc) {
  const ta = document.getElementById('agentInstruction');
  if (!ta) return;
  if (ta.value && ta.value !== ta.dataset.autofill) return;   // keep the user's manual edits
  const steps = (tc.steps || []).map((s, i) =>
    `${i + 1}. ${s.action || ''}${s.test_data ? ` [data: ${s.test_data}]` : ''}${s.expected_result ? ` → expect: ${s.expected_result}` : ''}`
  ).join('\n');
  const text = `Execute test case "${tc.title || tc.tc_id || ''}"${tc.module ? ` (module ${tc.module})` : ''}.\n` +
    (steps ? `Follow these steps in order:\n${steps}` : 'Use the title as guidance (no detailed steps provided).');
  ta.value = text;
  ta.dataset.autofill = text;
}

function switchAgentTab(tab) {
  const map = { automate: 'agentTabAutomate', execute: 'agentTabExecute', repo: 'agentTabRepo' };
  for (const [m, id] of Object.entries(map)) {
    const pane = document.getElementById(id);
    if (pane) pane.style.display = tab === m ? '' : 'none';
  }
  document.getElementById('tabAutomate').classList.toggle('active', tab === 'automate');
  document.getElementById('tabExecute').classList.toggle('active',  tab === 'execute');
  document.getElementById('tabRepo')?.classList.toggle('active',    tab === 'repo');
  if (tab === 'repo') loadRepoScripts();
  if (tab === 'automate') _prefillStartUrl(_agentSelectedTc || {});
}

// Record (Playwright codegen) for the currently selected test case.
// Resolve the best start URL for Record / Agentic Automate (TC fields → Start URL field
// → base URL field → appBaseUrl from .env). Used to prefill the visible Start URL input.
function _resolveStartUrl(tc) {
  const td = (tc && tc.test_data && typeof tc.test_data === 'object') ? tc.test_data : {};
  return (tc && (tc.baseUrl || tc.app_url)) || td.app_url || td.url || td.base_url
    || document.getElementById('pwStartUrl')?.value?.trim()
    || document.getElementById('baseUrl')?.value?.trim()
    || getSetting('appBaseUrl') || '';
}

// Keep the visible Start URL field populated (without clobbering a manual edit).
function _prefillStartUrl(tc) {
  const el = document.getElementById('pwStartUrl');
  if (!el || el.value.trim()) return;
  el.value = _resolveStartUrl(tc);
}

async function recordSelectedTc() {
  if (!_agentSelectedTc) { toast('Select a test case first (Step 4 → Automation, or download from Jira)', 'warn'); return; }
  const tc = _agentSelectedTc;
  // Start URL comes from the visible field (prefilled), then resolution fallbacks.
  const baseUrl = document.getElementById('pwStartUrl')?.value?.trim() || _resolveStartUrl(tc);
  if (!baseUrl) { toast('Enter a Start URL — the recorder opens there (no blank page to paste into)', 'warn'); document.getElementById('pwStartUrl')?.focus(); return; }
  _pwLibSetRecordingBanner(true, tc.title);
  try {
    const res = await apiFetch('/api/pw-scripts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tcId:         tc.tc_id || tc.id || '',
        tcTitle:      tc.title || 'Recorded Flow',
        module:       tc.module || '',
        jiraTestKey:  tc.key || tc.jira_test_key || '',
        executionKey: _pwExecKey || '',
        baseUrl,
        clientId:     CLIENT_ID,
      }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    toast('🔴 Recording — perform the steps in the browser, then close it to save', 'info');
  } catch (e) {
    toast(e.message, 'error');
    _pwLibSetRecordingBanner(false);
  }
}

/* ── Repo Scripts: list + one-click run + Jira evidence upload ─────────────── */
let _repoScripts = [];

function _repoPath() {
  return document.getElementById('agentRepoPath')?.value?.trim() || getSetting('autoRepoPath') || '';
}

async function loadRepoScripts() {
  const box = document.getElementById('repoScriptsList');
  if (!box) return;
  const repoPath = _repoPath();
  if (!repoPath) {
    box.innerHTML = '<div class="pw-lib-empty">No repo linked — set the Codebase Path above and click Connect.</div>';
    return;
  }
  box.innerHTML = '<div class="pw-lib-empty">Loading scripts…</div>';
  try {
    const r = await apiFetch(`/api/repo-scripts?repoPath=${encodeURIComponent(repoPath)}`).then(x => x.json());
    if (!r.success) throw new Error(r.error || 'Failed to list scripts');
    _repoScripts = r.scripts || [];
    if (!_repoScripts.length) { box.innerHTML = '<div class="pw-lib-empty">No .spec files found in the repo.</div>'; return; }
    box.innerHTML = _repoScripts.map((s, i) => `
      <div class="pw-lib-row" style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-bottom:1px solid rgba(255,255,255,.05)">
        <div style="min-width:0">
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:#ece6d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(s.path)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="btn btn-primary btn-sm" onclick="runRepoScript(${i})">▶ Run</button>
          <button class="btn btn-outline btn-sm" id="repoUp-${i}" onclick="uploadRepoEvidenceToJira(${i})" title="Upload latest matching PDF to Jira">⬆ Jira</button>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div class="pw-lib-empty" style="color:#e0786b">Failed: ${escHtml(e.message)}</div>`;
  }
}

async function runRepoScript(idx) {
  const s = _repoScripts[idx];
  if (!s) return;
  const feed = document.getElementById('repoRunFeed');
  if (feed) { feed.style.display = ''; feed.innerHTML = ''; }
  const stopBtn = document.getElementById('btnRepoStop');
  if (stopBtn) stopBtn.style.display = '';
  try {
    const res = await apiFetch('/api/repo-scripts/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath: _repoPath(), specPath: s.path, testName: s.module, clientId: CLIENT_ID }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    // Output streams via WS (repo_run_line / repo_run_done)
  } catch (e) {
    _repoFeedLine('error', `✗ ${e.message}`);
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

// Clear the Playwright panel's live execution logs (AI/codegen feed + repo-run feed).
function clearExecLogs() {
  const agentFeed = document.getElementById('agentFeed');
  if (agentFeed) { agentFeed.innerHTML = ''; agentFeed.style.display = 'none'; }
  const repoFeed = document.getElementById('repoRunFeed');
  if (repoFeed) { repoFeed.innerHTML = ''; repoFeed.style.display = 'none'; }
}

async function stopRepoScript() {
  const stopBtn = document.getElementById('btnRepoStop');
  if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = '⏹ Stopping…'; }
  try {
    await apiFetch('/api/repo-scripts/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID }),
    }).catch(() => {});
  } finally {
    if (stopBtn) { stopBtn.disabled = false; stopBtn.textContent = '⏹ Stop'; }
  }
}

function _repoFeedLine(level, text) {
  const feed = document.getElementById('repoRunFeed');
  if (!feed) return;
  feed.style.display = '';
  const colours = { info:'#6fd6c9', output:'#ece6d6', success:'#7fcf8f', warn:'#e2ad4c', error:'#e0786b' };
  const div = document.createElement('div');
  div.style.cssText = `color:${colours[level] || '#ece6d6'};padding:1px 0`;
  div.textContent = text;
  feed.appendChild(div);
  feed.scrollTop = feed.scrollHeight;
}

// Upload the latest matching PDF evidence (from the repo's Executionscreenshots) to Jira.
// Uses the test key from a downloaded execution if known; otherwise prompts for one.
async function uploadRepoEvidenceToJira(idx) {
  const s = _repoScripts[idx];
  if (!s) return;
  const repoPath = _repoPath();

  // Find the evidence PDF for this test name
  let evidence;
  try {
    const r = await apiFetch(`/api/repo-scripts/evidence?repoPath=${encodeURIComponent(repoPath)}&testName=${encodeURIComponent(s.module)}`).then(x => x.json());
    evidence = r.evidence;
  } catch {}
  if (!evidence) { toast(`No PDF found in Executionscreenshots for "${s.module}" — run the script first`, 'warn'); return; }

  // Resolve the Jira test key: from a matching downloaded test, else ask the user
  let testKey = '', executionKey = _pwExecKey || '';
  const match = (_agentImportedTcs || []).find(t => (t.title || '').toLowerCase().includes(s.module.toLowerCase()) || s.module.toLowerCase().includes((t.title || '').toLowerCase()));
  if (match) { testKey = match.key || match.tc_id || ''; executionKey = match.execution_key || executionKey; }
  if (!testKey) testKey = (prompt('Enter the Jira Test key to attach this evidence to (e.g. PROJ-1234):', '') || '').trim();
  if (!testKey) return;

  const btn = document.getElementById(`repoUp-${idx}`);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const res = await apiFetch('/api/jira/upload-execution-result', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testKey, executionKey, status: 'PASS',
        repoPath, filePath: evidence.path,
        cfg: {
          jiraUrl:          getSetting('jiraUrl') || '',
          jiraEmail:        getSetting('jiraEmail') || '',
          jiraToken:        getSetting('jiraToken') || '',
          xrayClientId:     getSetting('xrayClientId') || '',
          xrayClientSecret: getSetting('xrayClientSecret') || '',
        },
      }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    toast(`✅ Uploaded ${evidence.filename} to ${testKey}: ${res.message}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬆ Jira'; }
  }
}

async function startAutomateAgent() {
  if (!_agentSelectedTc) { toast('Select a TC first by clicking 🤖 on a row in Step 4', 'warn'); return; }

  _lockAgentUI(true);
  _agentFeedLine('start', `▶ Automate Agent starting for: ${_agentSelectedTc.title}`);

  const repoPath = document.getElementById('agentRepoPath')?.value?.trim()
    || getSetting('autoRepoPath') || '';

  try {
    const res = await apiFetch('/api/browser-agent/automate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        testcase: _agentSelectedTc,
        repoPath,
        instruction: document.getElementById('agentInstruction')?.value?.trim() || '',
        ...aiOpts(),          // follow the AI provider selected in the header
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    // Updates come via WebSocket — agent_action + agent_done
  } catch (err) {
    _agentFeedLine('error', `✗ ${err.message}`);
    _lockAgentUI(false);
  }
}

async function startExecuteAgent() {
  const prompt = document.getElementById('agentExecutePrompt')?.value?.trim();
  if (!prompt) { toast('Enter a prompt first', 'warn'); return; }

  _lockAgentUI(true);
  _agentFeedLine('start', `▶ Browser Agent: "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"`);

  try {
    const res = await apiFetch('/api/browser-agent/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        ...aiOpts(),          // follow the AI provider selected in the header
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
  } catch (err) {
    _agentFeedLine('error', `✗ ${err.message}`);
    _lockAgentUI(false);
  }
}

async function stopBrowserAgent() {
  await apiFetch('/api/browser-agent/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  }).catch(() => {});
  _lockAgentUI(false);
}

function _lockAgentUI(locked) {
  const stopBtn = document.getElementById('agentStopBtn');
  const autoBtn = document.getElementById('btnAutomateTc');
  const execBtn = document.getElementById('btnExecuteFlow');
  if (stopBtn) stopBtn.style.display = locked ? '' : 'none';
  if (autoBtn) autoBtn.disabled = locked;
  if (execBtn) execBtn.disabled = locked;
  const feed = document.getElementById('agentFeed');
  if (feed) feed.style.display = '';
}

function _agentFeedLine(level, text) {
  const feed = document.getElementById('agentFeed');
  if (!feed) return;
  feed.style.display = '';
  const colours = { start:'#f4c869', action:'#ece6d6', progress:'#6fd6c9', success:'#7fcf8f', warn:'#e2ad4c', error:'#e0786b', info:'#948c78' };
  const line = document.createElement('div');
  line.style.cssText = `color:${colours[level] || '#ece6d6'};padding:1px 0;`;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `${ts}  ${text}`;
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
  xlog(6, text, level === 'success' ? 'success' : level === 'error' ? 'error' : 'ai');
}

/* ═══════════════════════════════════════════════════════════════════════════
   Digital Twin — Reference Library tab
   ══════════════════════════════════════════════════════════════════════════ */
let _twinSelectedRoute = null;

function _twinFeedLine(level, text) {
  const feed = document.getElementById('twinCrawlFeed');
  if (!feed) return;
  feed.style.display = '';
  const colours = { start:'#f4c869', action:'#ece6d6', progress:'#6fd6c9', success:'#7fcf8f', warn:'#e2ad4c', error:'#e0786b', info:'#948c78' };
  const line = document.createElement('div');
  line.style.cssText = `color:${colours[level] || '#ece6d6'};padding:1px 0;`;
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  line.textContent = `${ts}  ${text}`;
  feed.appendChild(line);
  feed.scrollTop = feed.scrollHeight;
}

let _twinGuidedActive = false;

function _twinLockCrawl(locked) {
  const btn = document.getElementById('twinRecrawlBtn');
  if (btn) { btn.disabled = locked; btn.textContent = locked ? '⏳ Crawling…' : '⟳ Re-crawl Now'; }
  // Auto-crawl controls disabled while any session runs
  const startBtn = document.querySelector('#rlTwinPane button[onclick="startTwinCrawl()"]');
  if (startBtn) startBtn.disabled = locked;
}

function _twinLockGuided(active) {
  _twinGuidedActive = active;
  const rec  = document.getElementById('twinRecordBtn');
  const stop = document.getElementById('twinStopBtn');
  if (rec)  { rec.style.display = active ? 'none' : ''; rec.disabled = false; }
  if (stop) stop.style.display = active ? '' : 'none';
  _twinLockCrawl(active);   // block auto-crawl while recording
}

function _twinCrawlFinished(msg) {
  _twinLockCrawl(false);
  _twinLockGuided(false);
  if (msg.error) {
    _twinFeedLine('error', `✗ ${msg.error}`);
    toast(`Twin ${msg.module ? 'recording' : 'crawl'} failed: ${msg.error}`, 'error');
    return;
  }
  if (msg.module) {
    _twinFeedLine('success', `✓ Module "${msg.module}" recorded — ${msg.module_routes} page(s). Twin now has ${msg.total_routes} routes · ${msg.total_elements} elements · ${msg.total_apis} APIs`);
    if (msg.flow_added) _twinFeedLine('success', `🗺️ Added "${msg.module}" to the App Flow Map tab`);
    toast(`Module "${msg.module}" recorded — ${msg.module_routes} page(s)${msg.flow_added ? ' · added to App Flow Map' : ''}`, 'success');
    // Refresh the Flow Map list so the new flow appears immediately
    if (typeof loadFlows === 'function') loadFlows();
  } else {
    _twinFeedLine('success', `✓ Done — ${msg.total_routes} routes · ${msg.total_elements} elements · ${msg.total_apis} APIs`);
    toast(`Digital Twin crawl complete — ${msg.total_routes} routes`, 'success');
  }
  loadTwinStatus();
  loadTwinExplorer();
}

// ── Status ───────────────────────────────────────────────────────────────────
async function loadTwinStatus() {
  try {
    const s = await apiFetch('/api/twin/status').then(r => r.json());
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('twinLastCrawled', s.crawled_at ? new Date(s.crawled_at).toLocaleString() : 'Never');
    set('twinRoutes',   s.total_routes ?? 0);
    set('twinElements', s.total_elements ?? 0);
    set('twinApis',     s.total_apis ?? 0);
    if (s.crawling) _twinLockCrawl(true);
  } catch (e) { /* status endpoint not reachable yet */ }
}

// ── Config ─────────────────────────────────────────────────────────────────
async function loadTwinConfig() {
  try {
    const { config } = await apiFetch('/api/twin/config').then(r => r.json());
    const c = config || {};
    const v = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    v('twinBaseUrl',    c.baseUrl || getSetting('appBaseUrl') || '');
    v('twinLoginRoute', c.loginRoute || '');
    // Mock-login identity (UIN/UEN/UUID) — not secrets, surfaced as-is by the server
    v('twinUin',        c.identity?.uin || '');
    v('twinUen',        c.identity?.uen || '');
    v('twinUuid',       c.identity?.uuid || '');
    v('twinRoutesList', Array.isArray(c.routes) ? c.routes.join('\n') : '');
    v('twinWebhookSecret', c.webhookSecret && c.webhookSecret !== '••••••' ? '' : '');
    v('twinCronHours',  c.cronHours ?? 0);
    const auto = document.getElementById('twinAutoRecrawl');
    if (auto) auto.checked = !!c.autoRecrawl;
  } catch (e) { /* no saved config yet */ }
}

function _twinConfigFromForm() {
  const routes = (document.getElementById('twinRoutesList')?.value || '')
    .split('\n').map(s => s.trim()).filter(Boolean);
  const cfg = {
    baseUrl:    document.getElementById('twinBaseUrl')?.value?.trim() || '',
    loginRoute: document.getElementById('twinLoginRoute')?.value?.trim() || '',
    routes,
    autoRecrawl: !!document.getElementById('twinAutoRecrawl')?.checked,
    cronHours:   Number(document.getElementById('twinCronHours')?.value) || 0,
  };
  // Mock-login identity (UIN/UEN/UUID) — send whatever the user provided
  const uin  = document.getElementById('twinUin')?.value?.trim();
  const uen  = document.getElementById('twinUen')?.value?.trim();
  const uuid = document.getElementById('twinUuid')?.value?.trim();
  if (uin || uen || uuid) cfg.identity = { uin: uin || '', uen: uen || '', uuid: uuid || '' };
  // Only send secret when the user actually typed something (avoid clobbering with the mask)
  const secret = document.getElementById('twinWebhookSecret')?.value;
  if (secret) cfg.webhookSecret = secret;
  return cfg;
}

async function saveTwinConfig() {
  const cfg = _twinConfigFromForm();
  try {
    await apiFetch('/api/twin/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(r => r.json());
    toast('Twin config saved', 'success');
  } catch (e) { toast(`Save failed: ${e.message}`, 'error'); }
}

// ── Crawl ─────────────────────────────────────────────────────────────────
async function startTwinCrawl() {
  const cfg = _twinConfigFromForm();
  if (!cfg.baseUrl) { toast('Enter a Base URL first', 'warn'); return; }
  _twinLockCrawl(true);
  const feed = document.getElementById('twinCrawlFeed');
  if (feed) { feed.innerHTML = ''; feed.style.display = ''; }
  _twinFeedLine('start', '▶ Requesting crawl…');
  try {
    const res = await apiFetch('/api/twin/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, clientId: CLIENT_ID }),
    }).then(r => r.json());
    if (!res.accepted) throw new Error(res.error || 'Crawl rejected');
    // progress now streams via WS (twin_progress / twin_done)
  } catch (e) {
    _twinLockCrawl(false);
    _twinFeedLine('error', `✗ ${e.message}`);
    toast(`Crawl failed to start: ${e.message}`, 'error');
  }
}

// ── Guided "record a module" ────────────────────────────────────────────────
async function startTwinGuided() {
  const cfg = _twinConfigFromForm();
  if (!cfg.baseUrl) { toast('Enter a Base URL in Crawl Config first', 'warn'); return; }
  const moduleName = document.getElementById('twinModuleName')?.value?.trim() || '';
  const startRoute = document.getElementById('twinStartRoute')?.value?.trim() || '';
  _twinLockGuided(true);
  const feed = document.getElementById('twinCrawlFeed');
  if (feed) { feed.innerHTML = ''; feed.style.display = ''; }
  _twinFeedLine('start', `🎥 Starting recording${moduleName ? ` for "${moduleName}"` : ''}…`);
  try {
    const res = await apiFetch('/api/twin/crawl', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...cfg, mode: 'guided', moduleName, startRoute, clientId: CLIENT_ID }),
    }).then(r => r.json());
    if (!res.accepted) throw new Error(res.error || 'Recording rejected');
    toast('Recording — drive the module in the opened browser, then Stop', 'info');
    // progress streams via WS; _twinCrawlFinished unlocks on twin_done
  } catch (e) {
    _twinLockGuided(false);
    _twinFeedLine('error', `✗ ${e.message}`);
    toast(`Recording failed to start: ${e.message}`, 'error');
  }
}

async function stopTwinCrawl() {
  const stop = document.getElementById('twinStopBtn');
  if (stop) { stop.disabled = true; stop.textContent = '⏹ Stopping…'; }
  _twinFeedLine('progress', '⏹ Stopping — saving captured pages…');
  try {
    await apiFetch('/api/twin/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
    // The crawler finishes its current capture, persists, then emits twin_done.
  } catch (e) {
    toast(`Stop failed: ${e.message}`, 'error');
  } finally {
    if (stop) stop.textContent = '⏹ Stop Recording';
  }
}

async function resetTwin() {
  if (!confirm('Reset the Digital Twin? This soft-deletes all crawled pages, elements, rules and APIs.')) return;
  try {
    await apiFetch('/api/twin/reset', { method: 'POST' }).then(r => r.json());
    toast('Digital Twin reset', 'success');
    loadTwinStatus();
    loadTwinExplorer();
    const cp = document.getElementById('twinContextPanel');
    if (cp) cp.innerHTML = 'Click a route in the explorer to view its full Digital Twin context.';
  } catch (e) { toast(`Reset failed: ${e.message}`, 'error'); }
}

// ── Explorer ─────────────────────────────────────────────────────────────────
async function loadTwinExplorer() {
  const box = document.getElementById('twinExplorer');
  if (!box) return;
  try {
    const { pages } = await apiFetch('/api/twin/pages').then(r => r.json());
    if (!pages || !pages.length) {
      box.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:20px;text-align:center">No routes crawled yet.</div>';
      return;
    }
    box.innerHTML = pages.map(p => `
      <div class="twin-route-row" onclick="viewTwinRoute('${encodeURIComponent(p.route)}', this)"
           style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="min-width:0">
          <div style="font-family:'JetBrains Mono',monospace;font-size:12px;color:#ece6d6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtmlSafe(p.route)}</div>
          <div style="font-size:10.5px;color:var(--text-muted)">${p.module ? `<span style="color:#f4c869">🧩 ${escapeHtmlSafe(p.module)}</span> · ` : ''}${escapeHtmlSafe(p.page_name || '')}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <span class="badge" style="font-size:10px;background:rgba(111,214,201,.12);color:#6fd6c9;padding:1px 7px;border-radius:999px">${p.elements_count} el</span>
          <span class="badge" style="font-size:10px;background:rgba(244,200,105,.12);color:#f4c869;padding:1px 7px;border-radius:999px">${p.rules_count} rules</span>
          <span class="badge" style="font-size:10px;background:rgba(148,140,120,.15);color:#948c78;padding:1px 7px;border-radius:999px">${p.apis_count} API</span>
        </div>
      </div>`).join('');
  } catch (e) {
    box.innerHTML = `<div style="color:#e0786b;font-size:12px;padding:20px;text-align:center">Failed to load: ${escapeHtmlSafe(e.message)}</div>`;
  }
}

async function viewTwinRoute(encRoute, rowEl) {
  document.querySelectorAll('.twin-route-row').forEach(r => r.style.background = '');
  if (rowEl) rowEl.style.background = 'rgba(255,255,255,.04)';
  const panel = document.getElementById('twinContextPanel');
  if (!panel) return;
  panel.innerHTML = '<div style="color:var(--text-dim);padding:10px">Loading…</div>';
  try {
    const { context } = await apiFetch(`/api/twin/pages/${encRoute}`).then(r => r.json());
    if (!context) { panel.innerHTML = '<div style="color:#e0786b;padding:10px">No context for this route.</div>'; return; }
    const c = context;
    const section = (title, body) => body ? `<div style="margin-bottom:12px"><div style="font-weight:600;font-size:11.5px;color:#f4c869;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px">${title}</div>${body}</div>` : '';
    const list = (arr, fmt) => arr && arr.length ? '<div style="font-size:11.5px;line-height:1.6">' + arr.map(fmt).join('') + '</div>' : '<div style="font-size:11.5px;color:var(--text-dim)">(none)</div>';
    panel.innerHTML =
      section('Page', `<div style="font-size:12px"><code>${escapeHtmlSafe(c.page.route)}</code> — ${escapeHtmlSafe(c.page.name || '')}</div>`) +
      section(`Elements (${c.elements.length})`, list(c.elements.slice(0, 40), e =>
        `<div>• [${escapeHtmlSafe(e.type || e.tag)}] ${escapeHtmlSafe(e.label || '(no label)')} ${e.required ? '<span style="color:#e0786b">*req</span>' : ''} <span style="color:var(--text-dim)">${escapeHtmlSafe(e.locator || '')}</span></div>`)) +
      section(`Business rules (${c.business_rules.length})`, list(c.business_rules, r => `<div>• ${escapeHtmlSafe(r)}</div>`)) +
      section(`Validation rules (${c.validation_rules.length})`, list(c.validation_rules, v => `<div>• <b>${escapeHtmlSafe(v.field)}</b>: IF ${escapeHtmlSafe(v.condition || '?')} THEN ${escapeHtmlSafe(v.outcome || '?')}</div>`)) +
      section(`Transitions (${c.transitions.length})`, list(c.transitions, t => `<div>• ${escapeHtmlSafe(t.trigger || 'navigate')} → <code>${escapeHtmlSafe(t.target || '?')}</code></div>`)) +
      section(`API contracts (${c.api_contracts.length})`, list(c.api_contracts, a => `<div>• <b>${escapeHtmlSafe(a.method)}</b> <code>${escapeHtmlSafe(a.endpoint)}</code> → ${a.success || '?'}${a.errors && a.errors.length ? ' err:' + a.errors.join(',') : ''}</div>`)) +
      section('Neighbours', `<div style="font-size:11.5px">↑ ${(c.upstream_pages || []).map(p => escapeHtmlSafe(p.name || p.route)).join(', ') || '(none)'}<br>↓ ${(c.downstream_pages || []).map(p => escapeHtmlSafe(p.name || p.route)).join(', ') || '(none)'}</div>`) +
      (c.requirements && c.requirements.length ? section('Requirements', list(c.requirements, r => `<div>• ${escapeHtmlSafe(r)}</div>`)) : '');
  } catch (e) {
    panel.innerHTML = `<div style="color:#e0786b;padding:10px">Failed: ${escapeHtmlSafe(e.message)}</div>`;
  }
}

// ── Source extraction ─────────────────────────────────────────────────────────
async function extractTwinSource() {
  const text   = document.getElementById('twinSourceText')?.value?.trim();
  const source = document.getElementById('twinSourceType')?.value || 'manual';
  const sourceUrl = document.getElementById('twinSourceUrl')?.value?.trim() || '';
  const status = document.getElementById('twinExtractStatus');
  if (!text) { toast('Paste some document text first', 'warn'); return; }
  if (status) { status.style.display = ''; status.style.color = 'var(--text-muted)'; status.textContent = '⏳ Extracting structured data with AI…'; }
  try {
    // Confluence exports are HTML; everything else is plain text
    const payload = source === 'confluence' && /<[a-z][\s\S]*>/i.test(text)
      ? { html: text, source, sourceUrl, ...aiOpts() }
      : { text, source, sourceUrl, ...aiOpts() };
    const res = await apiFetch('/api/twin/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error || 'Extraction failed');
    const a = res.added || {};
    if (status) {
      status.style.color = '#7fcf8f';
      status.textContent = `✓ Merged — ${a.rules || 0} rules · ${a.transitions || 0} transitions · ${a.roles || 0} role hints · ${a.requirements || 0} requirements`;
    }
    toast('Source extracted & merged into twin', 'success');
    loadTwinStatus();
    loadTwinExplorer();
  } catch (e) {
    if (status) { status.style.color = '#e0786b'; status.textContent = `✗ ${e.message}`; }
    toast(`Extraction failed: ${e.message}`, 'error');
  }
}

// Small HTML escaper (reused if a global one isn't present)
function escapeHtmlSafe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Handle agent WS messages
function handleAgentWsMessage(msg) {
  if (msg.type === 'agent_action') {
    _agentFeedLine(msg.level || 'action', msg.text);
  } else if (msg.type === 'agent_done') {
    _lockAgentUI(false);
    if (msg.success) {
      _agentFeedLine('success', `✓ ${msg.message || 'Done'}`);
      if (msg.files?.length) {
        _agentFeedLine('info', `📁 Files saved to automation repo:`);
        msg.files.forEach(f => _agentFeedLine('success', `  ${f.path}`));
      }
    } else {
      _agentFeedLine('error', `✗ ${msg.error || msg.message || 'Failed'}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  STANDALONE PLAYWRIGHT SCRIPT LIBRARY
//  Global storage in SQLite (no client_id) — all sessions see same scripts.
//  Does NOT use the automation repo.  Each script = one runnable @playwright/test file.
// ══════════════════════════════════════════════════════════════════════════════

// State
let _pwLibScripts = [];   // full list from server
let _pwExecTests = [];    // tests fetched from Jira Test Execution
let _pwExecKey = '';      // current Test Execution key

// ── Load & render ─────────────────────────────────────────────────────────────
async function pwLibLoad() {
  try {
    const res = await apiFetch('/api/pw-scripts').then(r => r.json());
    _pwLibScripts = res.scripts || [];
    _pwLibRender();
  } catch (e) {
    console.warn('[pwLib] load error', e.message);
  }
}

function _pwLibRender() {
  const list = document.getElementById('pwLibList');
  const cnt  = document.getElementById('pwLibCount');
  if (!list) return;
  if (cnt) cnt.textContent = `${_pwLibScripts.length} script${_pwLibScripts.length !== 1 ? 's' : ''}`;
  if (!_pwLibScripts.length) {
    list.innerHTML = '<div class="pw-lib-empty">No scripts yet — generate one above</div>';
    return;
  }
  list.innerHTML = _pwLibScripts.map(s => _pwLibRowHtml(s)).join('');
}

function _pwLibRowHtml(s) {
  const date  = new Date(s.created_at).toLocaleString('en-GB', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const mod   = s.module ? `<span class="pw-lib-mod">${_esc(s.module)}</span>` : '';
  const jiraKey = s.jira_test_key ? `<span class="pw-lib-jira-key" title="Linked to ${_esc(s.jira_test_key)}">${_esc(s.jira_test_key)}</span>` : '';
  return `
<div class="pw-lib-row" id="pwrow-${s.id}">
  <div class="pw-lib-row-main">
    <span class="pw-lib-icon">🧪</span>
    <div class="pw-lib-info">
      <div class="pw-lib-name">${_esc(s.tc_title)}</div>
      <div class="pw-lib-meta">${jiraKey}${mod}<span class="pw-lib-date">${date}</span></div>
    </div>
    <div class="pw-lib-actions">
      <button class="btn pw-lib-btn pw-lib-run"    onclick="pwLibRun('${s.id}')">▶ Run</button>
      <button class="btn pw-lib-btn pw-lib-convert" id="pwconvert-${s.id}" onclick="convertPwLibScript('${s.id}')" title="Convert into repo format & save to the connected repo">🛠 Convert</button>
      <button class="btn pw-lib-btn pw-lib-pdf" id="pwpdf-${s.id}" onclick="pwLibDownloadPdf('${s.id}')" style="display:none" title="Download PDF report">📄 PDF</button>
      <button class="btn pw-lib-btn pw-lib-upload" id="pwupload-${s.id}" onclick="pwLibUploadToJira('${s.id}')" style="display:${s.jira_test_key ? '' : 'none'}" title="Upload PDF evidence to Jira">⬆ Upload</button>
      <button class="btn pw-lib-btn pw-lib-edit"   onclick="pwLibEdit('${s.id}')">✏ Edit</button>
      <button class="btn pw-lib-btn pw-lib-delete" onclick="pwLibDelete('${s.id}')">🗑</button>
    </div>
  </div>
  <!-- code editor (hidden) -->
  <div class="pw-lib-editor" id="pweditor-${s.id}" style="display:none">
    <div class="pw-lib-editor-toolbar">
      <span style="font-size:11px;color:var(--text-muted)">Editing: ${_esc(s.tc_title)}</span>
      <div style="display:flex;gap:6px">
        <button class="btn btn-primary btn-sm" onclick="pwLibSave('${s.id}')">💾 Save</button>
        <button class="btn btn-outline btn-sm" onclick="pwLibCancelEdit('${s.id}')">Cancel</button>
      </div>
    </div>
    <textarea class="pw-lib-code" id="pwcode-${s.id}" spellcheck="false"></textarea>
  </div>
  <!-- run terminal (hidden) -->
  <div class="pw-lib-terminal" id="pwterm-${s.id}" style="display:none">
    <div class="pw-lib-terminal-hdr">
      <span id="pwtermstatus-${s.id}">▶ Running…</span>
      <button class="btn pw-lib-btn" onclick="pwLibCloseTerminal('${s.id}')">✕ Close</button>
    </div>
    <div class="pw-lib-terminal-out" id="pwtermout-${s.id}"></div>
  </div>
</div>`;
}

async function _pwLibPopulateTcSelector() {
  // No longer auto-fetches from DB — now driven by Test Execution ID
}

// ── Fetch Test Execution from Jira ────────────────────────────────────────────
async function pwFetchExecution() {
  const execId = document.getElementById('pwExecId')?.value?.trim();
  if (!execId) { toast('Enter a Test Execution ID (e.g. PROJ-1234)', 'warn'); return; }

  const btn = document.getElementById('btnPwFetch');
  const sel = document.getElementById('pwExecTestSelect');
  const recBtn = document.getElementById('btnPwLibGen');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching…'; }

  try {
    const params = new URLSearchParams({
      jiraUrl:          document.getElementById('settJiraUrl')?.value || getSetting('jiraUrl') || '',
      jiraEmail:        document.getElementById('settJiraEmail')?.value || getSetting('jiraEmail') || '',
      jiraToken:        document.getElementById('settJiraToken')?.value || getSetting('jiraToken') || '',
      xrayClientId:     document.getElementById('xrayClientId')?.value || getSetting('xrayClientId') || '',
      xrayClientSecret: document.getElementById('xrayClientSecret')?.value || getSetting('xrayClientSecret') || '',
    });

    const res = await apiFetch(`/api/jira/test-execution/${encodeURIComponent(execId)}?${params}`).then(r => r.json());
    if (!res.success) throw new Error(res.error);

    _pwExecTests = res.tests || [];
    _pwExecKey = execId;

    if (!_pwExecTests.length) {
      sel.innerHTML = '<option value="">— No tests found in this execution —</option>';
      if (recBtn) recBtn.disabled = true;
      const hint = res.hint || `No tests found in ${execId}`;
      toast(hint, 'warn');
      return;
    }

    // Populate dropdown
    sel.disabled = false;
    if (recBtn) recBtn.disabled = false;
    sel.innerHTML = '<option value="">— Select Test Case —</option>' +
      _pwExecTests.map(t => `<option value="${_esc(t.key)}" data-summary="${_esc(t.summary)}" data-status="${_esc(t.status)}">${_esc(t.key)} — ${_esc(t.summary)} [${_esc(t.status)}]</option>`).join('');

    toast(`✅ Loaded ${_pwExecTests.length} test(s) from ${execId}`, 'success');
    // Show clear button
    const clearBtn = document.getElementById('btnPwClear');
    if (clearBtn) clearBtn.style.display = '';
  } catch (e) {
    toast(e.message, 'error');
    sel.innerHTML = '<option value="">— Fetch failed —</option>';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Fetch Tests'; }
  }
}

// ── Clear fetched Test Execution ──────────────────────────────────────────────
function pwClearExecution() {
  _pwExecTests = [];
  _pwExecKey = '';
  const sel = document.getElementById('pwExecTestSelect');
  const recBtn = document.getElementById('btnPwLibGen');
  const clearBtn = document.getElementById('btnPwClear');
  const input = document.getElementById('pwExecId');
  if (sel) { sel.innerHTML = '<option value="">— Fetch a Test Execution first —</option>'; sel.disabled = true; }
  if (recBtn) recBtn.disabled = true;
  if (clearBtn) clearBtn.style.display = 'none';
  if (input) input.value = '';
  toast('Cleared', 'info');
}

// ── Generate — launches Playwright Codegen ────────────────────────────────────
async function pwLibGenerate() {
  const sel    = document.getElementById('pwExecTestSelect');
  const btn    = document.getElementById('btnPwLibGen');

  let tcTitle, tcId, mod, jiraTestKey;

  if (sel && sel.value) {
    const opt = sel.options[sel.selectedIndex];
    jiraTestKey = sel.value;
    tcTitle = opt.dataset.summary || opt.text;
    tcId    = jiraTestKey;
    mod     = '';
  } else {
    toast('Select a test case from the dropdown first', 'warn');
    return;
  }

  // Disable button until codegen browser is closed
  if (btn) { btn.disabled = true; btn.textContent = '🔴 Recording…'; }
  _pwLibSetRecordingBanner(true, tcTitle);

  try {
    const res = await apiFetch('/api/pw-scripts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tcId,
        tcTitle,
        module:       mod,
        jiraTestKey,
        executionKey: _pwExecKey,
        baseUrl:  document.getElementById('baseUrl')?.value || '',
        clientId: CLIENT_ID,
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    toast('🔴 Playwright Codegen is recording — perform your test steps, then close the browser', 'info');
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🎭 Record Script'; }
    _pwLibSetRecordingBanner(false);
  }
}

// ── Generate from manual input ────────────────────────────────────────────────
async function pwLibGenerateManual() {
  const custom = document.getElementById('pwLibCustomName')?.value?.trim();
  if (!custom) { toast('Enter a TC name', 'warn'); return; }

  const btn = document.getElementById('btnPwLibGen');
  _pwLibSetRecordingBanner(true, custom);

  try {
    const res = await apiFetch('/api/pw-scripts', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        tcId:    '',
        tcTitle: custom,
        module:  '',
        baseUrl: document.getElementById('baseUrl')?.value || '',
        clientId: CLIENT_ID,
      }),
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    toast('🔴 Recording — perform your test steps, then close the browser', 'info');
    document.getElementById('pwLibCustomName').value = '';
  } catch (e) {
    toast(e.message, 'error');
    _pwLibSetRecordingBanner(false);
  }
}

// ── Upload PDF evidence to Jira ───────────────────────────────────────────────
async function pwLibUploadToJira(scriptId) {
  const script = _pwLibScripts.find(s => s.id === scriptId);
  if (!script) return;

  const testKey = script.jira_test_key;
  if (!testKey) { toast('No Jira test key linked to this script', 'warn'); return; }

  const uploadBtn = document.getElementById(`pwupload-${scriptId}`);
  if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = '⏳'; }

  try {
    // First get the PDF blob
    const pdfRes = await apiFetch(`/api/pw-scripts/${scriptId}/report`);
    if (!pdfRes.ok) throw new Error('No PDF report available — run the script first');
    const pdfBlob = await pdfRes.blob();

    const formData = new FormData();
    formData.append('file', pdfBlob, `${testKey}-execution-report.pdf`);
    formData.append('testKey', testKey);
    formData.append('executionKey', _pwExecKey || script.execution_key || '');
    formData.append('status', 'PASS');
    formData.append('cfg', JSON.stringify({
      jiraUrl:          document.getElementById('settJiraUrl')?.value || getSetting('jiraUrl') || '',
      jiraEmail:        document.getElementById('settJiraEmail')?.value || getSetting('jiraEmail') || '',
      jiraToken:        document.getElementById('settJiraToken')?.value || getSetting('jiraToken') || '',
      xrayClientId:     document.getElementById('xrayClientId')?.value || getSetting('xrayClientId') || '',
      xrayClientSecret: document.getElementById('xrayClientSecret')?.value || getSetting('xrayClientSecret') || '',
    }));

    const res = await apiFetch('/api/jira/upload-execution-result', {
      method: 'POST',
      body:   formData,
    }).then(r => r.json());

    if (!res.success) throw new Error(res.error);
    toast(`✅ Uploaded to ${testKey}: ${res.message}`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = '⬆ Upload'; }
  }
}

// Convert a recorded script into the connected repo's structure (page object + spec +
// data), merging per module. Progress streams into the shared agent feed.
async function convertPwLibScript(scriptId) {
  const repoPath = _repoPath();
  if (!repoPath) { toast('Link your automation repo first (Codebase Path → Connect)', 'warn'); return; }
  const btn = document.getElementById(`pwconvert-${scriptId}`);
  if (btn) { btn.disabled = true; btn.textContent = '🛠 Converting…'; }
  try {
    const res = await apiFetch(`/api/pw-scripts/${scriptId}/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPath, clientId: CLIENT_ID, ...aiOpts() }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    // Progress + completion stream via WS (agent_action + pw_lib_convert_done)
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🛠 Convert'; }
  }
}

function _pwLibSetRecordingBanner(active, tcTitle = '') {
  let banner = document.getElementById('pwLibRecordingBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'pwLibRecordingBanner';
    banner.className = 'pw-lib-recording-banner';
    const card = document.getElementById('pwLibList');
    if (card) card.parentNode.insertBefore(banner, card);
  }
  if (active) {
    banner.innerHTML = `
      <span class="pw-lib-rec-dot"></span>
      <span>Recording <strong>${tcTitle}</strong> — interact with the browser, then <strong>close it</strong> to save the script</span>`;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

// ── Edit ──────────────────────────────────────────────────────────────────────
async function pwLibEdit(id) {
  const editor = document.getElementById(`pweditor-${id}`);
  const code   = document.getElementById(`pwcode-${id}`);
  if (!editor) return;

  if (editor.style.display !== 'none') {
    pwLibCancelEdit(id); return;
  }

  // Fetch full script content if not already loaded
  let script = _pwLibScripts.find(s => s.id === id)?.script;
  if (!script) {
    try {
      const res = await apiFetch(`/api/pw-scripts/${id}`).then(r => r.json());
      script = res.script?.script || '';
      const idx = _pwLibScripts.findIndex(s => s.id === id);
      if (idx >= 0) _pwLibScripts[idx].script = script;
    } catch {}
  }

  code.value = script || '';
  editor.style.display = 'block';
  code.focus();
  // Close any open terminal for this row
  const term = document.getElementById(`pwterm-${id}`);
  if (term) term.style.display = 'none';
}

function pwLibCancelEdit(id) {
  const editor = document.getElementById(`pweditor-${id}`);
  if (editor) editor.style.display = 'none';
}

async function pwLibSave(id) {
  const code = document.getElementById(`pwcode-${id}`);
  if (!code) return;
  const script = code.value;
  try {
    const res = await apiFetch(`/api/pw-scripts/${id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ script }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    const idx = _pwLibScripts.findIndex(s => s.id === id);
    if (idx >= 0) _pwLibScripts[idx].script = script;
    pwLibCancelEdit(id);
    toast('Script saved', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function pwLibDelete(id) {
  const s = _pwLibScripts.find(x => x.id === id);
  if (!confirm(`Delete script "${s?.tc_title || id}"?`)) return;
  try {
    await apiFetch(`/api/pw-scripts/${id}`, { method: 'DELETE' });
    _pwLibScripts = _pwLibScripts.filter(x => x.id !== id);
    _pwLibRender();
    toast('Script deleted', 'info');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function pwLibRun(id) {
  const term   = document.getElementById(`pwterm-${id}`);
  const out    = document.getElementById(`pwtermout-${id}`);
  const status = document.getElementById(`pwtermstatus-${id}`);
  if (!term || !out) return;

  // Toggle: if open, close
  if (term.style.display !== 'none') { pwLibCloseTerminal(id); return; }

  // Close editor if open
  const editor = document.getElementById(`pweditor-${id}`);
  if (editor) editor.style.display = 'none';

  term.style.display = 'block';
  out.innerHTML = '';
  if (status) status.textContent = '▶ Running…';

  // Mark run button as active
  const row  = document.getElementById(`pwrow-${id}`);
  const runBtn = row?.querySelector('.pw-lib-run');
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '⏳'; }

  try {
    const res = await apiFetch(`/api/pw-scripts/${id}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: CLIENT_ID }),
    }).then(r => r.json());
    if (!res.success) throw new Error(res.error);
    // Output streams via WebSocket pw_lib_line / pw_lib_done events
  } catch (e) {
    _pwLibTermLine(id, `Error: ${e.message}`, 'error');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run'; }
  }
}

function pwLibDownloadPdf(id) {
  // Direct browser download — the server streams the PDF file
  const a = document.createElement('a');
  a.href = `/api/pw-scripts/${id}/report`;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function pwLibCloseTerminal(id) {
  const term = document.getElementById(`pwterm-${id}`);
  if (term) term.style.display = 'none';
  const row    = document.getElementById(`pwrow-${id}`);
  const runBtn = row?.querySelector('.pw-lib-run');
  if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run'; }
}

function _pwLibTermLine(id, text, level = 'output') {
  const out = document.getElementById(`pwtermout-${id}`);
  if (!out) return;
  const span = document.createElement('div');
  span.className = `pw-term-line pw-term-${level}`;
  span.textContent = text;
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}

// ── WebSocket handler — called from handleWsMessage ───────────────────────────
function handlePwLibWs(msg) {
  const btn = document.getElementById('btnPwLibGen');

  // ── Codegen lifecycle ──────────────────────────────────────────────────────
  if (msg.type === 'pw_lib_codegen_status') {
    // Recording started — already shown via button state
    return;
  }

  if (msg.type === 'pw_lib_codegen_log') {
    _agentFeedLine('progress', `🎭 ${msg.text}`);
    return;
  }

  if (msg.type === 'pw_lib_convert_done') {
    const cb = document.getElementById(`pwconvert-${msg.scriptId}`);
    if (cb) { cb.disabled = false; cb.textContent = '🛠 Convert'; }
    if (msg.success) {
      toast(`✅ Converted into repo — ${(msg.saved || []).length} file(s) saved`, 'success');
      _agentFeedLine('success', `✓ Saved to repo: ${(msg.saved || []).join(', ') || '(no files)'}`);
    } else {
      toast(`Convert failed: ${msg.error || 'unknown error'}`, 'error');
    }
    return;
  }

  if (msg.type === 'pw_lib_codegen_done') {
    _pwLibSetRecordingBanner(false);
    if (btn) { btn.disabled = false; btn.textContent = '🎭 Record Script'; }

    if (msg.success && msg.script) {
      _pwLibScripts.unshift(msg.script);
      _pwLibRender();
      toast(`✅ Script recorded for "${msg.script.tc_title}"`, 'success');
    } else {
      toast(`⚠ ${msg.error || 'Codegen closed without recording'}`, 'warn');
    }
    return;
  }

  // ── Run terminal output ────────────────────────────────────────────────────
  if (msg.type === 'pw_lib_line') {
    _pwLibTermLine(msg.scriptId, msg.text, msg.level || 'output');
  } else if (msg.type === 'pw_lib_done') {
    const status = document.getElementById(`pwtermstatus-${msg.scriptId}`);
    if (status) status.textContent = msg.success ? '✅ Passed' : '❌ Failed';
    const row    = document.getElementById(`pwrow-${msg.scriptId}`);
    const runBtn = row?.querySelector('.pw-lib-run');
    if (runBtn) { runBtn.disabled = false; runBtn.textContent = '▶ Run'; }
    // Show PDF download button if a report was generated
    const pdfBtn = document.getElementById(`pwpdf-${msg.scriptId}`);
    if (pdfBtn) pdfBtn.style.display = msg.hasPdf ? '' : 'none';
    // Show Upload button if script is linked to Jira and PDF exists
    const uploadBtn = document.getElementById(`pwupload-${msg.scriptId}`);
    const script = _pwLibScripts.find(s => s.id === msg.scriptId);
    if (uploadBtn && msg.hasPdf && script?.jira_test_key) {
      uploadBtn.style.display = '';
    }
  }
}

function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Init ───────────────────────────────────────────────────────────────────────
// Gate the app behind auth (when enabled) before firing the data-loading calls,
// so we don't spray 401s. If a login is required, the overlay is shown and boot stops.
async function boot() {
  if (!(await guardAuth())) return;
  connectWS();
  loadSettings();
  populateJiraFields();
  loadDefaultsFromServer();
  updateProviderBadge();
  _updateXrayPill();
  renderWorkflowPipeline();  // draw pipeline immediately (idle state)
  refreshAgents();           // then update with live agent statuses
  loadSchedules();
  loadRefLibraryStatus();
  restoreSession();
  initExecPanes();
  initHistory();   // load generation history panels
  pwLibLoad();     // load standalone script library (global, all sessions)
  loadAppMap();    // restore previously imported app map
}
boot();

// ══════════════════════════════════════════════════════════════════════════════
//  HISTORY  ·  PER-ITEM CHAT  ·  KNOWLEDGE LOOP
// ══════════════════════════════════════════════════════════════════════════════

// ── State ──────────────────────────────────────────────────────────────────────
const HistState = {
  selectedScenGenId: null,
  selectedTcGenId:   null,
  selectedTcId:      null,
  chatContext:       {},
  // checkbox selection sets
  checkedScenIds: new Set(),
  checkedTcIds:   new Set(),
  // current items for floating chat context
  currentScenarios: [],
  currentTestCases: [],
};

// ── Select All / Clear All for history cards ──────────────────────────────────
function selectAllHistCards(kind) {
  const containerId = kind === 'scen' ? 'scenHistDetail' : 'tcHistDetail';
  const set = kind === 'scen' ? HistState.checkedScenIds : HistState.checkedTcIds;
  const checkClass = kind === 'scen' ? 'on' : 'ont';
  const cardClass  = kind === 'scen' ? 'checked' : 'checkedt';
  document.querySelectorAll(`#${containerId} .scard`).forEach(card => {
    const id = card.dataset.itemId;
    if (!id) return;
    set.add(id);
    card.classList.add(cardClass);
    const cb = card.querySelector('.cb');
    if (cb) { cb.classList.add(checkClass); cb.textContent = '✓'; }
  });
  _updateHistSelCount(kind);
}

function clearAllHistCards(kind) {
  const containerId = kind === 'scen' ? 'scenHistDetail' : 'tcHistDetail';
  const set = kind === 'scen' ? HistState.checkedScenIds : HistState.checkedTcIds;
  const checkClass = kind === 'scen' ? 'on' : 'ont';
  const cardClass  = kind === 'scen' ? 'checked' : 'checkedt';
  set.clear();
  document.querySelectorAll(`#${containerId} .scard`).forEach(card => {
    card.classList.remove(cardClass);
    const cb = card.querySelector('.cb');
    if (cb) { cb.classList.remove(checkClass); cb.textContent = ''; }
  });
  _updateHistSelCount(kind);
}

// ── Checkbox toggle for history cards ─────────────────────────────────────────
function toggleHistCard(itemId, kind, cardEl) {
  // kind: 'scen' | 'tc'
  const set = kind === 'scen' ? HistState.checkedScenIds : HistState.checkedTcIds;
  const wasChecked = set.has(itemId);
  if (wasChecked) set.delete(itemId); else set.add(itemId);

  const card = cardEl.closest('.scard');
  const cb   = card.querySelector('.cb');
  if (!card || !cb) return;

  if (kind === 'scen') {
    card.classList.toggle('checked',  !wasChecked);
    cb.classList.toggle('on',         !wasChecked);
    cb.textContent = !wasChecked ? '✓' : '';
  } else {
    card.classList.toggle('checkedt', !wasChecked);
    cb.classList.toggle('ont',        !wasChecked);
    cb.textContent = !wasChecked ? '✓' : '';
  }

  // Update selcount
  _updateHistSelCount(kind);
}

function _updateHistSelCount(kind) {
  const count = kind === 'scen' ? HistState.checkedScenIds.size : HistState.checkedTcIds.size;
  const elId  = kind === 'scen' ? 'scenSelCount' : 'tcSelCount';
  const el = document.getElementById(elId);
  if (el) el.textContent = count;

  // Also sync the bottom "Generate Test Cases" button label for scenario selections
  if (kind === 'scen') {
    const btn = document.getElementById('btnGenerateTestCases');
    if (btn) {
      const total = State.scenarios.length || document.querySelectorAll('.scard[data-item-id]').length;
      btn.textContent = count > 0
        ? `📋 Generate Test Cases (${count} of ${total}) →`
        : `📋 Generate Test Cases (ALL ${total}) →`;
    }
  }

  // Update floating chat context label
  if (typeof updateAiChatCtxLabel === 'function') updateAiChatCtxLabel();
}

// ── Init ───────────────────────────────────────────────────────────────────────
function initHistory() {
  loadScenHistory();
  loadTcHistory();
  // Also load when navigating to these steps
}

// ── WS integration ─────────────────────────────────────────────────────────────
// Called from handleWsMessage for new WS types
function handleHistoryWsMessage(msg) {
  if (msg.type === 'generation_saved') {
    loadScenHistory();
    loadTcHistory();
  }
  if (msg.type === 'tcs_saved') {
    loadTcHistory();
  }
}

// handleHistoryWsMessage is called directly from the main WS handler above
// goToStep is patched at its original definition to refresh history panels

// ── Scenario History ────────────────────────────────────────────────────────────
async function loadScenHistory() {
  try {
    const r = await apiFetch(`/api/history/generations?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) return;
    const list = document.getElementById('scenHistList');
    const count = document.getElementById('scenHistCount');
    if (count) count.textContent = r.generations.length;
    if (!list) return;
    if (!r.generations.length) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No history yet.</div>';
      return;
    }
    list.innerHTML = r.generations.map(g => {
      const isActive = g.id === HistState.selectedScenGenId;
      return `<div class="gen gen-compact${isActive ? ' sel' : ''}" onclick="selectScenGeneration('${g.id}')">
        <div class="gen-compact-row">
          <span class="gt">${escHtml(g.title)}</span>
          <div class="gen-row-actions" onclick="event.stopPropagation()">
            <span class="gen-del-btn" onclick="deleteHistGeneration('${g.id}','scen')">✕</span>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (e) { console.warn('[History] loadScenHistory:', e.message); }
}

function _syncAddScenBtn() {
  const btn = document.querySelector('#step3 .mc-actions .act[onclick="addNewScenario()"]');
  if (!btn) return;
  const enabled = !!(HistState.selectedScenGenId || State.currentGenerationId);
  btn.style.opacity       = enabled ? '' : '0.35';
  btn.style.pointerEvents = enabled ? '' : 'none';
  btn.title               = enabled ? '' : 'Select a generation in History first';
}

function _syncRegenScenBtn() {
  const btn = document.querySelector('#step3 .mc-actions .act[onclick="regenerateScenarios()"]');
  if (!btn) return;
  const enabled = !!HistState.selectedScenGenId;
  btn.style.opacity       = enabled ? '' : '0.35';
  btn.style.pointerEvents = enabled ? '' : 'none';
  btn.title               = enabled ? 'Regenerate scenarios for selected generation' : 'Select a generation in History first';
}

function _syncRegenTcBtn() {
  const btn = document.querySelector('#step4 .mc-actions .act[onclick="regenerateTestCases()"]');
  if (!btn) return;
  const enabled = !!HistState.selectedTcGenId;
  btn.style.opacity       = enabled ? '' : '0.35';
  btn.style.pointerEvents = enabled ? '' : 'none';
  btn.title               = enabled ? 'Regenerate test cases for selected generation' : 'Select a generation in History first';
}

async function selectScenGeneration(genId) {
  HistState.selectedScenGenId = genId;
  _syncAddScenBtn();
  _syncRegenScenBtn();
  HistState.chatContext = { type: 'generation', id: genId, item: null };
  await loadScenHistory(); // re-render to highlight selection

  const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
  if (!r.success) return;
  HistState.chatContext.item = r.generation;

  const detail = document.getElementById('scenHistDetail');
  if (!detail) return;

  const scenarios = r.scenarios || [];
  detail.innerHTML = `
    <div class="seltool">
      <span class="selcount"><b id="scenSelCount">${HistState.checkedScenIds.size}</b> of ${scenarios.length} selected</span>
      <span class="lnk" onclick="selectAllHistCards('scen')">Select all</span>
      <span class="lnk" onclick="clearAllHistCards('scen')">Clear</span>
      <span class="lnk del" onclick="deleteSelectedScenarios()">🗑 Delete Selected</span>
    </div>
    <div class="cards">
      ${(() => {
        // Cache scenarios so onclick wrappers can look up without JSON-in-HTML issues
        window._histScenCache = window._histScenCache || {};
        scenarios.forEach(s => { window._histScenCache[s.id] = s; });
        return scenarios.map((s, idx) => {
          const isChecked = HistState.checkedScenIds.has(s.id);
          const tsId = (s.sc_id || '').replace(/-/g, '').replace(/^TC/i, 'TS') || `TS${String(idx + 1).padStart(3, '0')}`;
          return `<div class="scard${isChecked ? ' checked' : ''}" data-item-id="${s.id}" onclick="_openScenChatById('${s.id}')">
            <div class="top">
              <span class="cb${isChecked ? ' on' : ''}" onclick="event.stopPropagation();toggleHistCard('${s.id}','scen',this)">${isChecked ? '✓' : ''}</span>
              <span class="tsb">${escHtml(tsId)}</span>
              <span class="prio ${_prioClass(s.priority)}">${(s.priority || 'MED').toUpperCase()}</span>
            </div>
            <div class="ti scti" onclick="event.stopPropagation();_editHistScenById('${s.id}')" title="Click to view / edit">${escHtml(tsId + ' ' + _cleanScenTitle(s.title))}</div>
            <div class="ml">${escHtml(s.module || '')}</div>
            <div class="tags">
              ${s.type ? `<span class="tg fn">${s.type.toUpperCase()}</span>` : ''}
              ${(s.tags || []).map(t => `<span class="tg out">${escHtml(t)}</span>`).join('')}
            </div>
            <div class="scard-actions" onclick="event.stopPropagation()">
              <span class="scard-btn" onclick="_editHistScenByIdInEditMode('${s.id}')">✏ Edit</span>
              <span class="scard-btn del" onclick="deleteHistScenario('${s.id}', '${genId}')">✕ Delete</span>
            </div>
          </div>`;
        }).join('');
      })()}
    </div>`;

  // Store scenarios for floating chat context
  HistState.currentScenarios = scenarios;
  updateAiChatCtxLabel();

  // Sync to State so export / add work from history
  State.scenarios = scenarios.map(s => ({
    id: s.sc_id || s.id, title: s.title, module: s.module || '',
    description: s.description || '', type: s.type || 'functional',
    priority: s.priority || 'medium',
    tags: s.tags || [], acceptance_criteria: s.acceptance_criteria || [],
  }));
  renderScenarios();
}

// ── Delete an entire generation row ────────────────────────────────────────────
async function deleteHistGeneration(genId, kind) {
  const msg = kind === 'tc'
    ? 'Delete all test cases for this generation? (Scenarios will be preserved.)'
    : 'Delete this entire generation and all its scenarios/test cases?';
  if (!confirm(msg)) return;
  try {
    // For TC deletions, only archive test cases — keep the generation row and scenarios intact
    if (kind === 'tc') {
      await apiFetch(`/api/history/generations/${genId}/test-cases`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
    } else {
      await apiFetch(`/api/history/generations/${genId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID }),
      });
    }
    // Clear selection if the deleted generation was active
    if (kind === 'scen' && HistState.selectedScenGenId === genId) {
      HistState.selectedScenGenId = null;
      HistState.checkedScenIds.clear();
      const detail = document.getElementById('scenHistDetail');
      if (detail) detail.innerHTML = '<div style="color:#615a4b;font-size:11px;padding:8px 0">Select a generation on the left to review its scenarios.</div>';
      // Also clear the live working state
      if (State.currentGenerationId === genId) {
        State.scenarios = []; State.currentGenerationId = null; renderScenarios();
      }
    }
    if (kind === 'tc' && HistState.selectedTcGenId === genId) {
      HistState.selectedTcGenId = null;
      HistState.checkedTcIds.clear();
      const detail = document.getElementById('tcHistDetail');
      if (detail) detail.innerHTML = '<div style="color:#615a4b;font-size:11px;padding:8px 0">Select a generation to see its test cases.</div>';
      // Only clear test cases from live state — do NOT touch scenarios
      if (State.currentGenerationId === genId) {
        State.testcases = []; renderTestCases();
      }
    }
    toast(kind === 'tc' ? 'Test cases deleted' : 'Generation deleted', 'success');
    if (kind === 'scen') loadScenHistory();
    else                  loadTcHistory();
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

// ── Edit / Delete handlers for history cards ───────────────────────────────────

function editHistScenario(scenId, item, mode = 'view') {
  openScenarioEditModal({
    id:                   item.sc_id || scenId,
    title:                item.title || '',
    module:               item.module || '',
    description:          item.description || '',
    type:                 item.type || 'functional',
    priority:             item.priority || 'medium',
    tags:                 item.tags || [],
    acceptance_criteria:  item.acceptance_criteria || [],
  }, false, mode);
  window._histEditScenId = scenId;
  window._histEditGenId  = HistState.selectedScenGenId;
}

async function deleteHistScenario(scenId, genId) {
  if (!confirm('Delete this scenario from history?')) return;
  try {
    await apiFetch(`/api/history/scenarios/${scenId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, status: 'archived' }),
    });
    // Resolve human-readable sc_id from cache (State uses "TS-001", history uses DB UUID)
    const cached    = window._histScenCache?.[scenId];
    const scDispId  = cached?.sc_id || null;
    const before    = State.scenarios.length;
    State.scenarios = State.scenarios.filter(s =>
      s.id !== scenId && s.id !== scDispId
    );
    if (State.scenarios.length !== before) renderScenarios();
    toast('Scenario deleted', 'success');
    await selectScenGeneration(genId);
    loadScenHistory();
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

function editHistTc(tcId, item, mode = 'view') {
  // Reuse existing TC modal
  openTcEditModal({
    id:               item.tc_id || tcId,
    scenario_id:      item.parent_sc_id || item.sc_id || '',
    title:            item.title || '',
    module:           item.module || '',
    priority:         item.priority || 'Medium',
    type:             item.type || 'Functional',
    preconditions:    item.preconditions || [],
    steps:            item.steps || [],
    expected_result:  item.expected_result || '',
    automation_notes: item.automation_notes || '',
    labels:           item.labels || [],
    status:           item.status || 'Not Executed',
  }, false, mode);
  // Store context so saveTcEdit can persist to DB
  window._histEditTcId    = tcId;
  window._histEditTcGenId = HistState.selectedTcGenId;
}

async function deleteHistTc(tcId, genId) {
  if (!confirm('Delete this test case from history?')) return;
  try {
    await apiFetch(`/api/history/test-cases/${tcId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, status: 'archived' }),
    });
    // Resolve human-readable tc_id from cache (State uses "TC-001", history uses DB UUID)
    const cached   = window._histTcCache?.[tcId];
    const tcDispId = cached?.tc_id || null;
    const before   = State.testcases.length;
    State.testcases = State.testcases.filter(t =>
      t.id !== tcId && t.id !== tcDispId
    );
    if (State.testcases.length !== before) renderTestCases();
    toast('Test case deleted', 'success');
    await selectTcGeneration(genId);
    loadTcHistory();
  } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
}

function loadScenariosFromHistory(scenarios) {
  State.scenarios = scenarios.map(s => ({
    id: s.sc_id || s.id, title: s.title, module: s.module || '',
    description: s.description || '', type: s.type || 'functional',
    priority: s.priority || 'medium',
    tags: s.tags || [], acceptance_criteria: s.acceptance_criteria || [],
  }));
  State.selectedScenarioIds.clear();
  renderScenarios();
  toast(`Loaded ${scenarios.length} scenarios into editor`, 'success');
}

async function generateTcsFromHistory(genId) {
  const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
  if (!r.success) return;

  const all = r.scenarios || [];

  // Use only checked scenarios if any are checked; otherwise use all
  const checkedDbIds = HistState.checkedScenIds;
  const filtered = checkedDbIds.size > 0
    ? all.filter(s => checkedDbIds.has(s.id))
    : all;

  if (!filtered.length) {
    toast('No scenarios to generate from — select at least one.', 'warn');
    return;
  }

  State.scenarios = filtered.map(s => ({
    id: s.sc_id || s.id, title: s.title, module: s.module || '',
    priority: s.priority || 'medium', type: s.type || 'functional',
    tags: s.tags || [], acceptance_criteria: s.acceptance_criteria || [],
  }));
  State.selectedScenarioIds.clear();
  State.selectedScenarioIds = new Set(State.scenarios.map(s => s.id));

  // Sync State.testcases with what's actually persisted for this generation
  // so the TC offset is accurate (handles deletions from history)
  const existingTcs = (r.testcases || []).map((tc, i) => ({
    id: tc.tc_id || tc.id || `TC-${String(i + 1).padStart(3, '0')}`,
    scenario_id: tc.scenario_id || tc.sc_id || '',
    title: tc.title || '', module: tc.module || '',
    priority: tc.priority || 'Medium', type: tc.type || 'Functional',
    preconditions: tc.preconditions || [], test_data: tc.test_data || {},
    steps: tc.steps || [], expected_result: tc.expected_result || '',
    status: tc.status || 'Not Executed', automation_notes: tc.automation_notes || '',
    labels: tc.labels || [], jira_fields: tc.jira_fields || {},
  }));
  State.testcases = existingTcs;

  // Link TC generation to the SAME history row as the scenarios
  State.currentGenerationId = genId;

  const label = checkedDbIds.size > 0
    ? `${filtered.length} selected scenario${filtered.length > 1 ? 's' : ''}`
    : `all ${filtered.length} scenarios`;
  const existingCount = State.testcases.length;
  toast(`Generating test cases for ${label}${existingCount ? ` — appending to ${existingCount} existing` : ''}…`, 'info');

  await generateTestCases();
}

// ── TC History ──────────────────────────────────────────────────────────────────
async function loadTcHistory() {
  try {
    const r = await apiFetch(`/api/history/generations?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) return;
    const list  = document.getElementById('tcHistList');
    const count = document.getElementById('tcHistCount');
    if (count) count.textContent = r.generations.length;
    if (!list) return;
    if (!r.generations.length) {
      list.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No history yet.</div>';
      return;
    }
    list.innerHTML = r.generations.map(g => {
      const isActive = g.id === HistState.selectedTcGenId;
      const hasTcs   = g.tc_count > 0;
      return `<div class="gen gen-compact${isActive ? ' selt' : ''}" onclick="selectTcGeneration('${g.id}')">
        <div class="gen-compact-row">
          <span class="gt">${escHtml(g.title)}</span>
          <div class="gen-row-actions" onclick="event.stopPropagation()">
            <span class="gen-del-btn" onclick="deleteHistGeneration('${g.id}','tc')">✕</span>
          </div>
        </div>
      </div>`;
    }).join('');
  } catch (e) { console.warn('[History] loadTcHistory:', e.message); }
}

function _syncAddTcBtn() {
  const btn = document.querySelector('#step4 .mc-actions .act[onclick="addNewTestCase()"]');
  if (!btn) return;
  const enabled = !!(HistState.selectedTcGenId || State.currentGenerationId);
  btn.style.opacity      = enabled ? '' : '0.35';
  btn.style.pointerEvents = enabled ? '' : 'none';
  btn.title              = enabled ? '' : 'Select a generation in History first';
}

async function selectTcGeneration(genId) {
  HistState.selectedTcGenId = genId;
  _syncAddTcBtn();
  _syncRegenTcBtn();
  await loadTcHistory();

  const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
  if (!r.success) return;

  const tcs    = r.testcases || [];
  const detail = document.getElementById('tcHistDetail');
  if (!detail) return;

  if (!tcs.length) {
    detail.innerHTML = '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No test cases generated for this requirement yet.</div>';
    return;
  }

  // Store TCs in a lookup map so onclick attrs only need to pass an ID (avoids JSON-in-HTML issues)
  window._histTcCache = window._histTcCache || {};
  tcs.forEach(tc => { window._histTcCache[tc.id] = tc; });

  detail.innerHTML = `
    <div class="seltool">
      <span class="selcount"><b id="tcSelCount">${HistState.checkedTcIds.size}</b> of ${tcs.length} selected</span>
      <span class="lnk" onclick="selectAllHistCards('tc')">Select all</span>
      <span class="lnk" onclick="clearAllHistCards('tc')">Clear</span>
      <span class="lnk del" onclick="deleteSelectedTestCases()">🗑 Delete Selected</span>
    </div>
    <div class="cards">
      ${tcs.map(tc => {
        const isChecked = HistState.checkedTcIds.has(tc.id);
        const parentTs  = tc.parent_sc_id ? tc.parent_sc_id.replace(/-/g,'').replace(/^TC/i,'TS') : '';
        return `<div class="scard${isChecked ? ' checkedt' : ''}" data-item-id="${tc.id}" onclick="_openTcChatById('${tc.id}')">
          <div class="top">
            <span class="cb${isChecked ? ' ont' : ''}" onclick="event.stopPropagation();toggleHistCard('${tc.id}','tc',this)">${isChecked ? '✓' : ''}</span>
            <span class="tsb">${escHtml(tc.tc_id || tc.id.slice(0,10))}</span>
            ${parentTs ? `<span class="tsb" style="color:#b8d4f5;background:rgba(93,140,202,.14);border-color:rgba(93,140,202,.3)" title="Parent scenario">${escHtml(parentTs)}</span>` : ''}
            <span class="prio ${_prioClass(tc.priority)}">${(tc.priority || 'MED').toUpperCase()}</span>
          </div>
          <div class="ti scti" onclick="event.stopPropagation();_editHistTcById('${tc.id}')" title="Click to edit / view details">${escHtml(tc.title)}</div>
          <div class="ml">${(tc.steps||[]).length} steps${tc.jira_key ? ` · ✓ ${tc.jira_key}` : ''}</div>
          <div class="tags">
            ${tc.type ? `<span class="tg fn">${tc.type.toUpperCase()}</span>` : ''}
          </div>
          <div class="scard-actions" onclick="event.stopPropagation()">
            <span class="scard-btn" onclick="_editHistTcByIdInEditMode('${tc.id}')">✏ Edit</span>
            <span class="scard-btn" style="color:#f4c869;border-color:rgba(244,200,105,.3)" onclick="_automateHistTcById('${tc.id}')">🤖 Automate</span>
            <span class="scard-btn del" onclick="deleteHistTc('${tc.id}', '${genId}')">✕ Delete</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;

  // Store TCs for floating chat context
  HistState.currentTestCases = tcs;
  updateAiChatCtxLabel();

  // Sync to State so export / add / render work from history
  State.testcases = tcs.map(tc => ({
    id: tc.tc_id || tc.id, title: tc.title, module: tc.module || '',
    priority: tc.priority || 'Medium', type: tc.type || 'Functional',
    preconditions: tc.preconditions || [], steps: tc.steps || [],
    expected_result: tc.expected_result || '',
    labels: tc.labels || [], automation_notes: tc.automation_notes || '',
    status: tc.status || 'Not Executed',
    jira_fields: tc.jira_fields || { issue_type: '', priority: tc.priority || 'Medium', labels: [], components: [] },
  }));
  renderTestCases();
}

function loadTcsFromHistory(tcs) {
  State.testcases = tcs.map(tc => ({
    id: tc.tc_id || tc.id, title: tc.title, module: tc.module || '',
    priority: tc.priority || 'Medium', type: tc.type || 'Functional',
    preconditions: tc.preconditions || [], steps: tc.steps || [],
    expected_result: tc.expected_result || '',
    labels: tc.labels || [], automation_notes: tc.automation_notes || '',
    status: tc.status || 'Not Executed',
    jira_fields: { issue_type: '', priority: tc.priority || 'Medium', labels: [], components: [] },
  }));
  renderTestCases();
  toast(`Loaded ${tcs.length} test cases into editor`, 'success');
}

async function pushHistoryTcsToJira(genId) {
  const r = await apiFetch(`/api/history/generations/${genId}?clientId=${CLIENT_ID}`).then(x => x.json());
  if (!r.success) return;
  loadTcsFromHistory(r.testcases || []);
  await bulkCreateTestCases();
}

// ── Chat helpers ────────────────────────────────────────────────────────────────
// (Legacy stubs kept for JS compat — old panels removed)
function openScenChat() {}
function openTcChat() {}
function loadChatHistory() {}
function sendHistChat() {}

// ══════════════════════════════════════════════════════════════════════════════
//  FLOATING AI FEEDBACK CHAT
// ══════════════════════════════════════════════════════════════════════════════
let _aiChatOpen = false;
let _aiChatLoaded = false;

function toggleAiChat() {
  _aiChatOpen = !_aiChatOpen;
  const widget = document.getElementById('aiChatWidget');
  widget.classList.toggle('collapsed', !_aiChatOpen);
  if (_aiChatOpen && !_aiChatLoaded) {
    _aiChatLoaded = true;
    loadAiChatHistory();
  }
  if (_aiChatOpen) {
    updateAiChatCtxLabel();
    setTimeout(() => document.getElementById('aiChatInput')?.focus(), 100);
  }
}

function updateAiChatCtxLabel() {
  const label = document.getElementById('aiChatCtxLabel');
  if (!label) return;
  const step = State.currentStep || 1;
  const scenSel = HistState.checkedScenIds?.size || 0;
  const tcSel   = HistState.checkedTcIds?.size || 0;
  if (scenSel > 0) {
    label.textContent = `⚡ ${scenSel} scenario${scenSel > 1 ? 's' : ''} selected`;
    label.style.color = '#f4c869';
  } else if (tcSel > 0) {
    label.textContent = `⚡ ${tcSel} TC${tcSel > 1 ? 's' : ''} selected`;
    label.style.color = '#f4c869';
  } else {
    const scenCount = HistState.currentScenarios?.length || 0;
    const tcCount = HistState.currentTestCases?.length || 0;
    let text = '';
    if (step === 3 && HistState.selectedScenGenId && scenCount) {
      text = `Context: ${scenCount} Scenario${scenCount > 1 ? 's' : ''}`;
    } else if (step === 4 && HistState.selectedTcGenId && tcCount) {
      text = `Context: ${tcCount} Test Case${tcCount > 1 ? 's' : ''}`;
    } else {
      const parts = [];
      if (State.parsedInputs?.length) parts.push('Req');
      if (HistState.selectedScenGenId && scenCount) parts.push(`${scenCount} Scen`);
      if (HistState.selectedTcGenId && tcCount) parts.push(`${tcCount} TCs`);
      text = parts.length ? parts.join(' + ') : `Step ${step}`;
    }
    label.textContent = text;
    label.style.color = '';
  }
}

async function loadAiChatHistory() {
  try {
    const r = await apiFetch(`/api/chat/history?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) return;
    const container = document.getElementById('aiChatMessages');
    if (!container) return;
    if (r.messages && r.messages.length) {
      // Clear welcome message, show history
      container.innerHTML = '';
      r.messages.forEach(m => {
        _addAiChatBubble(m.role, m.content, m.knowledge);
      });
    }
  } catch (e) { console.warn('[AiChat] load:', e.message); }
}

function _getAiChatContext() {
  const ctx = {};

  // Requirements text
  const reqEl = document.getElementById('requirements');
  const usEl = document.getElementById('userStory');
  const quickEl = document.getElementById('orchQuickInput');
  const reqText = [usEl?.value, reqEl?.value, quickEl?.value].filter(Boolean).join('\n');
  if (reqText.trim()) ctx.requirements = reqText.trim();

  // Current scenarios from history selection
  if (HistState.selectedScenGenId && HistState.currentScenarios?.length) {
    ctx.scenarios = HistState.currentScenarios;
  }

  // Current test cases from history selection
  if (HistState.selectedTcGenId && HistState.currentTestCases?.length) {
    ctx.testcases = HistState.currentTestCases;
  }

  // Module
  ctx.module = document.getElementById('appName')?.value || null;

  return ctx;
}

async function sendAiChat() {
  const input = document.getElementById('aiChatInput');
  const text = input?.value?.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';

  // Check if user has selected items — route to bulk update
  const scenSel = [...(HistState.checkedScenIds || [])];
  const tcSel   = [...(HistState.checkedTcIds || [])];
  const hasBulkSelection = scenSel.length > 0 || tcSel.length > 0;

  // Detect action intent (change/update/set/add/remove keywords)
  const actionPattern = /\b(change|update|set|make|add|remove|delete|replace|rename|move|assign|append|prefix|suffix|clear)\b/i;
  const isBulkAction = hasBulkSelection && actionPattern.test(text);

  if (isBulkAction) {
    return _sendBulkUpdate(text, scenSel, tcSel);
  }

  // Add user bubble
  _addAiChatBubble('user', text);

  // Create streaming assistant bubble
  const container = document.getElementById('aiChatMessages');
  const bubble = document.createElement('div');
  bubble.className = 'ai-chat-bubble assistant streaming';
  const span = document.createElement('span');
  span.className = 'bubble-text';
  bubble.appendChild(span);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  try {
    const resp = await fetch(`${window.API_BASE || ''}/api/chat/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        message: text,
        aiOpts: aiOpts(),
        context: _getAiChatContext(),
      }),
    });

    if (!resp.ok || !resp.body) {
      bubble.classList.remove('streaming');
      span.textContent = '❌ Error: ' + resp.statusText;
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'token') {
            span.textContent += event.text;
            container.scrollTop = container.scrollHeight;
          } else if (event.type === 'done') {
            bubble.classList.remove('streaming');
            if (event.displayText) span.textContent = event.displayText;
            if (event.knowledge) {
              const tag = document.createElement('div');
              tag.className = 'learned-tag';
              tag.textContent = '🧠 Saved: "' + event.knowledge.guidance + '"';
              bubble.appendChild(tag);
            }
            container.scrollTop = container.scrollHeight;
          } else if (event.type === 'error') {
            bubble.classList.remove('streaming');
            span.textContent = '❌ ' + event.message;
          }
        } catch {}
      }
    }
  } catch (err) {
    bubble.classList.remove('streaming');
    span.textContent = '❌ ' + err.message;
  }
}

async function _sendBulkUpdate(text, scenIds, tcIds) {
  const itemType = scenIds.length > 0 ? 'scenario' : 'test_case';
  const itemIds  = itemType === 'scenario' ? scenIds : tcIds;

  // Gather item data from cache
  let items = [];
  if (itemType === 'scenario' && HistState.currentScenarios?.length) {
    items = HistState.currentScenarios.filter(s => itemIds.includes(s.id));
  } else if (itemType === 'test_case' && HistState.currentTestCases?.length) {
    items = HistState.currentTestCases.filter(tc => itemIds.includes(tc.id));
  }

  // Show user bubble with context
  _addAiChatBubble('user', `⚡ ${text}\n(${itemIds.length} ${itemType === 'scenario' ? 'scenario' : 'test case'}${itemIds.length > 1 ? 's' : ''} selected)`);

  // Show processing bubble
  const container = document.getElementById('aiChatMessages');
  const bubble = document.createElement('div');
  bubble.className = 'ai-chat-bubble assistant';
  const span = document.createElement('span');
  span.className = 'bubble-text';
  span.textContent = '⏳ Applying changes…';
  bubble.appendChild(span);
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;

  try {
    const resp = await apiFetch('/api/chat/bulk-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: CLIENT_ID,
        message: text,
        itemType,
        itemIds,
        items,
        aiOpts: aiOpts(),
      }),
    });
    const r = await resp.json();

    if (r.success && r.updated > 0) {
      const fieldsList = [...new Set((r.changes || []).flatMap(c => c.fields))].join(', ');
      span.textContent = `✅ Updated ${r.updated} of ${r.total} ${itemType === 'scenario' ? 'scenario' : 'test case'}${r.total > 1 ? 's' : ''}`;
      if (fieldsList) {
        span.textContent += `\nFields changed: ${fieldsList}`;
      }
      // Refresh the history panel to show updates
      if (itemType === 'scenario' && HistState.selectedScenGenId) {
        await selectScenGeneration(HistState.selectedScenGenId);
      } else if (itemType === 'test_case' && HistState.selectedTcGenId) {
        await selectTcGeneration(HistState.selectedTcGenId);
      }
    } else if (r.success && r.updated === 0) {
      span.textContent = '📋 ' + (r.message || 'No changes were needed.');
    } else {
      span.textContent = '❌ ' + (r.error || 'Update failed');
    }
  } catch (err) {
    span.textContent = '❌ ' + err.message;
  }
  container.scrollTop = container.scrollHeight;
}

function _addAiChatBubble(role, text, knowledge) {
  const container = document.getElementById('aiChatMessages');
  if (!container) return;
  // Remove welcome message if present
  const welcome = container.querySelector('.ai-chat-welcome');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `ai-chat-bubble ${role}`;
  const span = document.createElement('span');
  span.className = 'bubble-text';
  span.textContent = text;
  div.appendChild(span);
  if (knowledge && knowledge.guidance) {
    const tag = document.createElement('div');
    tag.className = 'learned-tag';
    tag.textContent = '🧠 Saved: "' + knowledge.guidance + '"';
    div.appendChild(tag);
  }
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function clearAiChat() {
  if (!confirm('Clear all chat history?')) return;
  await apiFetch('/api/chat/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });
  const container = document.getElementById('aiChatMessages');
  if (container) container.innerHTML = `<div class="ai-chat-welcome">
    <p><strong>I have full context</strong> of your requirements, scenarios, test cases, and app flows.</p>
    <p>Give me feedback and I'll remember it for the next generation.</p>
    <p style="margin-top:6px"><strong>⚡ Bulk edits:</strong> Select scenarios or TCs, then type a command.</p>
    <p style="font-size:11px;opacity:.7">Examples: "Change priority to High" · "Add MFA as precondition" · "Set type to Security" · "Remove login tag"</p>
  </div>`;
}

// ── Reference Library ──────────────────────────────────────────────────────────
let _rlAllEntries = [];
let _rlScope = 'all';
let _rlStatusFilter = '';
let _rlModuleFilter = '';

// ── Reference Library full-page open / close ─────────────────────────────────
function openRefLibDrawer() { openRefLibPage(); }   // keep old name working
function openRefLibPage() {
  document.getElementById('rlPage').style.display = 'block';
  document.body.style.overflow = 'hidden';
  window.scrollTo(0, 0);
  loadKnowledge();
  if (typeof loadRefLibraryStatus === 'function') loadRefLibraryStatus();
}
function closeRefLibDrawer() { closeRefLibPage(); }  // keep old name working
function closeRefLibPage() {
  document.getElementById('rlPage').style.display = 'none';
  document.body.style.overflow = '';
}

async function loadKnowledge() {
  try {
    // Load stats
    const statsRes = await apiFetch(`/api/knowledge/stats?clientId=${CLIENT_ID}`).then(r => r.json());
    if (statsRes.success) {
      document.getElementById('rlStatTotal').textContent   = statsRes.total || 0;
      document.getElementById('rlStatPending').textContent = statsRes.pending || 0;
      document.getElementById('rlStatModules').textContent = statsRes.moduleCount || 0;
      document.getElementById('rlStatUses').innerHTML      = `${statsRes.useCount || 0}<small> total</small>`;
      // Update header badge — show pending count if > 0, else total
      const badge = document.getElementById('refLibHeaderBadge');
      if (badge) {
        const n = statsRes.pending > 0 ? statsRes.pending : (statsRes.total || 0);
        badge.textContent = n;
        badge.style.display = n > 0 ? '' : 'none';
        badge.style.background = statsRes.pending > 0 ? '#f4c869' : '#a99af0';
        badge.style.color = '#0a0a08';
      }
    }

    // Load entries
    const r = await apiFetch(`/api/knowledge?clientId=${CLIENT_ID}`).then(x => x.json());
    if (!r.success) return;
    _rlAllEntries = r.entries || [];
    renderKnowledgeRules();
    renderKnowledgeFlow();
    renderKnowledgeSources(statsRes);
  } catch(e) { console.warn('[Knowledge]', e.message); }
}

function renderKnowledgeRules() {
  const all     = _rlAllEntries;
  const modules = [...new Set(all.filter(e => e.module).map(e => e.module))];
  document.getElementById('rlCountAll').textContent      = all.length;
  document.getElementById('rlCountModule').textContent   = all.filter(e => e.module).length;
  document.getElementById('rlCountGlobal').textContent   = all.filter(e => !e.module).length;
  document.getElementById('rlCountApproved').textContent = all.filter(e => e.status === 'approved').length;
  document.getElementById('rlCountPending').textContent  = all.filter(e => e.status !== 'approved').length;

  // Module filter chips
  const mf = document.getElementById('rlModuleFilters');
  if (mf) mf.innerHTML = modules.map(m => `
    <div class="rl-ftag${_rlModuleFilter===m?' on':''}" onclick="setKnowledgeModule('${escHtml(m)}',this)">
      ${escHtml(m)} <span class="rl-fn">${all.filter(e=>e.module===m).length}</span>
    </div>`).join('');

  // Filter entries
  const search = (document.getElementById('rlSearch')?.value || '').toLowerCase();
  let entries = all.filter(e => {
    if (_rlScope === 'module' && !e.module) return false;
    if (_rlScope === 'global' &&  e.module) return false;
    if (_rlModuleFilter && e.module !== _rlModuleFilter) return false;
    if (_rlStatusFilter === 'approved' && e.status !== 'approved') return false;
    if (_rlStatusFilter === 'pending'  && e.status === 'approved') return false;
    if (search && !e.guidance?.toLowerCase().includes(search) && !e.module?.toLowerCase().includes(search)) return false;
    return true;
  });

  const list = document.getElementById('knowledgeList');
  if (!list) return;
  if (!entries.length) {
    list.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:24px;text-align:center">No rules match the current filter.</div>';
    return;
  }

  list.innerHTML = entries.map(e => {
    const isPending = e.status !== 'approved';
    const wPct = Math.min(100, (e.weight / 10) * 100);
    const scope = e.module ? e.module : 'GLOBAL';
    const scopeClass = e.module ? 'mod' : 'glob';
    const useCount = e.use_count || 0;
    const isFrd = e.kind === 'requirement';
    const kindLabel = isFrd ? '📄 FRD' : (e.kind || 'rule');
    const kindClass = isFrd ? 'frd' : 'type';

    if (isFrd) {
      // FRD entries: compact card with clickable title → opens full view
      const guidanceText = e.guidance || '';
      return `<div class="rl-rule frd-entry">
        <div class="r-top">
          ${isPending
            ? '<span class="rl-chip pend">⏳ pending review</span>'
            : '<span class="rl-chip appr">✓ approved</span>'}
          <span class="rl-chip ${scopeClass}">${escHtml(scope)}</span>
          <span class="rl-chip ${kindClass}">${escHtml(kindLabel)}</span>
          <span class="rl-chip frd-size">${Math.round(guidanceText.length/1024)}KB</span>
          <div class="rl-weight">
            ${useCount > 0 ? `reinforced ×${useCount}` : 'new'}
            <div class="rl-wbar"><i style="width:${wPct}%"></i></div>
          </div>
        </div>
        <div class="rl-frd-title" onclick="openFrdFullView('${e.id}')">${escHtml(e.trigger_text || 'Untitled FRD')}</div>
        <div class="rl-foot">
          <span class="rl-prov">
            ${e.source_item_type ? `↩ from <b>${escHtml(e.source_item_type)}</b>` : '📝 curated'}
            · w${e.weight.toFixed(1)}
          </span>
          <div class="rl-acts">
            ${isPending ? `<span class="rl-act appr" onclick="approveKnowledge('${e.id}')">✓ Approve</span>` : ''}
            <span class="rl-act del" onclick="deleteKnowledge('${e.id}')">${isPending ? '✕ Reject' : '✕ Delete'}</span>
          </div>
        </div>
      </div>`;
    }

    // Regular rules: show guidance inline
    return `<div class="rl-rule${isPending ? ' pending' : ''}">
      <div class="r-top">
        ${isPending
          ? '<span class="rl-chip pend">⏳ pending review</span>'
          : '<span class="rl-chip appr">✓ approved</span>'}
        <span class="rl-chip ${scopeClass}">${escHtml(scope)}</span>
        <span class="rl-chip ${kindClass}">${escHtml(kindLabel)}</span>
        <div class="rl-weight">
          ${useCount > 0 ? `reinforced ×${useCount}` : 'new'}
          <div class="rl-wbar"><i style="width:${wPct}%"></i></div>
        </div>
      </div>
      <div class="rl-stmt">${escHtml(e.guidance)}</div>
      <div class="rl-foot">
        <span class="rl-prov">
          ${e.source_item_type ? `↩ from <b>${escHtml(e.source_item_type)}</b>` : '📝 curated'}
          ${e.trigger_text ? ` · <em>${escHtml(e.trigger_text.slice(0,50))}</em>` : ''}
          · w${e.weight.toFixed(1)}
        </span>
        <div class="rl-acts">
          ${isPending ? `<span class="rl-act appr" onclick="approveKnowledge('${e.id}')">✓ Approve</span>` : ''}
          <span class="rl-act edit" onclick="openEditKnowledge('${e.id}')">✏ Edit</span>
          <span class="rl-act edit" onclick="bumpKnowledge('${e.id}')">↑ Boost</span>
          <span class="rl-act del" onclick="deleteKnowledge('${e.id}')">${isPending ? '✕ Reject' : '✕ Delete'}</span>
        </div>
      </div>
    </div>`;
  }).join('');
}

// ── App Flow Map ──────────────────────────────────────────────────────────────
let _flowEditStepCount = 0;

async function loadFlows() {
  try {
    const r = await apiFetch(`/api/flows?clientId=${CLIENT_ID}`).then(x => x.json());
    renderFlowMap(r.flows || []);
  } catch(e) { console.warn('[Flows]', e.message); }
}

function renderFlowMap(flows) {
  const el = document.getElementById('rlFlowContent');
  if (!el) return;

  if (!flows.length) {
    el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:24px;text-align:center">No flows yet — click <strong>+ New Flow</strong> or <strong>🎨 From Figma / AI</strong> to create one.</div>';
    return;
  }

  el.innerHTML = flows.map(flow => {
    const steps = flow.steps || [];
    return `<div class="af-flow" id="af-flow-${flow.id}">
      <div class="af-flow-header">
        <div>
          <div class="af-flow-name">${escHtml(flow.name)}</div>
          ${flow.module ? `<span class="rl-chip mod" style="font-size:9.5px">${escHtml(flow.module)}</span>` : ''}
          ${flow.description ? `<span class="af-flow-desc">${escHtml(flow.description)}</span>` : ''}
        </div>
        <div class="af-flow-actions">
          <button class="cn-btn" onclick="openEditFlowModal('${flow.id}')">✏ Edit</button>
          <button class="cn-btn del" onclick="deleteFlow('${flow.id}')">✕ Delete</button>
        </div>
      </div>
      ${steps.length ? `
      <div class="af-steps">
        ${steps.map((s, i) => `
          <div class="af-node">
            <div class="fn-t"><span class="fn-num">${i+1}</span>${escHtml(s.title || 'Step')}</div>
            ${s.description ? `<div class="fn-fact">${escHtml(s.description)}</div>` : ''}
            ${s.rule ? `<div class="fn-rule">⚠ ${escHtml(s.rule)}</div>` : ''}
            ${s.tc_count ? `<div class="fn-ev">📋 ${s.tc_count} TCs</div>` : ''}
          </div>
          ${i < steps.length - 1 ? '<div class="rl-farrow">→</div>' : ''}
        `).join('')}
      </div>` : '<div style="color:var(--text-dim);font-size:11px;padding:8px 0">No steps — click Edit to add steps.</div>'}
    </div>`;
  }).join('');
}

// Called from loadKnowledge (compat) and setKnowledgeMode
function renderKnowledgeFlow() {
  loadFlows();
}

function openNewFlowModal() {
  document.getElementById('flowEditTitle').textContent = 'New App Flow';
  document.getElementById('flowEditId').value = '';
  document.getElementById('flowEditName').value = '';
  document.getElementById('flowEditModule').value = '';
  document.getElementById('flowEditDesc').value = '';
  _flowEditStepCount = 0;
  document.getElementById('flowStepsList').innerHTML = '';
  addFlowStep(); // start with one empty step
  document.getElementById('flowEditModal').style.display = 'flex';
}

async function openEditFlowModal(id) {
  try {
    const r = await apiFetch(`/api/flows?clientId=${CLIENT_ID}`).then(x => x.json());
    const flow = (r.flows || []).find(f => f.id === id);
    if (!flow) return;
    document.getElementById('flowEditTitle').textContent = 'Edit Flow — ' + flow.name;
    document.getElementById('flowEditId').value = flow.id;
    document.getElementById('flowEditName').value = flow.name || '';
    document.getElementById('flowEditModule').value = flow.module || '';
    document.getElementById('flowEditDesc').value = flow.description || '';
    _flowEditStepCount = 0;
    const list = document.getElementById('flowStepsList');
    list.innerHTML = '';
    (flow.steps || []).forEach(s => addFlowStep(s));
    document.getElementById('flowEditModal').style.display = 'flex';
  } catch(e) { toast('Could not load flow: ' + e.message, 'error'); }
}

function closeFlowEditModal() { document.getElementById('flowEditModal').style.display = 'none'; }

function addFlowStep(data = {}) {
  const idx = _flowEditStepCount++;
  const list = document.getElementById('flowStepsList');
  const div = document.createElement('div');
  div.className = 'af-step-edit';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="af-step-num">${idx + 1}</div>
    <div class="af-step-fields">
      <input class="form-control af-step-title" placeholder="Step title (e.g. Draft Save)" value="${escHtml(data.title || '')}" />
      <input class="form-control af-step-desc"  placeholder="Description (what the user does/sees)" value="${escHtml(data.description || '')}" style="margin-top:5px"/>
      <input class="form-control af-step-rule"  placeholder="Rule / validation note (optional)" value="${escHtml(data.rule || '')}" style="margin-top:5px"/>
    </div>
    <div class="af-step-controls">
      <button class="cn-btn" onclick="moveFlowStep(this,-1)" title="Move up">↑</button>
      <button class="cn-btn" onclick="moveFlowStep(this,1)"  title="Move down">↓</button>
      <button class="cn-btn del" onclick="this.closest('.af-step-edit').remove();_renumberSteps()" title="Remove">✕</button>
    </div>`;
  list.appendChild(div);
}

function moveFlowStep(btn, dir) {
  const row = btn.closest('.af-step-edit');
  const list = document.getElementById('flowStepsList');
  const rows = [...list.children];
  const idx = rows.indexOf(row);
  const target = rows[idx + dir];
  if (!target) return;
  if (dir === -1) list.insertBefore(row, target);
  else target.after(row);
  _renumberSteps();
}

function _renumberSteps() {
  [...document.querySelectorAll('#flowStepsList .af-step-edit')].forEach((r, i) => {
    const num = r.querySelector('.af-step-num');
    if (num) num.textContent = i + 1;
  });
}

function _collectFlowSteps() {
  return [...document.querySelectorAll('#flowStepsList .af-step-edit')].map(r => ({
    title:       r.querySelector('.af-step-title')?.value.trim() || '',
    description: r.querySelector('.af-step-desc')?.value.trim()  || '',
    rule:        r.querySelector('.af-step-rule')?.value.trim()   || null,
    tc_count:    0,
  })).filter(s => s.title);
}

async function saveFlowEdit() {
  const name = document.getElementById('flowEditName').value.trim();
  if (!name) { toast('Flow name is required', 'warn'); return; }
  const id     = document.getElementById('flowEditId').value;
  const module = document.getElementById('flowEditModule').value.trim() || null;
  const desc   = document.getElementById('flowEditDesc').value.trim() || null;
  const steps  = _collectFlowSteps();

  try {
    if (id) {
      await apiFetch(`/api/flows/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, name, module, description: desc, steps }),
      });
      toast('Flow updated', 'success');
    } else {
      await apiFetch('/api/flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, name, module, description: desc, steps, source: 'manual' }),
      });
      toast('Flow created', 'success');
    }
    closeFlowEditModal();
    loadFlows();
  } catch(e) { toast('Save failed: ' + e.message, 'error'); }
}

async function deleteFlow(id) {
  if (!confirm('Delete this app flow?')) return;
  await apiFetch(`/api/flows/${id}?clientId=${CLIENT_ID}`, { method: 'DELETE' });
  loadFlows();
  toast('Flow deleted', 'success');
}

async function deleteAllFlows() {
  if (!confirm('Delete ALL app flows? This cannot be undone.')) return;
  try {
    const r = await apiFetch(`/api/flows?clientId=${CLIENT_ID}`).then(x => x.json());
    const flows = r.flows || [];
    for (const f of flows) {
      await apiFetch(`/api/flows/${f.id}?clientId=${CLIENT_ID}`, { method: 'DELETE' });
    }
    loadFlows();
    toast(`${flows.length} flow(s) deleted`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function uploadFigmaToFlows() {
  const input = document.getElementById('flowFigmaFileInput');
  if (!input.files?.length) return;

  const statusEl = document.getElementById('flowUploadStatus');
  statusEl.style.display = '';
  statusEl.textContent = '⏳ Analyzing screenshots with AI — this may take a moment…';

  const formData = new FormData();
  formData.append('clientId', CLIENT_ID);
  for (const file of input.files) {
    formData.append('files', file);
  }
  const ai = aiOpts();
  Object.entries(ai).forEach(([k, v]) => { if (v) formData.append(k, v); });

  try {
    const res = await fetch('/api/app-map/figma-upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    statusEl.innerHTML = `<span style="color:var(--success)">✓ Flow created: "${escHtml(data.flow?.name || 'Flow')}" — ${data.totalPages} steps</span>`;
    toast(`Flow created from ${input.files.length} screenshot(s)`, 'success');
    input.value = '';
    loadFlows();
    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${escHtml(e.message)}</span>`;
    toast(e.message, 'error');
    input.value = '';
  }
}

// ── Fetch From Figma — 2-step modal ──────────────────────────────────────────
let _pullFigmaStep = 1;

function openPullFigmaModal() {
  _pullFigmaStep = 1;
  document.getElementById('pullFigmaUrl').value = getSetting('figmaFileUrl') || '';
  document.getElementById('pullFigmaStep1').style.display = '';
  document.getElementById('pullFigmaStep2').style.display = 'none';
  document.getElementById('pullFigmaFetchStatus').style.display = 'none';
  document.getElementById('pullFigmaProgress').style.display = 'none';
  document.getElementById('pullFigmaResults').innerHTML = '';
  document.getElementById('pullFigmaBackBtn').style.display = 'none';
  const btn = document.getElementById('pullFigmaBtn');
  btn.disabled = false; btn.textContent = '🔍 Fetch Pages';
  document.getElementById('pullFigmaModal').style.display = 'flex';
}
function closePullFigmaModal() { document.getElementById('pullFigmaModal').style.display = 'none'; }
function pullFigmaGoBack() {
  _pullFigmaStep = 1;
  document.getElementById('pullFigmaStep1').style.display = '';
  document.getElementById('pullFigmaStep2').style.display = 'none';
  document.getElementById('pullFigmaBackBtn').style.display = 'none';
  const btn = document.getElementById('pullFigmaBtn');
  btn.disabled = false; btn.textContent = '🔍 Fetch Pages';
}
function pullFigmaSelectAll(select) {
  document.querySelectorAll('#pullFigmaPageList .pf-cb').forEach(cb => { cb.checked = select; });
}
function pullFigmaAction() {
  if (_pullFigmaStep === 1) _pullFigmaFetchPages();
  else                      _pullFigmaPullSelected();
}

// Step 1 — fetch pages list from Figma (no AI, fast)
async function _pullFigmaFetchPages() {
  const url = document.getElementById('pullFigmaUrl').value.trim();
  if (!url) { toast('Paste a Figma file URL first', 'warn'); return; }

  const btn    = document.getElementById('pullFigmaBtn');
  const status = document.getElementById('pullFigmaFetchStatus');
  btn.disabled = true; btn.textContent = '⏳ Fetching…';
  status.style.display = '';

  try {
    const r = await apiFetch('/api/flows/figma-pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figmaFileUrl: url, figmaToken: getSetting('figmaToken') }),
    }).then(x => x.json());

    if (!r.success) throw new Error(r.error);

    // Save URL for next time
    State.settings.figmaFileUrl = url;
    localStorage.setItem('qahub_settings', JSON.stringify(State.settings));

    // Store fileKey + fileName for step 2
    window._pullFigmaFileKey  = r.fileKey;
    window._pullFigmaFileName = r.fileName;
    window._pullFigmaPageMap  = Object.fromEntries(r.pages.map(p => [p.name, p.id]));

    // Populate page checklist (no frame count — we didn't fetch at depth=2)
    document.getElementById('pullFigmaFileName').textContent = `📁 ${r.fileName}`;
    document.getElementById('pullFigmaPageCount').textContent = `${r.pages.length} page${r.pages.length !== 1 ? 's' : ''} found`;
    document.getElementById('pullFigmaPageList').innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;font-size:12px">
        <a href="#" onclick="document.querySelectorAll('#pullFigmaPageList .pf-cb').forEach(c=>c.checked=true);return false" style="color:var(--accent)">Select All</a>
        <span style="color:var(--text-dim)">|</span>
        <a href="#" onclick="document.querySelectorAll('#pullFigmaPageList .pf-cb').forEach(c=>c.checked=false);return false" style="color:var(--accent)">None</a>
      </div>` + r.pages.map(p => `
      <label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;cursor:pointer;background:var(--bg-card)">
        <input type="checkbox" class="pf-cb" value="${escHtml(p.name)}" style="flex-shrink:0" />
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(p.name)}</div>
        </div>
      </label>`).join('');

    // Switch to step 2
    _pullFigmaStep = 2;
    document.getElementById('pullFigmaStep1').style.display = 'none';
    document.getElementById('pullFigmaStep2').style.display = '';
    document.getElementById('pullFigmaBackBtn').style.display = '';
    btn.disabled = false; btn.textContent = '📥 Pull Selected';
  } catch (e) {
    status.style.display = 'none';
    const is429 = e.message && (e.message.includes('rate limit') || e.message.includes('429'));
    if (is429) {
      // Show inline token renewal prompt
      let tokenBox = document.getElementById('pullFigmaTokenRetry');
      if (!tokenBox) {
        const wrap = document.createElement('div');
        wrap.id = 'pullFigmaTokenRetry';
        wrap.style.cssText = 'margin-top:12px;padding:12px;border:1px solid var(--warn);border-radius:8px;background:var(--bg-card)';
        wrap.innerHTML = `
          <div style="font-size:12px;color:var(--warn);margin-bottom:8px;font-weight:600">⚠ Figma token rate-limited</div>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Generate a new token at <a href="https://www.figma.com/developers/api#access-tokens" target="_blank" style="color:var(--accent)">figma.com/developers</a> and paste below:</div>
          <div style="display:flex;gap:8px">
            <input id="pullFigmaNewToken" type="password" class="form-control" placeholder="figd_…" style="flex:1;font-size:13px" />
            <button onclick="_pullFigmaRetryWithToken()" class="btn btn-sm btn-primary" style="white-space:nowrap">🔄 Retry</button>
          </div>`;
        document.getElementById('pullFigmaStep1').appendChild(wrap);
      } else {
        tokenBox.style.display = '';
      }
    }
    toast(e.message, 'error');
    btn.disabled = false; btn.textContent = '🔍 Fetch Pages';
  }
}

// Retry fetch pages with a new Figma token
async function _pullFigmaRetryWithToken() {
  const newToken = document.getElementById('pullFigmaNewToken')?.value?.trim();
  if (!newToken) { toast('Paste your new Figma token', 'warn'); return; }

  // Save to settings
  const settField = document.getElementById('settFigmaToken');
  if (settField) settField.value = newToken;
  State.settings.figmaToken = newToken;
  localStorage.setItem('qahub_settings', JSON.stringify(State.settings));

  // Hide the token box and re-trigger fetch
  const tokenBox = document.getElementById('pullFigmaTokenRetry');
  if (tokenBox) tokenBox.style.display = 'none';

  toast('Token updated — retrying…', 'info');
  _pullFigmaFetchPages();
}

// Step 2 — generate flows for selected pages using /nodes (no full file download)
async function _pullFigmaPullSelected() {
  const selectedNames = [...document.querySelectorAll('#pullFigmaPageList .pf-cb:checked')].map(cb => cb.value);
  if (!selectedNames.length) { toast('Select at least one page', 'warn'); return; }

  // Build { id, name } array using the map stored in step 1
  const pageMap     = window._pullFigmaPageMap || {};
  const selectedPages = selectedNames.map(name => ({ id: pageMap[name], name })).filter(p => p.id);
  const btn      = document.getElementById('pullFigmaBtn');
  const progress = document.getElementById('pullFigmaProgress');
  const results  = document.getElementById('pullFigmaResults');

  btn.disabled = true; btn.textContent = '⏳ Generating…';
  document.getElementById('pullFigmaBackBtn').disabled = true;
  progress.style.display = '';
  document.getElementById('pullFigmaProgressTxt').textContent =
    `processing ${selectedPages.length} page${selectedPages.length !== 1 ? 's' : ''} with AI…`;
  results.innerHTML = '';

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 300000);
    const r = await apiFetch('/api/flows/from-figma-file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId:    CLIENT_ID,
        fileKey:     window._pullFigmaFileKey,
        figmaFileUrl: document.getElementById('pullFigmaUrl')?.value?.trim() || '',
        fileName:    window._pullFigmaFileName,
        saveDirect:  true,
        selectedPages,
        figmaToken:  getSetting('figmaToken'),
        ...aiOpts(),
      }),
      signal: ctrl.signal,
    }).then(x => x.json()).finally(() => clearTimeout(timer));

    if (!r.success) throw new Error(r.error);

    results.innerHTML = `
      <div style="margin-top:12px;font-size:13px">
        <div style="font-weight:600;margin-bottom:8px;color:var(--success)">
          ✓ ${r.flows.length} flow${r.flows.length !== 1 ? 's' : ''} created and saved
        </div>
        ${r.flows.map(({ page, flow }) => `
          <div style="display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid var(--border)">
            <span style="color:var(--success)">✓</span>
            <div>
              <span style="font-weight:500">${escHtml(flow.name)}</span>
              <span style="color:var(--text-muted);font-size:11px;margin-left:6px">← ${escHtml(page)}</span>
              <span style="color:var(--text-dim);font-size:11px;margin-left:4px">${(flow.steps||[]).length} steps</span>
            </div>
          </div>`).join('')}
        ${r.errors?.length ? `<div style="margin-top:6px;color:var(--warn);font-size:11px">⚠ ${r.errors.length} page(s) failed</div>` : ''}
      </div>`;

    loadFlows();
    toast(`✓ ${r.flows.length} flow${r.flows.length !== 1 ? 's' : ''} saved to App Flow Map`, 'success');
    btn.textContent = '✓ Done';
  } catch (e) {
    const is429 = e.message && (e.message.includes('rate limit') || e.message.includes('429'));
    if (is429) {
      results.innerHTML = `<div style="margin-top:10px;padding:12px;border:1px solid var(--warn);border-radius:8px;background:var(--bg-card)">
        <div style="font-size:12px;color:var(--warn);margin-bottom:8px;font-weight:600">⚠ Figma token rate-limited</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">Generate a new token at <a href="https://www.figma.com/developers/api#access-tokens" target="_blank" style="color:var(--accent)">figma.com/developers</a> and paste below:</div>
        <div style="display:flex;gap:8px">
          <input id="pullFigmaNewToken2" type="password" class="form-control" placeholder="figd_…" style="flex:1;font-size:13px" />
          <button onclick="_pullFigmaRetryWithToken2()" class="btn btn-sm btn-primary" style="white-space:nowrap">🔄 Retry</button>
        </div>
      </div>`;
    } else {
      results.innerHTML = `<div style="margin-top:10px;color:var(--danger);font-size:13px">❌ ${escHtml(e.message)}</div>`;
    }
    toast(e.message, 'error');
    btn.disabled = false; btn.textContent = '📥 Pull Selected';
  } finally {
    progress.style.display = 'none';
    document.getElementById('pullFigmaBackBtn').disabled = false;
  }
}

// Retry pull selected with a new token (Step 2)
async function _pullFigmaRetryWithToken2() {
  const newToken = document.getElementById('pullFigmaNewToken2')?.value?.trim();
  if (!newToken) { toast('Paste your new Figma token', 'warn'); return; }
  const settField = document.getElementById('settFigmaToken');
  if (settField) settField.value = newToken;
  State.settings.figmaToken = newToken;
  localStorage.setItem('qahub_settings', JSON.stringify(State.settings));
  toast('Token updated — retrying…', 'info');
  _pullFigmaPullSelected();
}

// ── Figma / AI flow generation ────────────────────────────────────────────────
function openFigmaFlowModal() {
  document.getElementById('figmaFlowUrl').value  = '';
  document.getElementById('figmaFlowDesc').value = '';
  document.getElementById('figmaFlowModal').style.display = 'flex';
}
function closeFigmaFlowModal() { document.getElementById('figmaFlowModal').style.display = 'none'; }

async function generateFlowFromFigma() {
  const figmaUrl = document.getElementById('figmaFlowUrl').value.trim();
  const desc     = document.getElementById('figmaFlowDesc').value.trim();
  if (!figmaUrl && !desc) { toast('Provide a Figma URL or description', 'warn'); return; }

  const btn = document.getElementById('figmaFlowGenBtn');
  btn.disabled = true; btn.textContent = '⏳ Generating…';

  try {
    const r = await apiFetch('/api/flows/from-figma', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, figmaUrl, description: desc, ...aiOpts() }),
    }).then(x => x.json());

    if (!r.success) throw new Error(r.error);
    const flow = r.flow;

    // Pre-fill the edit modal with the generated flow
    closeFigmaFlowModal();
    document.getElementById('flowEditTitle').textContent = '✨ Review Generated Flow';
    document.getElementById('flowEditId').value = '';
    document.getElementById('flowEditName').value   = flow.name || '';
    document.getElementById('flowEditModule').value = flow.module || '';
    document.getElementById('flowEditDesc').value   = flow.description || '';
    _flowEditStepCount = 0;
    document.getElementById('flowStepsList').innerHTML = '';
    (flow.steps || []).forEach(s => addFlowStep(s));
    document.getElementById('flowEditModal').style.display = 'flex';
    toast('Flow generated — review and save', 'success');
  } catch(e) {
    toast('Generation failed: ' + e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '✨ Generate Flow';
  }
}

// ── Confluence Integration ────────────────────────────────────────────────────

// Step 1: Fetch a Confluence page and display content as requirements
async function fetchConfluencePage() {
  const url = document.getElementById('confluencePageUrl').value.trim();
  if (!url) { toast('Paste a Confluence page URL', 'warn'); return; }

  const btn    = document.getElementById('confluenceFetchBtn');
  const status = document.getElementById('confluenceFetchStatus');
  const contentDiv = document.getElementById('confluenceContent');

  btn.disabled = true; btn.textContent = '⏳ Fetching…';
  status.style.display = ''; status.textContent = '⏳ Fetching page from Confluence…';
  contentDiv.style.display = 'none';

  try {
    const r = await apiFetch('/api/confluence/fetch-page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confluenceUrl: url,
        jiraEmail: getSetting('jiraEmail'),
        jiraToken: getSetting('jiraToken'),
      }),
    }).then(x => x.json());

    if (!r.success) throw new Error(r.error);

    document.getElementById('confluencePageTitle').textContent = `📄 ${r.page.title}`;
    document.getElementById('confluenceText').value = r.page.content;
    contentDiv.style.display = '';
    status.style.display = 'none';
    toast(`✓ Fetched: ${r.page.title}`, 'success');

    // Store for use by parseInputsAndGenerateScenarios
    window._confluenceContent = r.page.content;
    window._confluenceTitle   = r.page.title;
  } catch (e) {
    status.style.display = '';
    status.innerHTML = `<span style="color:var(--danger)">❌ ${escHtml(e.message)}</span>`;
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '📥 Fetch';
  }
}

function clearConfluenceContent() {
  document.getElementById('confluenceContent').style.display = 'none';
  document.getElementById('confluenceText').value = '';
  document.getElementById('confluencePageTitle').textContent = '';
  window._confluenceContent = null;
  window._confluenceTitle = null;
}

// Reference Library: Import a Confluence FRD page as functional requirements
async function importConfluenceAsKnowledge() {
  const url = document.getElementById('rlConfluenceUrl').value.trim();
  if (!url) { toast('Paste a Confluence page URL', 'warn'); return; }

  const statusEl = document.getElementById('rlConfluenceStatus');
  statusEl.style.display = '';
  statusEl.innerHTML = '<span style="color:var(--text-muted)">⏳ Importing FRD page…</span>';

  try {
    const r = await apiFetch('/api/confluence/import-as-knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confluenceUrl: url,
        clientId: CLIENT_ID,
        jiraEmail: getSetting('jiraEmail'),
        jiraToken: getSetting('jiraToken'),
        kind: 'requirement',
      }),
    }).then(x => x.json());

    if (!r.success) throw new Error(r.error);

    statusEl.innerHTML = `<span style="color:var(--success)">✓ Imported FRD: "${escHtml(r.title)}" (${Math.round(r.contentLength/1024)}KB) — AI will use this for scenario & TC generation</span>`;
    document.getElementById('rlConfluenceUrl').value = '';
    toast(`✓ FRD "${r.title}" imported to Reference Library`, 'success');

    // Refresh knowledge list
    if (typeof loadKnowledgeEntries === 'function') loadKnowledgeEntries();
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--danger)">❌ ${escHtml(e.message)}</span>`;
    toast(e.message, 'error');
  }
}

// ── App Map (Figma / Crawl) ───────────────────────────────────────────────────

async function uploadFigmaExport() {
  const input = document.getElementById('figmaFileInput');
  if (!input.files?.length) { toast('Select Figma screen images or JSON first', 'warn'); return; }

  const formData = new FormData();
  formData.append('clientId', CLIENT_ID);
  for (const file of input.files) {
    formData.append('files', file);
  }
  // Pass AI provider settings for image analysis
  const ai = aiOpts();
  Object.entries(ai).forEach(([k, v]) => { if (v) formData.append(k, v); });

  const statusEl = document.getElementById('appMapStatus');
  statusEl.textContent = '⏳ Analyzing images with AI…';

  try {
    const res = await fetch('/api/app-map/figma-upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    statusEl.textContent = `✓ ${data.totalPages} screen(s) → flow created`;
    toast(`Figma import: ${data.totalPages} steps generated from screenshots`, 'success');
    input.value = '';
    loadFlows();  // Refresh flows panel
  } catch (e) {
    statusEl.textContent = '';
    toast(`Figma import failed: ${e.message}`, 'error');
  }
}

async function loadAppMap() {
  try {
    const res = await apiFetch(`/api/app-map/${CLIENT_ID}`).then(r => r.json());
    if (!res.success || !res.appMap) {
      document.getElementById('appMapResults').style.display = 'none';
      document.getElementById('appMapStatus').textContent = '';
      return;
    }
    renderAppMap(res.appMap);
  } catch {}
}

function renderAppMap(appMap) {
  const container = document.getElementById('appMapResults');
  const title     = document.getElementById('appMapTitle');
  const summary   = document.getElementById('appMapSummary');
  const pagesList = document.getElementById('appMapPages');
  const statusEl  = document.getElementById('appMapStatus');

  container.style.display = 'block';
  title.textContent = `📐 ${appMap.totalPages} screens`;
  statusEl.textContent = `✓ ${appMap.totalPages} screens loaded`;

  // Summary
  const s = appMap.summary || {};
  const typesStr = Object.entries(s.pageTypes || {}).map(([t, c]) => `${t}(${c})`).join(', ');
  summary.textContent = `Types: ${typesStr} | Forms: ${s.totalForms || 0} | Buttons: ${s.totalButtons || 0} | Inputs: ${s.totalInputs || 0}`;

  // Pages list
  pagesList.innerHTML = (appMap.pages || []).map(p => {
    if (p.error) return `<div style="color:#e57373">✗ ${p.url}: ${p.error}</div>`;
    const formInfo = (p.forms || []).map(f => {
      const fields = f.fields?.map(fi => fi.label || fi.name || fi.type).join(', ') || '';
      return `<span style="color:#6fd6c9">⬡ Form: ${fields}</span>`;
    }).join(' ');
    const btnInfo = (p.buttons || []).slice(0, 5).map(b => `"${b.text}"`).join(', ');
    return `<div style="padding:4px 0;border-bottom:1px solid var(--border)">
      <span style="font-weight:600">[${(p.type || 'page').toUpperCase()}]</span>
      <span>${p.title || p.url}</span>
      ${formInfo ? `<div style="margin-left:16px;font-size:11px">${formInfo}</div>` : ''}
      ${btnInfo ? `<div style="margin-left:16px;font-size:11px;color:#f4c869">Buttons: ${btnInfo}</div>` : ''}
    </div>`;
  }).join('');

  // Store in State for TC generation
  State.appMap = appMap;
}

async function clearAppMap() {
  try {
    await apiFetch(`/api/app-map/${CLIENT_ID}`, { method: 'DELETE' });
  } catch {}
  document.getElementById('appMapResults').style.display = 'none';
  document.getElementById('appMapStatus').textContent = '';
  State.appMap = null;
  toast('App map cleared', 'success');
}

// ── Codebase Integration (GitLab) ─────────────────────────────────────────────

async function fetchCodebaseContext() {
  const moduleName = document.getElementById('codebaseModule').value.trim();
  const repoInput  = document.getElementById('codebaseRepoUrl').value.trim();
  const branch     = document.getElementById('codebaseBranch').value.trim() || 'main';

  if (!moduleName && !repoInput) { toast('Enter a repo URL and module/path', 'warn'); return; }

  // Extract project ID from GitLab URL or use directly
  let projectId = getSetting('glProjectId');
  let gitlabUrl = getSetting('glUrl');
  if (repoInput) {
    // Handle: https://gitlab.com/org/group/project or just a numeric ID
    if (/^\d+$/.test(repoInput)) {
      projectId = repoInput;
    } else {
      const urlMatch = repoInput.match(/^(https?:\/\/[^/]+)\/(.+?)(?:\.git)?$/);
      if (urlMatch) {
        gitlabUrl = urlMatch[1];
        // GitLab API accepts URL-encoded path as project ID
        projectId = encodeURIComponent(urlMatch[2]);
      }
    }
  }

  if (!projectId) { toast('Enter a GitLab repo URL or set Project ID in Settings → GitLab', 'warn'); return; }

  const btn      = document.getElementById('codebaseFetchBtn');
  const status   = document.getElementById('codebaseFetchStatus');
  const results  = document.getElementById('codebaseResults');

  btn.disabled = true; btn.textContent = '⏳ Searching…';
  status.style.display = ''; status.innerHTML = '⏳ Searching repo for relevant source code…';
  results.style.display = 'none';

  try {
    const r = await apiFetch('/api/codebase/context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        module: moduleName,
        keywords: moduleName ? moduleName.split(/[\s,\/]+/).filter(Boolean) : [],
        gitlabUrl,
        gitlabToken: getSetting('glToken'),
        projectId,
        ref: branch,
        maxFiles: 15,
      }),
    }).then(x => x.json());

    if (!r.success) throw new Error(r.error);

    if (!r.filesFetched) {
      status.innerHTML = `<span style="color:var(--warn)">⚠ No source files found for "${escHtml(moduleName)}". Try a different keyword.</span>`;
      return;
    }

    // Show results
    document.getElementById('codebaseResultTitle').textContent = `📂 ${r.filesFetched} file${r.filesFetched !== 1 ? 's' : ''} found for "${moduleName}"`;
    document.getElementById('codebaseFileList').innerHTML = r.files.map(f => `
      <div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--border)">
        <span style="color:var(--accent);font-size:11px">📄</span>
        <span style="font-size:12px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(f.path)}</span>
        <span style="color:var(--text-dim);font-size:10px">${f.truncated ? '(truncated)' : Math.round(f.size/1024)+'KB'}</span>
      </div>`).join('');
    document.getElementById('codebaseContext').value = r.context;
    results.style.display = '';
    status.style.display = 'none';

    // Store for use during generation
    window._codebaseContext = r.context;
    window._codebaseModule  = moduleName;
    window._codebaseFiles   = r.files;

    toast(`✓ ${r.filesFetched} source files loaded as context`, 'success');
  } catch (e) {
    status.style.display = '';
    status.innerHTML = `<span style="color:var(--danger)">❌ ${escHtml(e.message)}</span>`;
    toast(e.message, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '🔍 Fetch Code';
  }
}

function clearCodebaseContext() {
  document.getElementById('codebaseResults').style.display = 'none';
  document.getElementById('codebaseContext').value = '';
  document.getElementById('codebaseFileList').innerHTML = '';
  document.getElementById('codebaseResultTitle').textContent = '';
  window._codebaseContext = null;
  window._codebaseModule = null;
  window._codebaseFiles = null;
}

function renderKnowledgeSources(stats) {
  const el = document.getElementById('rlSrcContent');
  if (!el) return;
  const fromChat     = _rlAllEntries.filter(e => e.source_item_type === 'scenario' || e.source_item_type === 'test_case');
  const curatedNotes = _rlAllEntries.filter(e => !e.source_item_type);

  el.innerHTML = `
    <!-- Chat-derived rules -->
    <div class="rl-src tc" style="margin-bottom:10px">
      <div class="rl-si">📋</div>
      <div><div class="rl-st">Test Case &amp; Scenario Chats</div><div class="rl-sm">Rules distilled from AI chat corrections</div></div>
      <div class="rl-scount"><b>${fromChat.length}</b> units derived</div>
    </div>

    <!-- Requirements (coming soon) -->
    <div class="rl-src req" style="margin-bottom:16px">
      <div class="rl-si">📄</div>
      <div><div class="rl-st">Requirements / Jira</div><div class="rl-sm">Coming soon — ingest Jira stories as knowledge</div></div>
      <div class="rl-scount"><b>—</b> units derived</div>
    </div>

    <!-- Curated notes — editable -->
    <div class="cn-header">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:16px">✎</span>
        <div>
          <div class="rl-st">Curated Notes</div>
          <div class="rl-sm">Your tribal knowledge &amp; corrections — edited directly here</div>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" onclick="addCuratedNote()" style="flex-shrink:0">+ Add Note</button>
    </div>

    <div id="curatedNotesList" class="cn-list">
      ${curatedNotes.length
        ? curatedNotes.map(e => _curatedNoteCard(e)).join('')
        : '<div class="cn-empty">No curated notes yet. Click <strong>+ Add Note</strong> to add your first rule.</div>'
      }
    </div>`;
}

function _curatedNoteCard(e) {
  const mod = e.module ? `<span class="rl-chip mod" style="font-size:9.5px">${escHtml(e.module)}</span>` : `<span class="rl-chip glob" style="font-size:9.5px">GLOBAL</span>`;
  const isPending = e.status !== 'approved';
  return `<div class="cn-card" id="cn-card-${e.id}">
    <div class="cn-view" id="cn-view-${e.id}">
      <div class="cn-top">
        ${mod}
        ${isPending ? '<span class="rl-chip pend" style="font-size:9px">pending</span>' : ''}
        <span class="cn-weight" title="Weight">w${(e.weight||1).toFixed(1)}</span>
      </div>
      <div class="cn-text">${escHtml(e.guidance)}</div>
      <div class="cn-actions">
        <button class="cn-btn" onclick="startEditNote('${e.id}')">✏ Edit</button>
        ${isPending ? `<button class="cn-btn appr" onclick="approveKnowledge('${e.id}')">✓ Approve</button>` : ''}
        <button class="cn-btn del" onclick="deleteCuratedNote('${e.id}')">✕ Delete</button>
      </div>
    </div>
    <div class="cn-edit" id="cn-edit-${e.id}" style="display:none">
      <textarea class="form-control cn-textarea" id="cn-ta-${e.id}" rows="3">${escHtml(e.guidance)}</textarea>
      <input class="form-control" id="cn-mod-${e.id}" placeholder="Module (leave blank for global)" value="${escHtml(e.module || '')}" style="margin-top:6px;font-size:12px" />
      <div class="cn-edit-actions">
        <button class="btn btn-primary btn-sm" onclick="saveCuratedNote('${e.id}')">💾 Save</button>
        <button class="btn btn-outline btn-sm" onclick="cancelEditNote('${e.id}')">Cancel</button>
      </div>
    </div>
  </div>`;
}

function startEditNote(id) {
  document.getElementById(`cn-view-${id}`).style.display = 'none';
  document.getElementById(`cn-edit-${id}`).style.display = '';
  document.getElementById(`cn-ta-${id}`).focus();
}

function cancelEditNote(id) {
  document.getElementById(`cn-view-${id}`).style.display = '';
  document.getElementById(`cn-edit-${id}`).style.display = 'none';
}

async function saveCuratedNote(id) {
  const guidance = document.getElementById(`cn-ta-${id}`)?.value.trim();
  const module   = document.getElementById(`cn-mod-${id}`)?.value.trim() || null;
  if (!guidance) { toast('Note text cannot be empty', 'warn'); return; }
  try {
    await apiFetch(`/api/knowledge/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, guidance, module }),
    });
    // Update local cache and re-render
    const entry = _rlAllEntries.find(e => e.id === id);
    if (entry) { entry.guidance = guidance; entry.module = module; }
    renderKnowledgeSources();
    renderKnowledgeRules();
    toast('Note saved', 'success');
  } catch(err) { toast('Save failed: ' + err.message, 'error'); }
}

async function deleteCuratedNote(id) {
  if (!confirm('Delete this curated note?')) return;
  await apiFetch(`/api/knowledge/${id}?clientId=${CLIENT_ID}`, { method: 'DELETE' });
  _rlAllEntries = _rlAllEntries.filter(e => e.id !== id);
  renderKnowledgeSources();
  renderKnowledgeRules();
  toast('Note deleted', 'success');
}

function addCuratedNote() {
  // Insert a blank draft card at the top of the list
  const list = document.getElementById('curatedNotesList');
  if (!list) return;
  // Remove existing draft if any
  document.getElementById('cn-new-draft')?.remove();
  const draft = document.createElement('div');
  draft.id = 'cn-new-draft';
  draft.className = 'cn-card cn-card-new';
  draft.innerHTML = `
    <div class="cn-edit" style="display:block">
      <textarea class="form-control cn-textarea" id="cn-ta-new" rows="3" placeholder="Enter rule in imperative form e.g. 'For the checkout flow, always include a negative scenario for an expired payment method'"></textarea>
      <input class="form-control" id="cn-mod-new" placeholder="Module (leave blank for global rule)" style="margin-top:6px;font-size:12px" />
      <div class="cn-edit-actions">
        <button class="btn btn-primary btn-sm" onclick="saveNewNote()">💾 Save Note</button>
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('cn-new-draft').remove()">Cancel</button>
      </div>
    </div>`;
  list.prepend(draft);
  document.getElementById('cn-ta-new').focus();
}

async function saveNewNote() {
  const guidance = document.getElementById('cn-ta-new')?.value.trim();
  const module   = document.getElementById('cn-mod-new')?.value.trim() || null;
  if (!guidance) { toast('Note text cannot be empty', 'warn'); return; }
  try {
    await apiFetch('/api/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: CLIENT_ID, guidance, module, kind: 'rule', status: 'approved' }),
    });
    document.getElementById('cn-new-draft')?.remove();
    await loadKnowledge();
    setKnowledgeMode('sources', document.getElementById('rlModeSrc'));
    toast('Note added', 'success');
  } catch(err) { toast('Add failed: ' + err.message, 'error'); }
}

function setKnowledgeMode(mode, btn) {
  document.querySelectorAll('.rl-mode').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  document.getElementById('rlRulesPane').style.display = mode === 'rules'   ? '' : 'none';
  document.getElementById('rlFlowPane').style.display  = mode === 'flow'    ? '' : 'none';
  document.getElementById('rlSrcPane').style.display   = mode === 'sources' ? '' : 'none';
  const twinPane = document.getElementById('rlTwinPane');
  if (twinPane) twinPane.style.display = mode === 'twin' ? '' : 'none';
  if (mode === 'flow') loadFlows();
  if (mode === 'twin') { loadTwinConfig(); loadTwinStatus(); loadTwinExplorer(); }
}

function setKnowledgeScope(scope, el) {
  _rlScope = scope;
  _rlModuleFilter = '';
  document.querySelectorAll('[id^="rlScope"]').forEach(e => e.classList.remove('on'));
  el.classList.add('on');
  renderKnowledgeRules();
}

function setKnowledgeStatus(status, el) {
  _rlStatusFilter = _rlStatusFilter === status ? '' : status;
  document.querySelectorAll('[id^="rlFilt"]').forEach(e => e.classList.remove('on'));
  if (_rlStatusFilter) el.classList.add('on');
  renderKnowledgeRules();
}

function setKnowledgeModule(mod, el) {
  _rlModuleFilter = _rlModuleFilter === mod ? '' : mod;
  renderKnowledgeRules();
}

function filterKnowledgeList() { renderKnowledgeRules(); }

// Format plain text FRD content into structured HTML
function formatFrdContent(text) {
  if (!text) return '';
  const lines = text.split('\n');
  let html = '';
  let inTable = false;
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line — close open blocks
    if (!trimmed) {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
      if (inList)  { html += '</ul>'; inList = false; }
      continue;
    }

    // Heading: ## Section Title
    if (trimmed.startsWith('## ')) {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
      if (inList)  { html += '</ul>'; inList = false; }
      html += `<h4 class="frd-heading">${escHtml(trimmed.slice(3))}</h4>`;
      continue;
    }

    // Table row: | cell | cell | cell |
    if (trimmed.includes(' | ') && (trimmed.startsWith('|') || trimmed.endsWith('|'))) {
      const cells = trimmed.split('|').map(c => c.trim()).filter(Boolean);
      if (!inTable) {
        html += '<table class="frd-table"><tbody>';
        inTable = true;
        // First row as header
        html += '<tr class="frd-table-head">' + cells.map(c => `<th>${escHtml(c)}</th>`).join('') + '</tr>';
      } else {
        html += '<tr>' + cells.map(c => `<td>${escHtml(c)}</td>`).join('') + '</tr>';
      }
      continue;
    }

    // Bullet: • item or - item
    if (trimmed.startsWith('•') || trimmed.match(/^[-–]\s/)) {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
      if (!inList) { html += '<ul class="frd-list">'; inList = true; }
      const content = trimmed.replace(/^[•\-–]\s*/, '');
      html += `<li>${escHtml(content)}</li>`;
      continue;
    }

    // Numbered item: 1. text or 1) text
    if (trimmed.match(/^\d+[\.\)]\s/)) {
      if (inTable) { html += '</tbody></table>'; inTable = false; }
      if (!inList) { html += '<ul class="frd-list numbered">'; inList = true; }
      const content = trimmed.replace(/^\d+[\.\)]\s*/, '');
      const num = trimmed.match(/^(\d+)/)[1];
      html += `<li><span class="frd-num">${num}.</span> ${escHtml(content)}</li>`;
      continue;
    }

    // Regular paragraph
    if (inTable) { html += '</tbody></table>'; inTable = false; }
    if (inList)  { html += '</ul>'; inList = false; }
    html += `<p class="frd-para">${escHtml(trimmed)}</p>`;
  }

  if (inTable) html += '</tbody></table>';
  if (inList)  html += '</ul>';
  return html;
}

// Open full-view modal for FRD entry
function openFrdFullView(id) {
  const entry = _rlAllEntries.find(e => e.id === id);
  if (!entry) return;

  // Remove existing modal if any
  let modal = document.getElementById('frdFullViewModal');
  if (modal) modal.remove();

  // Use stored HTML if available, otherwise format from plain text
  let bodyContent;
  if (entry.html_content) {
    // Render the Confluence HTML with proper styling (sanitize dangerous tags)
    bodyContent = sanitizeFrdHtml(entry.html_content);
  } else {
    bodyContent = formatFrdContent(entry.guidance || '');
  }

  modal = document.createElement('div');
  modal.id = 'frdFullViewModal';
  modal.className = 'frd-modal-overlay';
  modal.innerHTML = `
    <div class="frd-modal">
      <div class="frd-modal-header">
        <h3>${escHtml(entry.trigger_text || 'Functional Requirements Document')}</h3>
        <div class="frd-modal-meta">
          <span class="rl-chip frd">📄 FRD</span>
          <span class="rl-chip frd-size">${Math.round((entry.guidance||'').length/1024)}KB</span>
          ${entry.source_item_type ? `<span class="rl-chip type">↩ ${escHtml(entry.source_item_type)}</span>` : ''}
        </div>
        <span class="frd-modal-close" onclick="closeFrdFullView()">✕</span>
      </div>
      <div class="frd-modal-body frd-html-content">${bodyContent}</div>
    </div>
  `;
  modal.addEventListener('click', (ev) => { if (ev.target === modal) closeFrdFullView(); });
  document.body.appendChild(modal);
}

// Sanitize Confluence HTML — keep structure, remove scripts/styles/dangerous attributes
function sanitizeFrdHtml(html) {
  // Remove script/style/iframe tags and their content
  let safe = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/<link[^>]*>/gi, '')
    .replace(/<object[\s\S]*?<\/object>/gi, '')
    .replace(/<embed[^>]*>/gi, '');

  // Remove event handlers (on*)
  safe = safe.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  safe = safe.replace(/\s+on\w+\s*=\s*[^\s>]*/gi, '');

  // Remove javascript: URLs
  safe = safe.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');

  // Remove Confluence macros/noise
  safe = safe.replace(/<ac:[^>]*\/>/gi, '');
  safe = safe.replace(/<ac:[^>]*>[\s\S]*?<\/ac:[^>]*>/gi, '');
  safe = safe.replace(/<ri:[^>]*\/>/gi, '');
  safe = safe.replace(/<ri:[^>]*>[\s\S]*?<\/ri:[^>]*>/gi, '');

  return safe;
}

function closeFrdFullView() {
  const modal = document.getElementById('frdFullViewModal');
  if (modal) modal.remove();
}

async function approveKnowledge(id) {
  await apiFetch(`/api/knowledge/${id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });
  const e = _rlAllEntries.find(x => x.id === id);
  if (e) e.status = 'approved';
  renderKnowledgeRules();
  toast('Rule approved', 'success');
}

async function bumpKnowledge(id) {
  await apiFetch(`/api/knowledge/${id}/bump`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID }),
  });
  const e = _rlAllEntries.find(x => x.id === id);
  if (e) e.weight = Math.min(10, (e.weight || 1) + 0.5);
  renderKnowledgeRules();
  toast('Rule weight boosted', 'success');
}

async function deleteKnowledge(id) {
  const entry = _rlAllEntries.find(x => x.id === id);
  const label = entry?.status !== 'approved' ? 'Reject' : 'Delete';
  if (!confirm(`${label} this rule?`)) return;
  await apiFetch(`/api/knowledge/${id}?clientId=${CLIENT_ID}`, { method: 'DELETE' });
  _rlAllEntries = _rlAllEntries.filter(x => x.id !== id);
  renderKnowledgeRules();
  toast('Rule deleted', 'success');
}

let _ruleEditId = null; // null = Add mode, string = Edit mode

function openAddKnowledge() {
  _ruleEditId = null;
  document.getElementById('ruleModalTitle').textContent = '📐 Add Rule';
  document.getElementById('ruleModalSaveBtn').textContent = 'Add Rule';
  document.getElementById('ruleGuidance').value = '';
  document.getElementById('ruleModule').value = '';
  document.getElementById('ruleKind').value = 'rule';
  document.getElementById('ruleWeight').value = '1';
  document.getElementById('ruleStatus').value = 'approved';
  document.getElementById('ruleModal').style.display = 'flex';
  document.getElementById('ruleGuidance').focus();
}

function openEditKnowledge(id) {
  const entry = _rlAllEntries.find(e => e.id === id);
  if (!entry) return;
  _ruleEditId = id;
  document.getElementById('ruleModalTitle').textContent = '✏️ Edit Rule';
  document.getElementById('ruleModalSaveBtn').textContent = 'Save Changes';
  document.getElementById('ruleGuidance').value = entry.guidance || '';
  document.getElementById('ruleModule').value = entry.module || '';
  document.getElementById('ruleKind').value = entry.kind || 'rule';
  document.getElementById('ruleWeight').value = entry.weight || 1;
  document.getElementById('ruleStatus').value = entry.status || 'approved';
  document.getElementById('ruleModal').style.display = 'flex';
  document.getElementById('ruleGuidance').focus();
}

function closeRuleModal() {
  document.getElementById('ruleModal').style.display = 'none';
  _ruleEditId = null;
}

async function saveRule() {
  const guidance = document.getElementById('ruleGuidance').value.trim();
  if (!guidance) { toast('Rule text is required', 'warn'); return; }
  const module = document.getElementById('ruleModule').value.trim() || null;
  const kind   = document.getElementById('ruleKind').value;
  const weight = parseFloat(document.getElementById('ruleWeight').value) || 1;
  const status = document.getElementById('ruleStatus').value;

  try {
    if (_ruleEditId) {
      // Edit existing rule
      await apiFetch(`/api/knowledge/${_ruleEditId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, guidance, module, kind, weight, status }),
      });
      // Update local cache
      const entry = _rlAllEntries.find(e => e.id === _ruleEditId);
      if (entry) { entry.guidance = guidance; entry.module = module; entry.kind = kind; entry.weight = weight; entry.status = status; }
      toast('Rule updated', 'success');
    } else {
      // Add new rule
      await apiFetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, guidance, module, kind, status }),
      });
      toast('Rule added', 'success');
      await loadKnowledge();
    }
    closeRuleModal();
    renderKnowledgeRules();
  } catch (e) {
    toast('Save failed: ' + e.message, 'error');
  }
}

// ── Utility ─────────────────────────────────────────────────────────────────────
function _relTime(iso) {
  if (!iso) return '';
  const d   = new Date(iso);
  const now = Date.now();
  const ms  = now - d.getTime();
  const m   = Math.floor(ms / 60000);
  if (m < 1)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

function _prioClass(p) {
  const lp = (p || '').toLowerCase();
  if (lp === 'critical') return 'crit';
  if (lp === 'high')     return 'high';
  return 'medium';
}
