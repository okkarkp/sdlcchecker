/**
 * PerfForge — AI-driven performance explorer (Node port).
 * Drives Playwright, captures page + API timings, flags issues, and builds a
 * load-test config from the discovered API calls. Two engines:
 *   heuristic — auto-login + breadth-first same-origin crawl (no API key)
 *   claude    — agentic loop where Claude reads each page and picks the next action
 */
const { now, round } = require('./engine');

const SLOW_API_MS = 1000, SLOW_PAGE_LOAD_MS = 3000, SLOW_LCP_MS = 2500, HEAVY_KB = 1024;

const LCP_INIT = `
window.__pf_lcp = 0;
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__pf_lcp = e.startTime; })
  .observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
`;

class PerfCollector {
  constructor() { this.requests = []; this.pages = []; this.authHeaders = {}; }
  attach(context) {
    context.on('response', async (response) => {
      try {
        const req = response.request();
        const t = req.timing();
        let dur = t && t.responseEnd > 0 ? t.responseEnd : 0;
        const size = parseInt(response.headers()['content-length'] || '0', 10) || 0;
        const auth = (req.headers())['authorization'];
        if (auth && !this.authHeaders.Authorization) this.authHeaders.Authorization = auth;
        this.requests.push({
          url: req.url(), method: req.method(), status: response.status(),
          type: req.resourceType(), duration_ms: round(dur, 1), size_kb: round(size / 1024, 1),
        });
      } catch {}
    });
  }
  async measurePage(page) {
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch {}
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint');
      const fcp = (paints.find(p => p.name === 'first-contentful-paint') || {}).startTime || 0;
      return {
        ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0),
        load: Math.round(nav.loadEventEnd || 0), fcp: Math.round(fcp),
        lcp: Math.round(window.__pf_lcp || 0),
      };
    });
    m.url = page.url();
    m.title = await page.title();
    this.pages.push(m);
    return m;
  }
}

function detectIssues(c) {
  const issues = [];
  for (const r of c.requests) {
    if ((r.type === 'xhr' || r.type === 'fetch') && r.duration_ms >= SLOW_API_MS)
      issues.push({ severity: 'high', kind: 'slow_api', detail: `${r.method} ${r.url} took ${r.duration_ms} ms` });
    if (r.size_kb >= HEAVY_KB)
      issues.push({ severity: 'medium', kind: 'heavy_resource', detail: `${r.url} is ${r.size_kb} KB` });
    if (r.status >= 500)
      issues.push({ severity: 'high', kind: 'server_error', detail: `${r.status} on ${r.url}` });
  }
  for (const p of c.pages) {
    if (p.load >= SLOW_PAGE_LOAD_MS) issues.push({ severity: 'high', kind: 'slow_page', detail: `${p.url} load=${p.load} ms` });
    if (p.lcp >= SLOW_LCP_MS) issues.push({ severity: 'medium', kind: 'slow_lcp', detail: `${p.url} LCP=${p.lcp} ms` });
  }
  const seen = new Set();
  return issues.filter(i => { const k = i.kind + i.detail; if (seen.has(k)) return false; seen.add(k); return true; });
}

async function tryLogin(page, username, password) {
  if (!password) return false;
  const pwd = page.locator('input[type=password]').first();
  try { if (await pwd.count() === 0) return false; } catch { return false; }
  try {
    const user = page.locator('input[type=email], input[type=text], input[name*=user i], input[name*=email i]').first();
    if (username && await user.count() > 0) await user.fill(username);
    await pwd.fill(password);
    const btn = page.locator("button[type=submit], input[type=submit], button:has-text('Log in'), button:has-text('Sign in'), button:has-text('Login'), button:has-text('Submit')").first();
    if (await btn.count() > 0) await btn.click(); else await pwd.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 15000 });
    return true;
  } catch { return false; }
}

// Open a visible browser and wait for the user to sign in (SSO / federated / MFA flows).
// Proceeds once the URL leaves the login/auth page, or after a timeout.
const LOGIN_RE = /login|sign[\-_]?in|signin|auth|sso|logon|oauth/i;
async function waitForManualLogin(page, broadcast, stopRef, timeoutMs = 180000) {
  const startUrl = page.url();
  broadcast({ type: 'pf_explore_log',
    message: '🔑 Manual login — sign in using the opened browser window. Exploration begins automatically once you reach the app (waiting up to 3 min).' });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopRef.stopped) {
    try { await page.waitForTimeout(2500); } catch { break; }
    let u; try { u = page.url(); } catch { break; }
    if (u && u !== startUrl && !LOGIN_RE.test(u)) {
      broadcast({ type: 'pf_explore_log', message: `Login detected → ${u}` });
      try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
      return;
    }
  }
  broadcast({ type: 'pf_explore_log', message: 'Manual-login wait ended — continuing.' });
}

