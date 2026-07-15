# Test Alchemist — Team Usage Guide

A practical, step-by-step guide for team members using Test Alchemist day-to-day.
For first-time project setup see **[SETUP.md](SETUP.md)**.

---

## What is Test Alchemist?

Test Alchemist is a local AI-powered QA workbench. You paste requirements (or import from
Confluence/Jira), and it generates test scenarios → test cases → Playwright automation
scripts, publishes them to Jira/Xray, and drives a headed browser to automate them — all
from a browser UI at **http://localhost:3000**.

---

## 0. Point it at your project (project-agnostic)

Test Alchemist is **project-agnostic** — one copy works for any project. A project's
identity lives in a single declarative file, **`project.config.json`**; secrets live
separately in `.env`. Set both in one guided step:

```bash
npm run init       # writes project.config.json (identity) + .env (secrets)
```

`project.config.json` looks like this (copy from
[`project.config.example.json`](project.config.example.json) to edit by hand instead):

```json
{
  "appName": "My Project QA",
  "appBaseUrl": "https://app-under-test.example.com",
  "jira":   { "baseUrl": "https://yourorg.atlassian.net", "projectKey": "QA" },
  "gitlab": { "url": "https://gitlab.com", "projectId": "12345678" }
}
```

To move the tool to a **different** project later: edit `project.config.json` (or re-run
`npm run init`) and restart. No code changes, no scattered edits. Precedence, highest first:
**⚙ Settings modal** (per run) → **`.env`** (secrets/overrides) → **`project.config.json`**
(project identity) → built-in defaults.

> `project.config.json` carries **no secrets** and is git-ignored per deployment; only
> `project.config.example.json` ships in the repo/handoff zip.

---

## 1. Starting and stopping

```bash
npm start          # starts the server → open http://localhost:<port>
```

Platform shortcuts (double-clickable): **macOS** `start.command` / `stop.command`,
**Windows** `start.bat` / `stop.bat`. Or run `node server.js` directly. The port comes
from `project.config.json` (`port`, default `3000`).

> **Before zipping or backing up:** stop the server first (`stop.command` / `stop.bat`) —
> the SQLite database is held open while the server is running and cannot be archived
> while in use. Or just run `npm run package`, which excludes the live DB for you.

---

## 2. The header bar

| Control | What it does |
|---|---|
| **Project name** | From `project.config.json` (`appName`), or your Jira connection. |
| **AI Provider** | Active provider for all generation: Claude / OpenAI / Gemini / Copilot. Switch per run. |
| **Model** | Model within that provider. Defaults are fine; switch for faster or higher-quality output. |
| **📚 Reference Library** | Opens the knowledge panel: Rules, App Flow Map, Sources, Digital Twin. |
| **⚡ PerfForge** | Standalone performance testing engine. |
| **History** | Review previous generation runs. |

---

## 3. The 7-step workflow

Navigate steps using the top stepper or the left icon rail.

### Step 1 — Agents
The command centre. Click **▶ Run All Agents** to run the full pipeline (input parsing →
scenarios → test cases → optional Jira publish) in one shot.

Or run each stage manually using the step buttons below.

The "Requirements Quick-Run" box at the bottom lets you paste text and click
**Start Workflow →** to skip Step 2 for a fast single run.

### Step 2 — Collect Inputs
Feed requirements into the pipeline. Options:
- Paste plain text or user stories directly.
- Upload a Word / PDF document.
- Import from a Confluence URL (needs `CONFLUENCE_*` in `.env`).
- Type a generation title to organise runs in history.

### Step 3 — Scenarios
AI generates test scenarios grouped by module. Each scenario shows a TS-badge, status,
tags, and acceptance criteria.

- **Edit** any scenario before expanding to test cases.
- **Regenerate** if the quality isn't right — the Reference Library context improves output.
- Scenarios are **module-aware**: the App Flow Map for that module is automatically injected.

### Step 4 — Test Cases
AI expands each scenario into Jira-format test cases with numbered steps, expected results,
and `test_data`.

**Important — login goes in `test_data`, not in config:**
- Username/password login: add `username` and `password` to `test_data`.
- SingPass/CorpPass mock login: add `uin` (UIN only = SingPass; UIN + `uen` = CorpPass).
- No credentials → the Browser Agent pauses and waits for you to sign in manually.

Other actions:
- **Edit** steps inline.
- **Export CSV** — export all test cases for offline use.
- **Import** — bulk-add test cases from a file.
- **Automation** button on a TC row → jumps to Step 6 pre-filled.

