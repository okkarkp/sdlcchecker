/* PerfForge frontend — lives inside the Test Alchemist SPA as the ⚡ PerfForge tab.
 * Self-contained: own WebSocket, own canvas chart, listens only for pf_* events. */
(function () {
  const $ = (id) => document.getElementById(id);
  let pfMode = 'explore';      // explore | load
  let inited = false;
  const series = { rps: [], lat: [] };

  // ── View switch (mirrors goToStep's show/hide without modifying it) ──
  window.pfOpen = function () {
    document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.step-item').forEach(s => s.classList.remove('active'));
    $('stepPerf').classList.add('active');
    $('navPerf').classList.add('active');
    document.querySelector('.main')?.scrollTo({ top: 0, behavior: 'smooth' });
    if (!inited) { inited = true; pfInit(); }
  };

  window.pfTab = function (mode, el) {
    pfMode = mode;
    document.querySelectorAll('#stepPerf .tabs .tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    $('pfExploreFields').classList.toggle('pf-hidden', mode !== 'explore');
    $('pfLoadFields').classList.toggle('pf-hidden', mode !== 'load');
  };

  function currentProvider() {
    try { return (typeof aiOpts === 'function' ? aiOpts().provider : '') || 'copilot'; }
    catch { return 'copilot'; }
  }
  function pfInit() {
    fetch('/api/perfforge/info').then(r => r.json()).then(d => {
      const prov = currentProvider();
      $('pfEnginePill').innerHTML = `<span class="dot"></span>${d.playwright_available ? 'browser ✓' : 'browser ✗'} · AI: ${prov}`;
      $('pf_engineStatus').textContent = `— provider: ${prov} (set in ⚙ Settings)`;
    }).catch(() => {});
    sizeCanvas(); drawChart(); loadHistory(); connectWS();
  }

  // ── WebSocket ──
  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}`);
    ws.onmessage = (ev) => { let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (!d.type || !d.type.startsWith('pf_')) return;
      handle(d);
    };
    ws.onclose = () => setTimeout(connectWS, 2000);
  }

  function handle(d) {
    switch (d.type) {
      case 'pf_explore_started':
        running(true); $('pfLog').innerHTML = ''; $('pfFindings').classList.add('pf-hidden');
        $('pfLogPanel').classList.remove('pf-hidden');
        log(`▶ Exploring (${d.engine}) — ${d.goal || ''}`); status('AI Explorer running…'); break;
      case 'pf_explore_log': log(d.message); break;
      case 'pf_explore_step':
        log(`step ${d.step}: ${d.action} ${d.url || ''} ${d.load_ms != null ? '· load ' + d.load_ms + 'ms' : ''}`);
        status(`Exploring — step ${d.step}`); break;
      case 'pf_explore_done': renderFindings(d); running(false); status('Exploration complete — ' + d.summary); break;
      case 'pf_started':
        running(true); series.rps = []; series.lat = []; drawChart(); $('pfSlaBanner').classList.add('pf-hidden');
        status(`Running — ${d.name}`); break;
      case 'pf_error': running(false); status('Error: ' + d.message); break;
      case 'pf_snapshot':
        render(d); series.rps.push(d.rps || 0); series.lat.push(d.avg || 0);
        if (series.rps.length > 120) { series.rps.shift(); series.lat.shift(); }
        drawChart(); status(`Running — ${d.elapsed}s · ${d.active_workers} workers`); break;
      case 'pf_done':
        render(d); renderSla(d.sla); running(false);
        status(`Done — ${d.total} requests in ${d.elapsed}s`); loadHistory(); break;
    }
  }

  // ── render ──
  function render(d) {
    $('pfRps').innerHTML = (d.rps ?? d.throughput ?? 0) + '<span class="u"> req/s</span>';
    $('pfAvg').innerHTML = Math.round(d.avg) + '<span class="u"> ms</span>';
    $('pfP95').innerHTML = Math.round(d.p95) + '<span class="u"> ms</span>';
    const er = (d.error_rate ?? 0).toFixed(1);
    const em = $('pfErr'); em.innerHTML = er + '<span class="u"> %</span>'; em.className = 'v ' + (er > 1 ? 'bad' : 'good');
    $('pfMin').textContent = Math.round(d.min) + ' ms'; $('pfP50').textContent = Math.round(d.p50) + ' ms';
    $('pfP90').textContent = Math.round(d.p90) + ' ms'; $('pfP99').textContent = Math.round(d.p99) + ' ms';
    $('pfMax').textContent = Math.round(d.max) + ' ms'; $('pfTotal').textContent = (d.total ?? 0).toLocaleString();
    const codes = $('pfCodes'); codes.innerHTML = '';
    Object.entries(d.status_codes || {}).forEach(([c, n]) => {
      const e = document.createElement('span'); e.className = 'pf-code s' + String(c)[0];
      e.textContent = (c === '0' ? 'ERR' : c) + ' × ' + n; codes.appendChild(e);
    });
  }
  function renderSla(sla) {
    const b = $('pfSlaBanner'); if (!sla) { b.classList.add('pf-hidden'); return; }
    b.classList.remove('pf-hidden');
    const rows = sla.checks.map(c => `<tr><td>${c.name}</td><td>${c.actual}</td><td style="color:${c.passed ? 'var(--green)' : 'var(--danger)'}">${c.passed ? 'PASS' : 'FAIL'}</td></tr>`).join('');
    b.innerHTML = `<div class="card-title" style="font-size:13px">SLA verdict <span class="pf-badge ${sla.passed ? 'pass' : 'fail'}">${sla.passed ? 'PASS' : 'FAIL'}</span></div>
      <table class="pf-table" style="margin-top:8px"><thead><tr><th>Check</th><th>Actual</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
  }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function renderFindings(d) {
    $('pfFindings').classList.remove('pf-hidden');
    $('pfSummary').textContent = `${d.pages_visited} pages · ${d.requests_captured} requests · ${d.issues.length} issue(s) · ${d.elapsed}s`;
    $('pfIssues').innerHTML = d.issues.length
      ? d.issues.map(i => `<div class="pf-issue"><span class="pf-sev ${i.severity}">${i.severity}</span><b>${i.kind}</b> — ${esc(i.detail)}</div>`).join('')
      : '<div style="color:var(--text-muted)">No threshold-based issues detected. 🎉</div>';
    const diag = $('pfDiag');
    if (d.diagnosis) { diag.classList.remove('pf-hidden'); diag.textContent = d.diagnosis; } else diag.classList.add('pf-hidden');
    $('pfPages').innerHTML = (d.pages || []).map(p => `<tr><td title="${esc(p.url)}">${esc((p.title || p.url || '').slice(0, 38))}</td><td>${p.ttfb} ms</td><td>${p.fcp} ms</td><td>${p.lcp} ms</td><td>${p.load} ms</td></tr>`).join('');
    $('pfReqs').innerHTML = (d.slowest_requests || []).map(r => `<tr><td>${r.method}</td><td title="${esc(r.url)}">${esc(r.url.slice(0, 46))}</td><td>${r.type}</td><td>${r.duration_ms}</td><td>${r.size_kb}</td></tr>`).join('');
  }
  function log(m) { const el = $('pfLog'); const l = document.createElement('div'); l.textContent = m; el.appendChild(l); el.scrollTop = el.scrollHeight; }
  function status(t) { $('pfStatus').textContent = t; }
  function running(r) { $('pfStartBtn').disabled = r; $('pfStopBtn').classList.toggle('pf-hidden', !r); }

  // ── canvas chart ──
  function cv() { return $('pfChart'); }
  function sizeCanvas() { const c = cv(); if (!c) return; c.width = c.clientWidth * devicePixelRatio; c.height = 220 * devicePixelRatio; c.getContext('2d').scale(devicePixelRatio, devicePixelRatio); }
  function drawChart() {
    const c = cv(); if (!c) return; const ctx = c.getContext('2d');
    const w = c.clientWidth, h = 220, pad = 34;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--line-soft') || '#222';
    const gold = (css.getPropertyValue('--gold') || '#e2ad4c').trim();
    const merc = (css.getPropertyValue('--mercury') || '#6fd6c9').trim();
    const muted = (css.getPropertyValue('--text-muted') || '#888').trim();
    const n = series.rps.length;
    ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.font = '11px monospace'; ctx.fillStyle = muted;
    for (let i = 0; i <= 4; i++) { const y = pad + (h - 2 * pad) * i / 4; ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke(); }
    if (n < 2) { ctx.fillText('waiting for data…', w / 2 - 50, h / 2); return; }
    const plot = (data, color, max) => { ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
      data.forEach((v, i) => { const x = pad + (w - 2 * pad) * i / (n - 1); const y = h - pad - (h - 2 * pad) * Math.min(v / max, 1); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); ctx.stroke(); };
    const maxR = Math.max(...series.rps, 1), maxL = Math.max(...series.lat, 1);
    plot(series.rps, gold, maxR); plot(series.lat, merc, maxL);
    ctx.fillStyle = gold; ctx.fillText('● req/s (max ' + Math.round(maxR) + ')', pad, 14);
    ctx.fillStyle = merc; ctx.fillText('● avg ms (max ' + Math.round(maxL) + ')', pad + 150, 14);
  }
  window.addEventListener('resize', () => { if (inited) { sizeCanvas(); drawChart(); } });

  // ── helpers ──
  function parseHeaders(text) { const h = {}; (text || '').split('\n').forEach(line => { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }); return h; }

  window.pfStart = async function () {
    let url, body;
    if (pfMode === 'explore') {
      url = '/api/perfforge/explore';
      body = { goal: $('pf_goal').value, url: $('pf_url').value, username: $('pf_user').value,
        password: $('pf_pass').value, engine: $('pf_engine').value, max_steps: +$('pf_steps').value,
        headless: $('pf_headless').checked, load_test: $('pf_loadtest').checked,
        manual_login: $('pf_manual').checked,
        concurrency: +$('pf_ex_conc').value, duration: +$('pf_ex_dur').value };
      // AI provider/model/keys come from Test Alchemist's ⚙ Settings (default: Copilot)
      if (typeof aiOpts === 'function') Object.assign(body, aiOpts());
    } else {
      url = '/api/perfforge/run';
      const n = (id) => $(id).value === '' ? null : +$(id).value;
      const sla = { max_p95: n('pf_sla_p95'), max_error_rate: n('pf_sla_err') };
      body = { mode: 'native', name: $('pf_name').value, url: $('pf_lt_url').value, method: $('pf_method').value,
        headers: parseHeaders($('pf_headers').value), body: $('pf_body').value,
        concurrency: +$('pf_conc').value, duration: +$('pf_dur').value, ramp_up: +$('pf_ramp').value,
        timeout: +$('pf_timeout').value,
        sla: (sla.max_p95 != null || sla.max_error_rate != null) ? sla : null };
    }
    status('Starting…');
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!data.ok) status('Could not start: ' + data.error); else running(true);
    } catch (e) { status('Error: ' + e.message); }
  };
  window.pfStop = function () { fetch('/api/perfforge/stop', { method: 'POST' }); };

  function loadHistory() {
    fetch('/api/perfforge/history').then(r => r.json()).then(d => {
      const tb = $('pfHistory');
      if (!d.runs || !d.runs.length) { tb.innerHTML = '<tr><td colspan="7" style="color:var(--text-dim)">No runs yet.</td></tr>'; return; }
      tb.innerHTML = d.runs.map(r => {
        const sla = r.sla ? `<span class="pf-badge ${r.sla.passed ? 'pass' : 'fail'}">${r.sla.passed ? 'PASS' : 'FAIL'}</span>` : '—';
        return `<tr><td>${esc(r.name || '—')}</td><td>${r.mode}</td><td>${(r.total || 0).toLocaleString()}</td><td>${r.throughput || 0}</td><td>${Math.round(r.p95 || 0)} ms</td><td>${(r.error_rate || 0).toFixed(1)}%</td><td>${sla}</td></tr>`;
      }).join('');
    }).catch(() => {});
  }
})();
