'use strict';
/**
 * lib/app-crawler.js — App Flow Recorder
 *
 * Opens a browser for the user to navigate manually. Records:
 * - Every page visited (URL, title, elements)
 * - Navigation flow between pages
 * - Forms, buttons, and inputs on each page
 *
 * The user logs in, explores the app, then clicks "Stop" to save the recorded flows.
 */

const { chromium } = require('playwright');

/**
 * Record user's navigation flow
 * @param {string} baseUrl - Starting URL
 * @param {object} opts - Options including _controller for stop signal
 * @param {function} broadcastFn - Progress callback
 * @returns {object} App map with recorded pages and flows
 */
async function crawlApp(baseUrl, opts = {}, broadcastFn = () => {}) {
  const ctrl = opts._controller || {};
  const recordedPages = []; // { url, title, type, elements, timestamp }
  const navFlows = []; // { from, to, action, timestamp }

  let browser;
  try {
    broadcastFn({ type: 'crawl_progress', status: 'launching', message: 'Launching browser…' });

    browser = await chromium.launch({
      headless: false,
      args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    // Track the last URL to detect navigation
    let lastUrl = '';
    let pageCount = 0;

    // Listen for navigations — record each new page
    page.on('framenavigated', async (frame) => {
      if (frame !== page.mainFrame()) return; // only main frame
      try {
        const url = frame.url();
        if (!url || url === 'about:blank' || url === lastUrl) return;

        // Record navigation flow
        if (lastUrl && lastUrl !== 'about:blank') {
          navFlows.push({ from: lastUrl, to: url, action: 'navigation', timestamp: new Date().toISOString() });
        }
        lastUrl = url;

        // Wait for the page to fully render (SPAs need time)
        await page.waitForTimeout(2500);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});

        // Analyze the page
        const pageInfo = await extractPageInfo(page).catch(() => null);
        if (pageInfo && !recordedPages.find(p => p.url === url)) {
          pageCount++;
          recordedPages.push({ ...pageInfo, url, timestamp: new Date().toISOString() });
          broadcastFn({
            type: 'crawl_progress',
            status: 'recording',
            message: `🔴 Recording — ${pageCount} page(s) captured. Current: ${pageInfo.title || url}`,
            current: pageCount,
          });
        }
      } catch (err) {
        // Page may have navigated away during extraction — ignore
      }
    });

    // Navigate to the starting URL
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});

    broadcastFn({ type: 'crawl_progress', status: 'recording', message: '🔴 Recording — navigate the app. Click ⏹ Stop & Save when done.' });

    // Keep browser open until user clicks Stop (or 15 min timeout)
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 15 * 60 * 1000);
      ctrl._stopResolve = () => { clearTimeout(timeout); resolve(); };

      // Also check periodically if state changed to stopped
      const check = setInterval(() => {
        if (ctrl.state === 'stopped') {
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        }
      }, 500);
    });

    broadcastFn({ type: 'crawl_progress', status: 'complete', message: `Recording complete — ${recordedPages.length} pages captured` });

    // Build the app map from recorded data
    const appMap = buildAppMap(baseUrl, recordedPages, navFlows);
    return appMap;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Extract page info from the currently loaded page
 */
async function extractPageInfo(page) {
  const title = await page.title();
  const url = page.url();

  const elements = await page.evaluate(() => {
    const results = { forms: [], buttons: [], links: [], inputs: [], selects: [], textareas: [] };

    // Forms
    document.querySelectorAll('form').forEach((form, idx) => {
      const fields = [];
      form.querySelectorAll('input, select, textarea').forEach(el => {
        if (el.type === 'hidden') return;
        fields.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          required: el.required,
          label: findLabel(el),
        });
      });
      results.forms.push({
        id: form.id || `form-${idx}`,
        action: form.action || '',
        method: (form.method || 'GET').toUpperCase(),
        fields,
        submitButton: getSubmitButton(form),
      });
    });

    // Standalone inputs
    document.querySelectorAll('input:not(form input), select:not(form select), textarea:not(form textarea)').forEach(el => {
      if (el.type === 'hidden') return;
      const info = { tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', placeholder: el.placeholder || '', label: findLabel(el) };
      if (el.tagName === 'SELECT') { info.options = [...el.options].slice(0, 15).map(o => o.textContent.trim()); results.selects.push(info); }
      else if (el.tagName === 'TEXTAREA') { results.textareas.push(info); }
      else { results.inputs.push(info); }
    });

    // Buttons
    document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach(el => {
      const text = el.textContent?.trim().substring(0, 80) || el.value || '';
      if (text) results.buttons.push({ text, type: el.type || '', id: el.id || '' });
    });

    // Links
    document.querySelectorAll('a[href]').forEach(el => {
      const href = el.href;
      if (!href || href.startsWith('javascript:') || href === '#' || href.startsWith('mailto:')) return;
      results.links.push({ text: el.textContent?.trim().substring(0, 60) || '', href });
    });

    function findLabel(el) {
      if (el.id) { const lbl = document.querySelector(`label[for="${el.id}"]`); if (lbl) return lbl.textContent.trim().substring(0, 60); }
      const parent = el.closest('label');
      if (parent) return parent.textContent.trim().substring(0, 60);
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    }
    function getSubmitButton(form) {
      const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
      return btn ? (btn.textContent?.trim() || btn.value || 'Submit') : null;
    }
    return results;
  });

  // Headings
  const headings = await page.evaluate(() => {
    return [...document.querySelectorAll('h1, h2, h3')].slice(0, 10).map(h => ({ level: parseInt(h.tagName[1]), text: h.textContent.trim().substring(0, 80) }));
  });

  const pageType = detectPageType(elements, headings, url);

  return { url, title, type: pageType, headings, ...elements };
}