async function snapshot(page, limit = 40) {
  return page.evaluate((lim) => {
    const els = [...document.querySelectorAll('a,button,input,select,textarea,[role=button]')];
    const out = []; let idx = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      el.setAttribute('data-pf-idx', idx);
      const label = (el.innerText || el.value || el.getAttribute('aria-label') ||
                     el.getAttribute('placeholder') || el.name || '').trim().slice(0, 60);
      out.push({ idx, tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', label });
      idx++; if (idx >= lim) break;
    }
    return out;
  }, limit);
}

async function crawlHeuristic(page, cfg, c, broadcast) {
  const origin = new URL(cfg.url).host;
  const visited = new Set();
  const queue = [cfg.url];
  let steps = 0;
  while (queue.length && steps < cfg.max_steps) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url); steps++;
    try { await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' }); }
    catch (e) { broadcast({ type: 'pf_explore_log', message: `⚠ failed ${url}: ${e.name}` }); continue; }
    const m = await c.measurePage(page);
    broadcast({ type: 'pf_explore_step', step: steps, action: 'visit', url, load_ms: m.load, lcp_ms: m.lcp });
    let hrefs = [];
    try { hrefs = await page.$$eval('a[href]', els => els.map(e => e.href)); } catch {}
    for (const h of hrefs) {
      try {
        const full = new URL(h, url).href;
        if (new URL(full).host === origin && !visited.has(full) && !queue.includes(full)) queue.push(full);
      } catch {}
    }
  }
}

// AI navigation routed through Test Alchemist's provider layer (providers/index.js).
// Uses a text + JSON-action loop (no vision / no native tool-calling) so it works
// across every configured provider — including the default VS Code Copilot bridge.
function providerOpts(cfg) {
  return {
    provider: cfg.provider || 'copilot',
    model: cfg.model,
    anthropicApiKey: cfg.anthropicApiKey,
    openaiApiKey: cfg.openaiApiKey,
    geminiApiKey: cfg.geminiApiKey,
    copilotToken: cfg.copilotToken,
  };
}

const AI_SYSTEM = (goal) =>
  `You are a performance-testing explorer driving a web browser.\nYour goal: ${goal}\n\n` +
  `Each turn you receive the current URL, page title, your recent actions, and a numbered list of interactive elements. ` +
  `Choose ONE next action to exercise the app's main user journeys so its pages and API calls can be measured. ` +
  `Prefer distinct, meaningful pages (dashboards, lists, detail views, search) over repeating actions.\n\n` +
  `Respond with ONLY a JSON object — one of:\n` +
  `{"action":"navigate","url":"https://…"}\n{"action":"click","idx":N}\n` +
  `{"action":"type","idx":N,"text":"…"}\n{"action":"finish","reason":"…"}\n` +
  `Return only the JSON, no prose.`;

async function exploreAI(page, cfg, c, broadcast) {
  const { callAI } = require('../../providers');
  const opts = providerOpts(cfg);
  const system = AI_SYSTEM(cfg.goal);
  const recent = [];
  let summary = 'completed';

  for (let step = 0; step < cfg.max_steps; step++) {
    const m = await c.measurePage(page);
    const elements = await snapshot(page);
    const elText = elements.map(e => `[${e.idx}] ${e.tag} ${e.type} ${e.label}`).join('\n') || '(no interactive elements)';
    broadcast({ type: 'pf_explore_step', step: step + 1, action: 'measure', url: m.url, load_ms: m.load, lcp_ms: m.lcp });

    const prompt = `URL: ${m.url}\nTitle: ${m.title}\nRecent actions:\n${recent.slice(-6).join('\n') || '(none yet)'}\n` +
      `Interactive elements:\n${elText}\n\nReturn the next action as JSON.`;
    let act;
    try {
      act = await callAI(prompt, 800, { ...opts, systemPrompt: system });
      if (Array.isArray(act)) act = act[0];
    } catch (e) {
      broadcast({ type: 'pf_explore_log', message: `AI error: ${e.message}` });
      summary = `AI navigation stopped: ${e.message}`;
      break;
    }
    if (!act || !act.action) { break; }
    broadcast({ type: 'pf_explore_log', message: `AI → ${JSON.stringify(act).slice(0, 140)}` });
    recent.push(`${act.action} ${act.url || act.idx || ''}`.trim());
    try {
      if (act.action === 'navigate') await page.goto(act.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      else if (act.action === 'click') await page.click(`[data-pf-idx='${act.idx}']`, { timeout: 8000 });
      else if (act.action === 'type') await page.fill(`[data-pf-idx='${act.idx}']`, act.text || '', { timeout: 8000 });
      else if (act.action === 'finish') { summary = act.reason || 'finished'; break; }
    } catch (e) { broadcast({ type: 'pf_explore_log', message: `action failed: ${e.message}` }); }
  }
  return summary;
}

async function diagnoseAI(cfg, c, issues) {
  try {
    const { callAI } = require('../../providers');
    const slow = [...c.requests].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 15);
    const prompt = `Measured performance data (JSON):\n${JSON.stringify({ pages: c.pages, slowest_requests: slow, detected_issues: issues }).slice(0, 40000)}\n\n` +
      `Write a short prioritized diagnosis of the most important performance issues with concrete, specific recommendations. Markdown.`;
    return await callAI(prompt, 1500, { ...providerOpts(cfg), rawText: true,
      systemPrompt: 'You are a senior web performance engineer. Be specific and concise.' });
  } catch (e) { return `(AI diagnosis unavailable: ${e.message})`; }
}