### Step 5 — Jira Publisher
Push test cases to Jira. Checks:
- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` set in `.env`.
- Optionally `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET` for Xray-formatted test steps.

Actions:
- **Upload Test Cases** — creates Jira issues (plain card or Xray Test depending on config).
- **Create Bug** — pre-fills summary; attach screenshots.
- **Upload Test Results** — attach evidence files to a test execution.

### Step 6 — Playwright Automation
One panel, three modes. Connect your automation repo first: **Codebase Path → Connect**.

#### Automate a Test Case tab
1. Select a test case from the dropdown (or **Download from Jira** — fetches a Test
   Execution or Test Set from Jira by key).
2. Set the **Start URL** (pre-fills from `APP_BASE_URL`; edit if needed).
3. Edit the **AI instruction** if you want to guide the agent differently.
4. Choose your action:
   - **🎭 Record Script** — opens a headed Playwright recorder on the Start URL. Navigate
     the app manually; close the browser when done → recording saved.
   - **🤖 Agentic Automate** — the AI drives a headed browser through the test. It reads
     each TC step, fills forms, clicks, navigates, and on finish converts the session into
     your repo's page-object + spec format.

Per recorded script: **🛠 Convert** turns the raw recording into your repo's structure
(page object + spec + data file). This calls the AI and takes 30–90 seconds.

#### Free Prompt tab
Type any natural-language instruction and click **Run**. The agent drives the live browser
to complete it. Good for exploratory automation and one-off tasks.

#### Repo Scripts tab
Lists every spec file in your linked automation repo.
- **▶ Run** — executes the spec headed (visible browser, 1 worker, real fixtures).
- **⬆ Jira** — uploads the latest evidence PDF for that test to a Jira test execution.
- **Stop** — kills the running spec.
- **🗑 Clear Log** — clears the output feed.

---

## 4. Reference Library (📚)

The knowledge backbone for all AI generation. Open from the header.

### Rules tab
Project-specific generation guidance. Rules are injected into every scenario and test case
generation call. Add rules for things like "all negative TCs must include error message
verification" or module-specific conventions.

### App Flow Map tab
Ordered step-by-step flows per module. The Scenario and TC generators follow the **module-
matched** flow automatically (so generated TCs reflect actual app navigation).

Add flows manually, or record one via Digital Twin (see §5) — recording a module creates
its flow map entry automatically.

### Sources tab
- **Curated Notes** — free-text notes visible to all AI agents.
- **TC Library Upload** — upload reference test case documents; the AI uses them as examples.

### Digital Twin tab
A crawled, live model of your application (see §5).

---

## 5. Digital Twin

A structured, crawled model of your app that improves generation accuracy. Set it up once;
it persists across restarts.

1. Open 📚 **Reference Library → 🧬 Digital Twin**.
2. Fill in **Base URL** and login identity (UIN/UEN/UUID for mock login apps; leave blank
   for apps that use username/password in test data).
3. Optionally list known routes (one per line) or leave blank to auto-discover.
4. Click **Start Crawl** — progress streams live.

**Re-crawl** refreshes only auto-crawled pages; your manually recorded App Flows are kept.

**Guided Recording** (in the Crawl section): click **Start Recording**, navigate a module
manually, click **Stop Recording + Name Module** — this creates an App Flow Map entry for
that module automatically.

---

## 6. Downloading test cases from Jira

In Step 6 → Automate tab, click **⬇ Download from Jira** and enter a Jira **Test
Execution key** (e.g. `QA-123`) or **Test Set key**. The tool fetches all test cases from
that execution/set and loads them into the dropdown, with a search box for quick filtering.

---

## 7. Evidence upload

After running a repo spec, evidence PDFs are expected in:
```
<automation-repo>/Executionscreenshots/
```
(or wherever `EXECUTION_EVIDENCE_DIR` points in `.env`).

Click **⬆ Jira** next to the script. If the TC was downloaded from a Jira Test Execution,
the test key and execution key auto-fill. Otherwise you'll be prompted for the Jira test key.

---

## 8. Tips for good generation

| Tip | Why |
|---|---|
| Write module names consistently | The App Flow Map and twin context are module-matched; typos cause misses. |
| Add login to `test_data`, not `.env` | The tool works across projects — login is per TC, not global. |
| Connect your automation repo before Step 6 | The generator reads your repo's conventions (POM pattern, imports, fixtures) from the `PROMPT_FILE`. Without it, output is generic. |
| Seed the Rules tab | Even 3–4 project-specific rules significantly improve scenario quality. |
| Crawl the Digital Twin first | TCs generated after a crawl include real field names, routes, and API endpoints from your app. |
| Use Agentic Automate for happy paths | The agent handles multi-step flows well; for very complex conditional flows, Record + Convert gives you more control. |

---

## 9. Common issues

| Symptom | Fix |
|---|---|
| Header shows no project name | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` must be set in `.env`. |
| "No automation repo connected" | Set **Codebase Path → Connect** in Step 6, or set `AUTOMATION_REPO_PATH` in `.env`. |
| Agent stops before finishing | Check `AGENT_MAX_TURNS` in `.env` (default 30). Increase for very long flows. |
| Agent can't log in | The TC's `test_data` must have `username`/`password` or `uin`/`uen`. If missing, the agent waits for manual sign-in. |
| Record opens blank page | Set **Start URL** in the panel (the field above the Record button). It must be non-empty. |
| Repo script runs headlessly | The run forces headed mode; if your repo uses a custom launcher, check it reads `HEADED=1` or `HEADLESS=false`. |
| Convert is slow (30–90s) | Normal — it's one AI call generating a full POM + spec. The model used is set by `CONVERSION_MODEL` in `.env`. |
| Can't zip / "db in use" | Run `stop.bat` first, then zip. |
| Xray steps missing in Jira | `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET` must be set; without them, steps go in the card description. |

---

## 10. Quick reference — keyboard & UI shortcuts

| Action | How |
|---|---|
| Jump to a step | Click step number in top stepper or left icon rail |
| Open Reference Library | Click 📚 in header |
| Close Reference Library | Press `Esc` or click × |
| Clear agent / script output | Click 🗑 **Clear Log** button |
| Stop a running repo script | Click **■ Stop** in Repo Scripts tab |
| Search downloaded TCs | Type in the search box below the TC dropdown |

---

## 11. File locations

| Path | What |
|---|---|
| `.env` | All configuration — never committed to git |
| `data/alchemist.db` | Local SQLite (history, twin, flows) — never committed |
| `public/` | The single-page UI |
| `routes/`, `lib/`, `agents/` | Backend source |
| `<repo>/.github/CONVERSION_PROMPT.md` | Your project's script conversion conventions |
| `<repo>/Executionscreenshots/` | Evidence PDFs for Jira upload |
