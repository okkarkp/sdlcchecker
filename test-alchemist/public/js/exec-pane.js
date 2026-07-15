/* ═══════════════════════════════════════════════════════════════════════
   Execution Pane  ·  live pipeline progress + token-streaming feed
   Exposed as window.EP. Instantiated at the bottom of this file.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Agent definitions (Playwright & Pipeline are standalone — not shown here) ─
  const AGENTS = [
    { key: 'inputs',    name: 'Input Parser',  optional: false },
    { key: 'scenarios', name: 'Scenario Agent', optional: false },
    { key: 'testcases', name: 'TC Generator',   optional: false },
    { key: 'jira',      name: 'Jira Publisher', optional: true, optCheckbox: 'orchCreateJira' },
  ];

  const S = { QUEUED:'QUEUED', RUNNING:'RUNNING', DONE:'DONE', SKIPPED:'SKIPPED', ERROR:'ERROR', NOT_ENABLED:'NOT ENABLED' };

  const GLYPH = { start:'▶', think:'✶', action:'●', success:'✓', warn:'⚠', error:'✗' };

  // ────────────────────────────────────────────────────────────────────────
  class ExecPane {
    constructor () {
      this._open        = false;
      this._autoScroll  = true;
      this._activeLine  = null;   // DOM node of current streaming line
      this._tokenBuf    = '';     // accumulated token text
      this._caretTimer  = null;
      this._elapsedTimer= null;
      this._agentTimers = {};
      this._runStart    = null;
      this._doneCount   = 0;
      this._total       = 0;
      this._agents      = AGENTS.map((a, i) => ({
        ...a, idx: i, state: S.QUEUED, startAt: null, endAt: null, pct: 0,
      }));
      this._build();
    }

    // ── DOM construction ─────────────────────────────────────────────────
    _build () {
      const el = document.createElement('div');
      el.id        = 'execPane';
      el.className = 'ep-pane';
      el.innerHTML = `
        <div class="ep-header">
          <div class="ep-header-left">
            <span class="ep-dot"></span>
            <span class="ep-title">Execution</span>
            <span class="ep-counter">0 / 3 agents</span>
            <div class="ep-overall-bar"><div class="ep-overall-fill"></div></div>
            <span class="ep-elapsed"></span>
          </div>
          <div class="ep-header-right">
            <button class="ep-btn ep-ascroll-btn" title="Toggle auto-scroll">↓ Auto</button>
            <button class="ep-btn ep-copy-btn"    title="Copy feed">⎘ Copy</button>
            <button class="ep-btn ep-clear-btn"   title="Clear feed">✕ Clear</button>
            <button class="ep-btn ep-collapse-btn" title="Close">✕</button>
          </div>
        </div>
        <div class="ep-body">
          <div class="ep-agents"></div>
          <div class="ep-feed-wrap">
            <div class="ep-feed" aria-live="polite" aria-label="Execution log"></div>
          </div>
        </div>`;
      document.body.appendChild(el);

      this._pane      = el;
      this._dot       = el.querySelector('.ep-dot');
      this._counter   = el.querySelector('.ep-counter');
      this._overallFill = el.querySelector('.ep-overall-fill');
      this._elapsedEl = el.querySelector('.ep-elapsed');
      this._agentList = el.querySelector('.ep-agents');
      this._feedWrap  = el.querySelector('.ep-feed-wrap');
      this._feed      = el.querySelector('.ep-feed');

      this._renderRows();

      el.querySelector('.ep-collapse-btn').addEventListener('click', () => this.hide());
      el.querySelector('.ep-clear-btn')   .addEventListener('click', () => this.clearFeed());
      el.querySelector('.ep-copy-btn')    .addEventListener('click', () => this.copyFeed());
      el.querySelector('.ep-ascroll-btn') .addEventListener('click', () => this._toggleAutoScroll());

      // Wire header toggle button (added to index.html)
      const toggle = document.getElementById('execPaneToggle');
      if (toggle) toggle.addEventListener('click', () => this.toggle());
    }

    _renderRows () {
      this._agentList.innerHTML = this._agents.map(a => {
        // Jira (and any future optional agents) show NOT ENABLED if their toggle is off
        const isEnabled = !a.optCheckbox || !!document.getElementById(a.optCheckbox)?.checked;
        const initState = a.optional && !isEnabled ? S.NOT_ENABLED : S.QUEUED;
        return `
        <div class="ep-agent" id="ep-agent-${a.idx}" data-state="${initState}">
          <span class="ep-agent-state">${initState}</span>
          <span class="ep-agent-name">${a.name}${a.optional ? ' <em>opt</em>' : ''}</span>
          <div class="ep-agent-bar-wrap"><div class="ep-agent-bar-fill" style="width:0%"></div></div>
          <span class="ep-agent-time"></span>
        </div>`;
      }).join('');
    }

    // ── Visibility ───────────────────────────────────────────────────────
    toggle () { this._open ? this.hide() : this.show(); }

    show () {
      this._open = true;
      this._pane.classList.add('ep-visible');
      document.querySelector('.app')?.classList.add('ep-open');
      const btn = document.getElementById('execPaneToggle');
      if (btn) btn.classList.add('active');
    }

    hide () {
      this._open = false;
      this._pane.classList.remove('ep-visible');
      document.querySelector('.app')?.classList.remove('ep-open');
      const btn = document.getElementById('execPaneToggle');
      if (btn) btn.classList.remove('active');
    }

    // ── Pipeline lifecycle ───────────────────────────────────────────────
    start (skippedKeys = []) {
      this._agents.forEach(a => {
        if (skippedKeys.includes(a.key)) {
          // Optional agents that are toggled off → NOT ENABLED; non-optional skipped → SKIPPED
          a.state = a.optional ? S.NOT_ENABLED : S.SKIPPED;
        } else {
          a.state = S.QUEUED;
        }
        a.startAt = null;
        a.endAt   = null;
        a.pct     = 0;
      });
      this._doneCount = 0;
      // Only count agents that will actually run (not skipped/not enabled)
      this._total = this._agents.filter(a => a.state === S.QUEUED).length;
      this._runStart  = Date.now();
      this._renderRows();
      this._updateOverall();
      this._dot.classList.add('ep-dot-live');
      this.clearFeed();
      this._startElapsedTimer();
      this._startCaret();
      this.show();
    }

    end () {
      this._dot.classList.remove('ep-dot-live');
      this._commitToken();
      this._stopElapsedTimer();
      this._stopCaret();
      // Update any timers still running
      Object.keys(this._agentTimers).forEach(i => this._stopAgentTimer(+i));
    }

    // ── Agent state ──────────────────────────────────────────────────────
    agentStart (idx) {
      const a = this._agents[idx]; if (!a) return;
      a.state = S.RUNNING; a.startAt = Date.now(); a.pct = 0;
      this._updateRow(idx);
      this._logLine(idx, `${a.name} started`, 'start');
      this._startAgentTimer(idx);
    }

    agentProgress (idx, pct) {
      const a = this._agents[idx]; if (!a) return;
      a.pct = Math.min(1, pct);
      this._updateRow(idx);
    }

    agentDone (idx) {
      const a = this._agents[idx]; if (!a) return;
      if (a.state === S.DONE) return;
      a.state = S.DONE; a.endAt = Date.now(); a.pct = 1;
      this._stopAgentTimer(idx);
      this._doneCount++;
      this._commitToken();
      const dur = ((a.endAt - a.startAt) / 1000).toFixed(1);
      this._logLine(idx, `${a.name} complete · ${dur}s`, 'success');
      this._updateRow(idx);
      this._updateOverall();
    }

    agentError (idx, message) {
      const a = this._agents[idx]; if (!a) return;
      a.state = S.ERROR; a.endAt = Date.now();
      this._stopAgentTimer(idx);
      this._commitToken();
      this._logLine(idx, `${a.name} failed: ${message}`, 'error');
      this._updateRow(idx);
    }

    agentSkip (idx) {
      const a = this._agents[idx]; if (!a) return;
      a.state = S.SKIPPED;
      this._updateRow(idx);
    }

    // ── Feed ─────────────────────────────────────────────────────────────
    _logLine (idx, text, level = 'action') {
      this._commitToken();
      const glyph = GLYPH[level] || '●';
      const ts    = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const line  = document.createElement('div');
      line.className = `ep-line ep-lvl-${level}`;
      line.innerHTML =
        `<span class="ep-ts">${ts}</span>` +
        `<span class="ep-glyph">${glyph}</span>` +
        `<span class="ep-text">${this._esc(text)}</span>`;
      this._feed.appendChild(line);
      this._scroll();
    }

    // Called per streaming token chunk
    wsToken (chunk) {
      if (!this._activeLine) {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
        this._activeLine = document.createElement('div');
        this._activeLine.className = 'ep-line ep-lvl-think ep-live';
        this._activeLine.innerHTML =
          `<span class="ep-ts">${ts}</span>` +
          `<span class="ep-glyph">${GLYPH.think}</span>` +
          `<span class="ep-text">` +
          `<span class="ep-tokens"></span>` +
          `<span class="ep-caret">▌</span></span>`;
        this._feed.appendChild(this._activeLine);
      }
      this._tokenBuf += chunk;
      const tokEl = this._activeLine.querySelector('.ep-tokens');
      if (tokEl) tokEl.textContent = this._tokenBuf;
      this._scroll();
    }

    _commitToken () {
      if (!this._activeLine) return;
      this._activeLine.querySelector('.ep-caret')?.remove();
      this._activeLine.classList.remove('ep-live');
      this._activeLine = null;
      this._tokenBuf   = '';
    }

    // ── WS message bridge ─────────────────────────────────────────────────
    wsStep (msg) {
      // { type:'exec:step', event:'start'|'done'|'error', stepKey, error? }
      const idx = AGENTS.findIndex(a => a.key === msg.stepKey);
      if (idx < 0) return;
      if (msg.event === 'start') this.agentStart(idx);
      if (msg.event === 'done')  this.agentDone(idx);
      if (msg.event === 'error') this.agentError(idx, msg.error || 'Unknown error');
    }

    wsProgress (msg) {
      // { type:'exec:progress', stepKey, pct }
      const idx = AGENTS.findIndex(a => a.key === msg.stepKey);
      if (idx >= 0) this.agentProgress(idx, msg.pct);
    }

    wsLog (msg) {
      // { type:'exec:log', stepKey, text, level }
      const idx = AGENTS.findIndex(a => a.key === msg.stepKey);
      this._logLine(idx >= 0 ? idx : -1, msg.text, msg.level || 'action');
    }

    // ── Row rendering ──────────────────────────────────────────────────────
    _updateRow (idx) {
      const a   = this._agents[idx];
      const row = document.getElementById(`ep-agent-${idx}`);
      if (!row) return;
      row.dataset.state = a.state;
      row.querySelector('.ep-agent-state').textContent = a.state;
      row.querySelector('.ep-agent-bar-fill').style.width = (a.pct * 100) + '%';
      if ((a.state === S.DONE || a.state === S.ERROR) && a.startAt && a.endAt)
        row.querySelector('.ep-agent-time').textContent =
          ((a.endAt - a.startAt) / 1000).toFixed(1) + 's';
    }

    _updateOverall () {
      const pct = this._total > 0 ? this._doneCount / this._total : 0;
      if (this._overallFill) this._overallFill.style.width = (pct * 100) + '%';
      if (this._counter)     this._counter.textContent = `${this._doneCount} / ${this._total} agents`;
    }

    // ── Timers ─────────────────────────────────────────────────────────────
    _startElapsedTimer () {
      this._stopElapsedTimer();
      this._elapsedTimer = setInterval(() => {
        if (this._elapsedEl && this._runStart)
          this._elapsedEl.textContent = ((Date.now() - this._runStart) / 1000).toFixed(0) + 's';
      }, 1000);
    }
    _stopElapsedTimer () { clearInterval(this._elapsedTimer); this._elapsedTimer = null; }

    _startAgentTimer (idx) {
      const row = document.getElementById(`ep-agent-${idx}`); if (!row) return;
      const t0  = this._agents[idx].startAt;
      this._agentTimers[idx] = setInterval(() => {
        const el = row.querySelector('.ep-agent-time');
        if (el) el.textContent = ((Date.now() - t0) / 1000).toFixed(1) + 's';
      }, 500);
    }
    _stopAgentTimer (idx) {
      clearInterval(this._agentTimers[idx]);
      delete this._agentTimers[idx];
    }

    _startCaret () {
      this._stopCaret();
      let v = true;
      this._caretTimer = setInterval(() => {
        v = !v;
        this._feed.querySelectorAll('.ep-caret').forEach(c => c.style.opacity = v ? '1' : '0');
      }, 530);
    }
    _stopCaret () { clearInterval(this._caretTimer); this._caretTimer = null; }

    // ── Controls ───────────────────────────────────────────────────────────
    clearFeed () {
      this._commitToken();
      this._feed.innerHTML = '';
    }

    copyFeed () {
      const text = [...this._feed.querySelectorAll('.ep-line')]
        .map(l => {
          const ts = l.querySelector('.ep-ts')?.textContent || '';
          const g  = l.querySelector('.ep-glyph')?.textContent || '';
          const t  = l.querySelector('.ep-tokens')?.textContent
                  || l.querySelector('.ep-text')?.textContent || '';
          return `${ts} ${g} ${t}`.trim();
        }).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        const btn = this._pane.querySelector('.ep-copy-btn');
        if (!btn) return;
        const orig = btn.textContent;
        btn.textContent = '✓ Copied';
        setTimeout(() => (btn.textContent = orig), 1500);
      });
    }

    _toggleAutoScroll () {
      this._autoScroll = !this._autoScroll;
      this._pane.querySelector('.ep-ascroll-btn')
        ?.classList.toggle('ep-scroll-off', !this._autoScroll);
    }

    _scroll () {
      if (this._autoScroll) this._feedWrap.scrollTop = this._feedWrap.scrollHeight;
    }

    _esc (s) {
      return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // ── simulate() — dev helper ────────────────────────────────────────────
    simulate () {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const self  = this;
      (async () => {
        self.start(['jira', 'playwright', 'pipeline']);   // optional = skipped

        // Input Parser
        await sleep(300);
        self.agentStart(0);
        await sleep(100); self._logLine(0, '● Reading uploaded file: requirements_v3.docx', 'action');
        await sleep(400); self._logLine(0, '● Extracted 14 user stories, 6 acceptance criteria', 'action');
        await sleep(500); self.agentDone(0);

        // Scenario Agent — token stream
        await sleep(200);
        self.agentStart(1);
        await sleep(100); self._logLine(1, '✶ Mapping requirements to end-to-end flows…', 'think');
        const tokens = ['Analysing the user story. ',
                        'Key actor: registered user. ',
                        'Happy path + 3 negative cases identified. ',
                        'Output: 8 structured scenarios.'];
        for (const chunk of tokens) { self.wsToken(chunk); await sleep(260); }
        await sleep(300);
        self.agentProgress(1, 0.8);
        await sleep(400); self.agentDone(1);

        // TC Generator — batched progress
        await sleep(200);
        self.agentStart(2);
        await sleep(100); self._logLine(2, '✶ Expanding scenarios into step-level test cases…', 'think');
        const tcTokens = ['TC-001: Verify the form loads with existing records listed. ',
                          'Steps: 1) open record  2) start edit  3) update fields  4) submit.'];
        for (const chunk of tcTokens) { self.wsToken(chunk); await sleep(320); }
        await sleep(400); self.agentProgress(2, 0.5);
        await sleep(800); self.agentProgress(2, 1.0);
        await sleep(300); self.agentDone(2);

        // Jira not enabled by default in simulate
        [3].forEach(i => self.agentSkip(i));

        await sleep(200);
        self.end();
      })();
    }
  }

  // ── Expose globally ────────────────────────────────────────────────────────
  window.EP = new ExecPane();

})();