function buildLoadtestConfig(cfg, c) {
  const seen = new Set(), steps = [];
  for (const r of [...c.requests].sort((a, b) => b.duration_ms - a.duration_ms)) {
    if (r.method !== 'GET' || !(r.type === 'xhr' || r.type === 'fetch')) continue;
    if (r.status >= 400 || seen.has(r.url)) continue;
    seen.add(r.url);
    let pathName = 'api';
    try { pathName = new URL(r.url).pathname.slice(0, 40) || 'api'; } catch {}
    steps.push({ name: pathName, method: 'GET', url: r.url, headers: { ...c.authHeaders } });
    if (steps.length >= 5) break;
  }
  if (!steps.length) return null;
  return { name: 'AI-discovered API load test', steps, concurrency: cfg.concurrency,
           duration: cfg.duration };
}

async function runExplore(cfg, broadcast, stopRef, runDir) {
  if (!cfg.url) throw new Error('A target URL is required.');
  let chromium;
  try { ({ chromium } = require('playwright')); }
  catch (e) { throw new Error('Playwright not installed. Run: npm run install:playwright'); }

  const fs = require('fs'), path = require('path');
  const c = new PerfCollector();
  const start = now();
  let browser, summary = 'completed', cookies = [];
  // Manual login needs a visible browser the user can interact with.
  const headless = cfg.manual_login ? false : (cfg.headless !== false);
  try {
    browser = await chromium.launch({ headless });
  } catch (e) {
    throw new Error('Chromium not found. Run: npx playwright install chromium');
  }
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: cfg.verify_ssl === false });
    await context.addInitScript(LCP_INIT);
    c.attach(context);
    const page = await context.newPage();
    broadcast({ type: 'pf_explore_log', message: `Opening ${cfg.url}` });
    await page.goto(cfg.url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    if (cfg.manual_login) {
      await waitForManualLogin(page, broadcast, stopRef);
    } else if (cfg.password) {
      const ok = await tryLogin(page, cfg.username, cfg.password);
      broadcast({ type: 'pf_explore_log', message: ok ? 'Login submitted' : 'No login form found' });
    }
    if (cfg.engine === 'heuristic') { await crawlHeuristic(page, cfg, c, broadcast); summary = 'heuristic crawl complete'; }
    else summary = await exploreAI(page, cfg, c, broadcast);
    cookies = await context.cookies();
  } finally { if (browser) await browser.close(); }

  if (cookies.length) {
    const cookieHdr = cookies.map(ck => `${ck.name}=${ck.value}`).join('; ');
    if (!c.authHeaders.Cookie) c.authHeaders.Cookie = cookieHdr;
  }

  const issues = detectIssues(c);
  const diagnosis = cfg.engine !== 'heuristic' ? await diagnoseAI(cfg, c, issues) : null;
  const result = {
    type: 'pf_explore_done', summary, elapsed: round((now() - start) / 1000, 1),
    pages_visited: c.pages.length, requests_captured: c.requests.length,
    pages: c.pages, issues, diagnosis,
    slowest_requests: [...c.requests].sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 15),
  };
  fs.writeFileSync(path.join(runDir, 'explore.json'), JSON.stringify(result, null, 2));
  return { result, loadtest: buildLoadtestConfig(cfg, c) };
}

module.exports = { runExplore, detectIssues, buildLoadtestConfig };