/**
 * Detect what type of page this is
 */
function detectPageType(elements, headings, url) {
  const urlLower = url.toLowerCase();
  const headingText = headings.map(h => h.text.toLowerCase()).join(' ');

  if (urlLower.includes('login') || headingText.includes('log in') || headingText.includes('sign in')) return 'login';
  if (urlLower.includes('register') || urlLower.includes('signup') || headingText.includes('sign up')) return 'registration';
  if (urlLower.includes('dashboard') || headingText.includes('dashboard')) return 'dashboard';
  if (urlLower.includes('settings') || urlLower.includes('preferences')) return 'settings';
  if (urlLower.includes('profile')) return 'profile';
  if (urlLower.includes('search') || elements.forms?.some(f => f.fields.some(fi => fi.type === 'search'))) return 'search';
  if (elements.forms?.length > 0 && elements.forms[0].fields.length > 3) return 'form';
  if (urlLower.includes('list') || urlLower.includes('table')) return 'list';
  if (urlLower.includes('detail') || urlLower.includes('/view/')) return 'detail';
  return 'page';
}

/**
 * Build the final app map from recorded pages
 */
function buildAppMap(baseUrl, recordedPages, navFlows) {
  const pages = recordedPages.map(p => ({
    url: p.url,
    title: p.title,
    type: p.type,
    headings: p.headings,
    forms: p.forms || [],
    buttons: (p.buttons || []).slice(0, 20),
    inputs: p.inputs || [],
    selects: p.selects || [],
    textareas: p.textareas || [],
    linkCount: (p.links || []).length,
  }));

  // Build navigation flows as adjacency list
  const flows = {};
  for (const edge of navFlows) {
    if (!flows[edge.from]) flows[edge.from] = [];
    flows[edge.from].push({ to: edge.to, action: edge.action });
  }

  return {
    baseUrl,
    source: 'recording',
    crawledAt: new Date().toISOString(),
    totalPages: pages.length,
    pages,
    navigationFlows: flows,
    summary: buildSummary(pages),
  };
}

function buildSummary(pages) {
  const types = {};
  let totalForms = 0, totalButtons = 0, totalInputs = 0;

  pages.forEach(p => {
    types[p.type] = (types[p.type] || 0) + 1;
    totalForms += (p.forms?.length || 0);
    totalButtons += (p.buttons?.length || 0);
    totalInputs += (p.inputs?.length || 0) + (p.selects?.length || 0) + (p.textareas?.length || 0);
  });

  return { pageTypes: types, totalForms, totalButtons, totalInputs };
}

/**
 * Generate a compact context string for the AI from an app map
 */
function getAppMapContext(appMap) {
  if (!appMap || !appMap.pages?.length) return '';

  const lines = [`\nAPPLICATION MAP (${appMap.totalPages} pages recorded from ${appMap.baseUrl}):\n`];

  for (const page of appMap.pages) {
    lines.push(`• [${page.type.toUpperCase()}] ${page.title || page.url}`);
    lines.push(`  URL: ${page.url}`);

    if (page.forms?.length) {
      page.forms.forEach(form => {
        const fieldNames = form.fields.map(f => f.label || f.name || f.placeholder || f.type).join(', ');
        lines.push(`  FORM: ${form.method} ${form.action || '(self)'} — Fields: ${fieldNames}`);
        if (form.submitButton) lines.push(`    Submit: "${form.submitButton}"`);
      });
    }

    if (page.buttons?.length) {
      lines.push(`  BUTTONS: ${page.buttons.map(b => `"${b.text}"`).join(', ')}`);
    }

    if (page.inputs?.length || page.selects?.length) {
      const standalone = [...(page.inputs || []), ...(page.selects || [])];
      if (standalone.length) {
        lines.push(`  INPUTS: ${standalone.map(i => i.label || i.name || i.placeholder || i.type).join(', ')}`);
      }
    }
    lines.push('');
  }

  // Navigation flows
  if (Object.keys(appMap.navigationFlows || {}).length) {
    lines.push('NAVIGATION FLOWS:');
    for (const [from, edges] of Object.entries(appMap.navigationFlows)) {
      edges.forEach(e => {
        const fromShort = from.replace(appMap.baseUrl, '') || '/';
        const toShort = e.to.replace(appMap.baseUrl, '') || '/';
        lines.push(`  ${fromShort} → ${toShort}`);
      });
    }
  }

  return lines.join('\n');
}

module.exports = { crawlApp, getAppMapContext };
