/**
 * Test Alchemist — E2E Documentation Generator
 * Captures screenshots of every step/page and builds a PDF guide.
 * Run: node scripts/capture-docs.js
 */

const { chromium } = require('playwright');
const PDFDocument    = require('pdfkit');
const fs             = require('fs');
const path           = require('path');

const BASE_URL  = 'http://localhost:3000';
const OUT_DIR   = path.join(__dirname, '..', 'public', 'docs');
const SS_DIR    = path.join(OUT_DIR, 'screenshots');
const PDF_PATH  = path.join(OUT_DIR, 'Test-Alchemist-Guide.pdf');

fs.mkdirSync(SS_DIR, { recursive: true });

// ── helpers ──────────────────────────────────────────────────────────────────
async function ss(page, name) {
  const file = path.join(SS_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  📸 ${name}`);
  return file;
}

async function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('\n🚀 Launching browser…');
  const launchOpts = { headless: true };
  if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;
  const browser = await chromium.launch(launchOpts);
  const ctx     = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page    = await ctx.newPage();

  await page.goto(BASE_URL, { waitUntil: 'networkidle' });
  await wait(1200);

  const shots = []; // { file, title, caption }

  // ── 0. Header / Home ───────────────────────────────────────────────────────
  await page.evaluate(() => { window.scrollTo(0, 0); });
  shots.push({ file: await ss(page, '00-home'), title: 'Test Alchemist — Home', caption: 'The Test Alchemist landing view shows the 7-step workflow stepper across the top, left-side navigation icons for each step, and the active workspace on the right. The header displays the current AI provider, project, and quick-action buttons.' });

  // ── 1. Step 1 — Agents ─────────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(1); window.scrollTo(0, 0); });
  await wait(800);
  shots.push({ file: await ss(page, '01-agents-top'), title: 'Step 1 — Agents (Workflow)', caption: 'The Agents step is the command centre for the entire pipeline. It shows four agent nodes connected by animated links: Input Parser → Scenario Agent → TC Generator → Jira Publisher (optional). Playwright Builder and Pipeline & Scheduler are standalone agents. "Run All Agents" executes nodes 1–3 (plus Jira if enabled) in sequence.' });

  // scroll to show requirements box
  await page.evaluate(() => window.scrollTo(0, 400));
  await wait(400);
  shots.push({ file: await ss(page, '01-agents-requirements'), title: 'Step 1 — Requirements Quick-Run', caption: 'Below the agent nodes is a Requirements panel that lets you paste requirements directly and click "Start Workflow →" — bypassing Step 2 entirely for a quick single run. A "Load Demo" button pre-fills sample requirements for a fast demo.' });

  // ── 2. Step 2 — Collect Inputs ─────────────────────────────────────────────
  await page.evaluate(() => { goToStep(2); window.scrollTo(0, 0); });
  await wait(800);
  shots.push({ file: await ss(page, '02-inputs'), title: 'Step 2 — Collect Inputs', caption: 'The Inputs step is where you feed requirements into the pipeline. You can type or paste plain text, upload a Word/PDF document, or import from a URL. The AI Provider selector (Claude / GPT / Gemini) and model selector are also set here. A generation title helps organise runs in history.' });

  // ── 3. Step 3 — Scenarios ──────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(3); window.scrollTo(0, 0); });
  await wait(900);
  shots.push({ file: await ss(page, '03-scenarios'), title: 'Step 3 — Scenarios', caption: 'The Scenarios step displays AI-generated test scenarios grouped by module. Each scenario card shows a TS-badge (e.g. TS001), status chip, tags, and acceptance criteria. Click a title to view details; click ✏ to edit. The left panel lists previous generations for quick recall.' });

  // ── 4. Step 4 — Test Cases ─────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(4); window.scrollTo(0, 0); });
  await wait(900);
  shots.push({ file: await ss(page, '04-testcases'), title: 'Step 4 — Test Cases', caption: 'Test Cases are generated from the Scenarios. Each card shows the TC-ID badge, parent scenario chip (TS-xxx in blue), priority, steps, and expected results. The toolbar provides Add, Import, Export CSV, and Regenerate. Click a card title to read the full case in view mode; ✏ to edit steps inline.' });

  // ── 5. Step 5 — Jira Publisher ─────────────────────────────────────────────
  await page.evaluate(() => { goToStep(5); window.scrollTo(0, 0); });
  await wait(900);
  shots.push({ file: await ss(page, '05-jira-top'), title: 'Step 5 — Jira Publisher', caption: 'The Jira Publisher step lets you push test cases directly into Jira as Xray "Test" issues. The TC Selection banner at the top shows how many test cases will be uploaded. Configure your Jira project key, test path/folder, and issue type before uploading.' });

  await page.evaluate(() => window.scrollTo(0, 400));
  await wait(400);
  shots.push({ file: await ss(page, '05-jira-bug'), title: 'Step 5 — Create Bug & Upload Results', caption: 'Below the TC upload section are two more actions: Create Bug (pre-fills summary, allows attaching screenshots) and Upload Test Results (attach run evidence files or export the TC list as JSON). All three operations post directly to your Jira instance via the configured API token.' });

  // ── 6. Step 6 — Playwright ─────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(6); window.scrollTo(0, 0); });
  await wait(1000);
  shots.push({ file: await ss(page, '06-playwright-top'), title: 'Step 6 — Playwright Builder', caption: 'The Playwright step has two sub-sections. The Script Library (top) lists AI-generated Playwright scripts. Each row has Run ▶, PDF report, Edit ✏, and Delete buttons. A TC selector at the top lets you choose which test case to generate a script for.' });

  await page.evaluate(() => window.scrollTo(0, 500));
  await wait(400);
  shots.push({ file: await ss(page, '06-playwright-browser-agent'), title: 'Step 6 — Browser Agent', caption: 'The Browser Agent panel lets you describe an automation task in plain English. It uses a snapshot-first approach: captures a page snapshot → decides the next action (via Claude Haiku) → executes it → repeats until done → generates a Playwright script (via Claude Opus). You can monitor progress in real time and stop at any point.' });

  // ── 7. Step 7 — Pipeline & Scheduler ──────────────────────────────────────
  await page.evaluate(() => { goToStep(7); window.scrollTo(0, 0); });
  await wait(900);
  shots.push({ file: await ss(page, '07-pipeline-top'), title: 'Step 7 — Pipeline & Scheduler', caption: 'The Pipeline step connects Test Alchemist to your GitLab CI. You can trigger a pipeline run immediately or schedule it on a cron expression. The Knowledge Base panel shows approved rules, module coverage, and usage counts that are fed back into the AI agents as context.' });

  await page.evaluate(() => window.scrollTo(0, 500));
  await wait(400);
  shots.push({ file: await ss(page, '07-knowledge'), title: 'Step 7 — Knowledge Base', caption: 'The Knowledge Base stores approved test guidance rules captured from previous runs and manual entry. Each rule has a module tag, weight, and approval status. Approved rules are automatically injected into Scenario and TC generation prompts to improve consistency.' });

  // ── Reference Library ──────────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(1); window.scrollTo(0, 0); });
  await wait(600);
  // open reference library
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, [role="button"]')].find(el => el.textContent.includes('📚') || el.title?.includes('Reference') || el.getAttribute('aria-label')?.includes('Reference'));
    if (btn) btn.click();
  });
  await wait(800);
  shots.push({ file: await ss(page, '08-ref-library'), title: 'Reference Library — Overview', caption: 'The Reference Library (📚 in the header) is a full-page overlay with three tabs: Rules, App Flow Map, and Sources. It serves as the knowledge backbone for all AI agents — rules guide generation, flow maps provide app context, and sources provide curated notes and TC library uploads.' });

  // Rules tab
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('.rl-tab, [data-tab], .tab-btn');
    if (tabs[0]) tabs[0].click();
  });
  await wait(500);
  shots.push({ file: await ss(page, '08-ref-rules'), title: 'Reference Library — Rules', caption: 'The Rules tab shows all captured knowledge entries. Each rule card displays the module, guidance text, and weight. Pending rules (gold border) need approval before being used. You can Approve, Boost weight, or Delete rules. A filter rail on the left allows filtering by module or status.' });

  // Flow Map tab
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.rl-tab, [data-tab], .tab-btn, button')].filter(el => el.textContent.includes('Flow Map') || el.textContent.includes('🗺'));
    if (tabs[0]) tabs[0].click();
  });
  await wait(500);
  shots.push({ file: await ss(page, '08-ref-flowmap'), title: 'Reference Library — App Flow Map', caption: 'The App Flow Map tab documents your application\'s functional flows. Each flow entry has a name, module, description, and step-by-step actions. Flows can be created manually, generated from Figma designs, or auto-extracted by AI from pasted requirements. They provide structural context to the Scenario Agent.' });

  // Sources tab
  await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('.rl-tab, [data-tab], .tab-btn, button')].filter(el => el.textContent.includes('Sources') || el.textContent.includes('🗃'));
    if (tabs[0]) tabs[0].click();
  });
  await wait(500);
  shots.push({ file: await ss(page, '08-ref-sources'), title: 'Reference Library — Sources & Curated Notes', caption: 'The Sources tab has three sections: TC Chat sources, Curated Notes (inline editable free-text notes visible to AI), and TC Library Upload (upload reference test case documents in Word/PDF to inform generation). Uploaded documents are re-analysed each time a new file is added.' });

  // close reference library
  await page.evaluate(() => {
    const closeBtn = document.querySelector('.rl-close, #rlClose, [aria-label="Close"]');
    if (closeBtn) closeBtn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await wait(500);

  // ── Execution Pane ─────────────────────────────────────────────────────────
  await page.evaluate(() => { goToStep(1); window.scrollTo(0, 0); });
  await wait(600);
  // open exec pane by clicking the toggle
  await page.evaluate(() => {
    const toggle = document.querySelector('.ep-toggle, #epToggle, [class*="exec"][class*="toggle"], .exec-pane-btn');
    if (toggle) toggle.click();
  });
  await wait(600);
  shots.push({ file: await ss(page, '09-exec-pane'), title: 'Execution Pane', caption: 'The Execution Pane slides in from the bottom right during a workflow run. It shows real-time status for each agent: QUEUED → RUNNING (with elapsed timer and progress bar) → DONE or ERROR. A live log feed streams AI token output as each agent works. The counter (e.g. 3 / 3 agents) tracks completion.' });

  await browser.close();
  console.log(`\n✅ ${shots.length} screenshots captured`);

  // ── Build PDF ───────────────────────────────────────────────────────────────
  console.log('\n📄 Building PDF…');
  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: false });
  const out  = fs.createWriteStream(PDF_PATH);
  doc.pipe(out);

  const PW  = 595.28;  // A4 points width
  const PH  = 841.89;  // A4 points height
  const PAD = 36;
  const CONTENT_W = PW - PAD * 2;

  // ── Cover page ──────────────────────────────────────────────────────────────
  doc.addPage();
  // dark background
  doc.rect(0, 0, PW, PH).fill('#1a1a2e');
  // gold accent bar
  doc.rect(0, PH * 0.38, PW, 4).fill('#f5c518');
  // title
  doc.font('Helvetica-Bold').fontSize(38).fillColor('#f5c518')
     .text('Test Alchemist', PAD, PH * 0.25, { width: CONTENT_W, align: 'center' });
  doc.font('Helvetica').fontSize(20).fillColor('#ffffff')
     .text('End-to-End User Guide', PAD, PH * 0.25 + 52, { width: CONTENT_W, align: 'center' });
  doc.font('Helvetica').fontSize(12).fillColor('#aaaaaa')
     .text('The intelligent test workbench — AI-powered scenarios, test cases,\nJira publishing, Playwright automation & CI pipelines.', PAD, PH * 0.42, { width: CONTENT_W, align: 'center' });
  // generated date
  doc.font('Helvetica').fontSize(10).fillColor('#666666')
     .text(`Generated: ${new Date().toLocaleDateString('en-SG', { day:'2-digit', month:'long', year:'numeric' })}`, PAD, PH - 60, { width: CONTENT_W, align: 'center' });

  // ── Table of Contents ───────────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PW, PH).fill('#0f0f1a');
  doc.rect(PAD, 60, 4, 30).fill('#f5c518');
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#ffffff')
     .text('Table of Contents', PAD + 16, 65);

  const tocItems = shots.map((s, i) => `${(i+1).toString().padStart(2,'0')}.  ${s.title}`);
  doc.font('Helvetica').fontSize(12).fillColor('#cccccc')
     .text(tocItems.join('\n'), PAD, 120, { width: CONTENT_W, lineGap: 6 });

  // ── Section pages ────────────────────────────────────────────────────────────
  for (let i = 0; i < shots.length; i++) {
    const { file, title, caption } = shots[i];
    if (!fs.existsSync(file)) { console.warn(`  ⚠ Missing: ${file}`); continue; }

    doc.addPage();
    // dark background
    doc.rect(0, 0, PW, PH).fill('#0f0f1a');

    // section number chip
    const num = (i + 1).toString().padStart(2, '0');
    doc.rect(PAD, 28, 30, 22).fill('#f5c518').roundedRect(PAD, 28, 30, 22, 4).fill('#f5c518');
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#000000').text(num, PAD + 8, 33);

    // title
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#ffffff')
       .text(title, PAD + 38, 30, { width: CONTENT_W - 38 });

    // gold separator
    doc.rect(PAD, 62, CONTENT_W, 1).fill('#f5c518');

    // screenshot — fit proportionally in ~500pt tall box
    const imgY  = 72;
    const maxH  = 490;
    const imgDims = sizeOf(file);
    let imgW = CONTENT_W, imgH = (CONTENT_W / imgDims.w) * imgDims.h;
    if (imgH > maxH) { imgH = maxH; imgW = (maxH / imgDims.h) * imgDims.w; }
    const imgX = PAD + (CONTENT_W - imgW) / 2;
    doc.image(file, imgX, imgY, { width: imgW, height: imgH });

    // caption box
    const captionY = imgY + imgH + 12;
    doc.rect(PAD, captionY, CONTENT_W, 1).fill('#333333');
    doc.font('Helvetica').fontSize(10).fillColor('#bbbbbb')
       .text(caption, PAD, captionY + 8, { width: CONTENT_W, align: 'justify', lineGap: 3 });

    // page number footer
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
       .text(`Test Alchemist Guide  •  Page ${i + 3} of ${shots.length + 2}`, PAD, PH - 28, { width: CONTENT_W, align: 'center' });
  }

  doc.end();

  await new Promise((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
  });

  console.log(`\n✅ PDF saved → ${PDF_PATH}`);
  console.log(`🔗 Download at: http://localhost:3000/docs/Test-Alchemist-Guide.pdf`);
})();

// ── Tiny image size helper (PNG only via Buffer) ─────────────────────────────
function sizeOf(filePath) {
  const buf = fs.readFileSync(filePath);
  // PNG: width at offset 16, height at offset 20 (4 bytes each, big-endian)
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return { w: 1280, h: 800 }; // fallback
}
