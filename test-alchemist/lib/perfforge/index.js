/**
 * PerfForge run manager — owns the single active run and streams live events
 * over Test Alchemist's WebSocket (global.broadcast). All event types are
 * namespaced `pf_*` so they never collide with existing Test Alchemist events.
 */
const fs = require('fs');
const path = require('path');
const { runNative, evaluateSla } = require('./engine');
const { runExplore } = require('./explorer');

const RUNS_DIR = path.join(__dirname, '..', '..', 'data', 'perfforge');
fs.mkdirSync(RUNS_DIR, { recursive: true });

const bc = (msg) => { if (typeof global.broadcast === 'function') global.broadcast(msg); };

const manager = {
  running: false,
  stopRef: { stopped: false },
  newRun() {
    const id = String(Date.now());
    const dir = path.join(RUNS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    this.stopRef = { stopped: false };
    return { id, dir };
  },
  stop() { this.stopRef.stopped = true; },
};

function persist(dir, result) {
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2));
}

// ── Native load test ────────────────────────────────────────────────────────
async function startNative(cfg) {
  if (manager.running) throw new Error('A test is already running.');
  const { id, dir } = manager.newRun();
  manager.running = true;
  (async () => {
    try {
      bc({ type: 'pf_started', run_id: id, name: cfg.name || 'Load test', mode: 'native' });
      const result = await runNative(cfg, bc, manager.stopRef, dir);
      Object.assign(result, { run_id: id, name: cfg.name || 'Load test', mode: 'native',
        finished_at: Date.now() / 1000, sla: evaluateSla(cfg.sla, result) });
      persist(dir, result);
      bc(result);
    } catch (err) {
      bc({ type: 'pf_error', run_id: id, message: err.message });
    } finally { manager.running = false; }
  })();
  return { run_id: id };
}

// ── AI exploration (+ chained auto load test) ────────────────────────────────
async function startExplore(cfg) {
  if (manager.running) throw new Error('A test is already running.');
  const { id, dir } = manager.newRun();
  manager.running = true;
  (async () => {
    try {
      bc({ type: 'pf_explore_started', run_id: id, goal: cfg.goal, engine: cfg.engine });
      const { result, loadtest } = await runExplore(cfg, bc, manager.stopRef, dir);
      result.run_id = id;
      bc(result);

      if (cfg.load_test && loadtest) {
        bc({ type: 'pf_explore_log', message: `Load-testing ${loadtest.steps.length} discovered API call(s)…` });
        bc({ type: 'pf_started', run_id: id, name: loadtest.name, mode: 'native' });
        const lt = await runNative(loadtest, bc, manager.stopRef, dir);
        Object.assign(lt, { run_id: id, name: loadtest.name, mode: 'native',
          finished_at: Date.now() / 1000, sla: null });
        persist(dir, lt);
        bc(lt);
      }
    } catch (err) {
      bc({ type: 'pf_error', run_id: id, message: err.message });
    } finally { manager.running = false; }
  })();
  return { run_id: id };
}

function history(limit = 50) {
  const runs = [];
  let dirs = [];
  try { dirs = fs.readdirSync(RUNS_DIR).sort().reverse(); } catch { return runs; }
  for (const d of dirs) {
    const rf = path.join(RUNS_DIR, d, 'result.json');
    if (fs.existsSync(rf)) {
      try { runs.push(JSON.parse(fs.readFileSync(rf, 'utf8'))); } catch {}
    }
    if (runs.length >= limit) break;
  }
  return runs;
}

function info() {
  let playwright = false;
  try { require.resolve('playwright'); playwright = true; } catch {}
  // AI provider/keys come from Test Alchemist's ⚙ Settings (passed per-request);
  // navigation defaults to the VS Code Copilot bridge when no provider is chosen.
  return { playwright_available: playwright };
}

module.exports = { startNative, startExplore, manager, history, info, RUNS_DIR };
