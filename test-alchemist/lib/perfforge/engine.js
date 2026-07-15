/**
 * PerfForge — native async HTTP load engine (Node port).
 * Mirrors the Python engine: concurrency, ramp-up, think-time, multi-step
 * scenarios with ${var} extraction, live percentile snapshots, sample CSV.
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const now = () => performance.now();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round = (v, d = 1) => { const m = 10 ** d; return Math.round(v * m) / m; };

function percentile(sorted, pct) {
  if (!sorted.length) return 0;
  const k = (sorted.length - 1) * (pct / 100);
  const f = Math.floor(k), c = Math.ceil(k);
  if (f === c) return sorted[f];
  return sorted[f] * (c - k) + sorted[c] * (k - f);
}

function summarize(lat, total, errors) {
  const s = [...lat].sort((a, b) => a - b);
  return {
    total, errors,
    error_rate: total ? (errors / total) * 100 : 0,
    min: s[0] || 0, max: s[s.length - 1] || 0,
    avg: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0,
    p50: percentile(s, 50), p90: percentile(s, 90),
    p95: percentile(s, 95), p99: percentile(s, 99),
  };
}

const sortCodes = (codes) =>
  Object.fromEntries(Object.entries(codes).sort((a, b) => a[0] - b[0]));

class Stats {
  constructor() {
    this.lat = []; this.total = 0; this.errors = 0;
    this.codes = {}; this.errorTypes = {}; this.bytes = 0; this.labels = {};
  }
  record(ms, status, ok, label = 'request', err = null, size = 0) {
    this.lat.push(ms); this.total++; this.bytes += size;
    this.codes[status] = (this.codes[status] || 0) + 1;
    if (!ok) { this.errors++; if (err) this.errorTypes[err] = (this.errorTypes[err] || 0) + 1; }
    const L = this.labels[label] || (this.labels[label] = { lat: [], total: 0, errors: 0 });
    L.lat.push(ms); L.total++; if (!ok) L.errors++;
  }
  perLabel() {
    return Object.entries(this.labels).map(([name, L]) =>
      ({ name, ...summarize(L.lat, L.total, L.errors) }));
  }
  snapshot(elapsed, intervalCount, intervalSecs, active) {
    return { type: 'pf_snapshot', ...summarize(this.lat, this.total, this.errors),
      elapsed: round(elapsed, 1),
      rps: intervalSecs > 0 ? round(intervalCount / intervalSecs, 1) : 0,
      active_workers: active, status_codes: sortCodes(this.codes) };
  }
  final(elapsed) {
    return { type: 'pf_done', ...summarize(this.lat, this.total, this.errors),
      elapsed: round(elapsed, 1),
      throughput: elapsed > 0 ? round(this.total / elapsed, 1) : 0,
      status_codes: sortCodes(this.codes), error_types: this.errorTypes,
      bytes_received: this.bytes, steps: this.perLabel() };
  }
}

// ── ${var} substitution + extraction ──────────────────────────────────────
const subst = (text, vars) =>
  !text ? text : text.replace(/\$\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));

function jsonPath(data, expr) {
  expr = expr.replace(/^\$\.?/, '');
  let cur = data;
  for (const part of expr.match(/[^.\[\]]+|\[\d+\]/g) || []) {
    if (part.startsWith('[')) cur = cur[parseInt(part.slice(1, -1))];
    else if (Array.isArray(cur)) cur = cur[parseInt(part)];
    else cur = cur[part];
  }
  return cur;
}

function extract(step, resp, text, vars) {
  for (const ex of step.extract || []) {
    try {
      if (ex.source === 'json') vars[ex.name] = String(jsonPath(JSON.parse(text), ex.expr));
      else if (ex.source === 'header') vars[ex.name] = resp.headers.get(ex.expr) || '';
      else if (ex.source === 'regex') {
        const m = text.match(new RegExp(ex.expr));
        vars[ex.name] = m ? (m[1] ?? m[0]) : '';
      }
    } catch { vars[ex.name] = ''; }
  }
}

// ── SLA evaluation ─────────────────────────────────────────────────────────
function evaluateSla(sla, result) {
  if (!sla) return null;
  const checks = [];
  const add = (name, actual, ok) => checks.push({ name, actual: round(actual, 2), passed: ok });
  if (sla.max_p95 != null) add(`p95 ≤ ${sla.max_p95} ms`, result.p95, result.p95 <= sla.max_p95);
  if (sla.max_avg != null) add(`avg ≤ ${sla.max_avg} ms`, result.avg, result.avg <= sla.max_avg);
  if (sla.max_error_rate != null) add(`errors ≤ ${sla.max_error_rate}%`, result.error_rate, result.error_rate <= sla.max_error_rate);
  if (sla.min_throughput != null) add(`throughput ≥ ${sla.min_throughput}/s`, result.throughput, result.throughput >= sla.min_throughput);
  if (!checks.length) return null;
  return { passed: checks.every(c => c.passed), checks };
}

// ── Native engine ──────────────────────────────────────────────────────────
async function runNative(cfg, broadcast, stopRef, runDir) {
  const steps = (cfg.steps && cfg.steps.length) ? cfg.steps
    : [{ name: 'request', method: cfg.method || 'GET', url: cfg.url,
         headers: cfg.headers || {}, body: cfg.body || '' }];
  if (!steps.some(s => s.url)) throw new Error('At least one step needs a target URL.');

  const stats = new Stats();
  const start = now();
  const deadline = start + (cfg.duration || 30) * 1000;
  const samples = fs.createWriteStream(path.join(runDir, 'samples.csv'));
  samples.write('timestamp,step,latency_ms,status,success\n');
  let started = 0;

  async function doStep(step, vars) {
    const method = (step.method || 'GET').toUpperCase();
    const url = subst(step.url, vars);
    const headers = {};
    for (const [k, v] of Object.entries(step.headers || {})) headers[k] = subst(v, vars);
    const body = subst(step.body || '', vars);
    const t0 = now();
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), (cfg.timeout || 30) * 1000);
    try {
      const opts = { method, headers, signal: ctrl.signal, redirect: 'follow' };
      if (body && !['GET', 'HEAD'].includes(method)) opts.body = body;
      const r = await fetch(url, opts);
      const text = await r.text();
      const dt = now() - t0;
      const ok = r.status < 400;
      stats.record(dt, r.status, ok, step.name, ok ? null : `HTTP ${r.status}`,
                   Buffer.byteLength(text));
      samples.write(`${(Date.now() / 1000).toFixed(3)},${step.name},${dt.toFixed(2)},${r.status},${ok}\n`);
      if (ok && step.extract && step.extract.length) extract(step, r, text, vars);
    } catch (e) {
      const dt = now() - t0;
      stats.record(dt, 0, false, step.name, e.name || 'Error');
      samples.write(`${(Date.now() / 1000).toFixed(3)},${step.name},${dt.toFixed(2)},0,false\n`);
    } finally { clearTimeout(to); }
  }

  async function worker() {
    while (!stopRef.stopped && now() < deadline) {
      const vars = {};
      for (const step of steps) {
        if (stopRef.stopped || now() >= deadline) break;
        await doStep(step, vars);
      }
      if (cfg.think_time) await sleep(cfg.think_time * 1000);
    }
  }

  let lastCount = 0, lastT = start;
  const reporter = setInterval(() => {
    const t = now();
    broadcast(stats.snapshot((t - start) / 1000, stats.total - lastCount,
                             (t - lastT) / 1000, started));
    lastCount = stats.total; lastT = t;
  }, 1000);

  const tasks = [];
  const gap = (cfg.ramp_up && cfg.concurrency) ? (cfg.ramp_up / cfg.concurrency) * 1000 : 0;
  for (let i = 0; i < (cfg.concurrency || 10); i++) {
    if (stopRef.stopped) break;
    tasks.push(worker()); started++;
    if (gap) await sleep(gap);
  }
  while (now() < deadline && !stopRef.stopped) await sleep(200);
  await Promise.allSettled(tasks);
  clearInterval(reporter);
  await new Promise(res => samples.end(res));

  const final = stats.final((now() - start) / 1000);
  final.samples_csv = 'samples.csv';
  return final;
}

module.exports = { Stats, runNative, evaluateSla, percentile, summarize, round, now, sleep };
