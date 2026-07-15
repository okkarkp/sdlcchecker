# Test Alchemist — New Project Setup Guide

This guide onboards a **new project/application** onto Test Alchemist. The tool is
project-agnostic — nothing about the app under test is hardcoded — so setup is mostly
configuration: point it at your AI provider, your Jira, and (optionally) your Playwright
automation repo, then work through the pipeline.

> Test Alchemist runs **locally** on a team member's machine (Node + SQLite). It is not a
> hosted service. Each user runs their own instance.

---

## 0. Quick checklist

- [ ] Node.js 18+ and Google Chrome installed
- [ ] `npm install` run once
- [ ] `.env` created from `.env.example` and filled in
- [ ] One AI provider configured (Claude / OpenAI / Gemini / Copilot)
- [ ] `APP_BASE_URL` set to your application's URL
- [ ] Jira (and Xray, if used) connected
- [ ] Automation repo linked (for Playwright script generation/conversion)
- [ ] Login values live in each **test case's data**, not in config
- [ ] Server started (`start.bat`) → open http://localhost:3000

---

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 18+** | `node -v` to check. Install from https://nodejs.org |
| **Google Chrome** | Used for headed Browser Agent + codegen recording. Bundled Chromium is a fallback. |
| **Git** | To clone your automation repo (optional but recommended). |
| **Jira Cloud access** | An API token for test-case creation / import / evidence upload. |
| **Xray** (optional) | Only if your Jira project uses Xray for test management. |

---

## 2. Install & run

```bash
# from the Test Alchemist folder
npm install            # first run only (installs deps + Playwright)
npm run init           # guided setup: writes project.config.json + .env
```

> **Native module note:** `better-sqlite3` compiles a native binary during
> `npm install`. On most machines the prebuilt binary downloads automatically. On a
> locked-down machine (corporate policy, or npm configured to block install scripts —
> e.g. `ignore-scripts=true`), that step can be skipped and the server then fails at
> startup with *"Could not locate the bindings file" / "invalid ELF header"*. Fix with:
> ```bash
> npm rebuild better-sqlite3          # rebuild the native binary
> # if that is blocked by policy:
> npm install --foreground-scripts    # allow build scripts for this install
> ```
> Rebuilding needs C/C++ build tools: **Windows** → "Desktop development with C++"
> (Visual Studio Build Tools) or `npm i -g windows-build-tools`; **macOS** → `xcode-select
> --install`; **Linux** → `build-essential` + `python3`.

Start / stop — cross-platform:
```bash
npm start              # launches http://localhost:<port from project.config.json>
```
Platform shortcuts (double-clickable): **macOS** `start.command` / `stop.command`;
**Windows** `start.bat` / `stop.bat` (`start.bat 3005` for another port).
Or directly: `node server.js`.

> **Backups/zips:** stop the server first (`stop.bat`) — the SQLite DB is held open while
> running and will otherwise fail to zip ("in use by Node.js"). The DB lives in `data/` and
> is git-ignored.

---

## 3. Configure `.env`

Copy the template and fill it in:
```bash
cp .env.example .env
```

### 3.1 AI provider (required — pick at least one)
```
ANTHROPIC_API_KEY=…      # Claude
OPENAI_API_KEY=…         # ChatGPT
GEMINI_API_KEY=…         # Gemini
```
You can also use **Copilot** (configured in the app header). The active provider is chosen
in the header and is followed everywhere (generation, the Browser Agent, conversion).

### 3.2 Application under test (required)
```
APP_BASE_URL=https://your-app.example.com     # your project's app URL
CHROME_PATH=                                   # optional: path to real Chrome; else bundled Chromium
```

### 3.3 Jira / Xray
```
JIRA_BASE_URL=https://yourorg.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=…                 # https://id.atlassian.com/manage-profile/security/api-tokens
JIRA_PROJECT_KEY=ABC             # your project key
JIRA_TEST_ISSUE_TYPE=Test        # "Test" for plain Jira; "Test Case"/"Test" per your project

# Xray (only if your project uses it — else test cases are plain Jira cards with steps in the description)
XRAY_CLIENT_ID=…
XRAY_CLIENT_SECRET=…
JIRA_TEST_PATH=/Regression       # Xray repository folder
```
> The **project name in the app header** is read from this Jira connection — no hardcoding.

### 3.4 Automation repo (for Playwright script generation/conversion)
```
AUTOMATION_REPO_PATH=C:\path\to\your\playwright-repo
PAGE_OBJECTS_DIR=pages           # your page-objects folder
SPECS_DIR=tests                  # your specs folder
PROMPT_FILE=.github/CONVERSION_PROMPT.md   # your conversion conventions (see §6)
SEED_SPEC=seed.spec.js           # a spec every generated test is modeled on
LOGIN_PAGE=loginPage.js          # your login page-object (its selectors are reused)
```
You can also set the repo path per-session in the UI (Playwright panel → **Codebase Path → Connect**).

### 3.5 Optional
- **GitLab** (`GITLAB_*`) — pipeline trigger from Step 7.
- **Confluence** (`CONFLUENCE_*`) — import an FRD page as requirements context.
- **Figma** (`FIGMA_ACCESS_TOKEN`) — derive App Flow Maps from designs.
- **Digital Twin** (`TWIN_*`) — see §8.
- **Access control** — `ALLOWED_IPS` to restrict, `ALLOWED_ORIGIN` for CORS.

---

## 4. Login is per-project — driven by test data (important)

There are **no fixed login credentials**. Login for your app comes from **each test case's
own data**, so the same tool works across projects:

- **Username / password:** put `username` and `password` in the test case's `test_data`.
- **SingPass/CorpPass-style / SSO mock:** put `uin` (and `uen` for a corporate login) in
  `test_data`. UIN only ⇒ SingPass-style; UIN + UEN ⇒ CorpPass-style.
- **No credentials in the test case?** The Browser Agent pauses and asks the human to sign
  in in the headed browser, then resumes.

Every application's login page is different — the agent adapts to the page in front of it
and follows the test case's login steps. The `APP_USERNAME/PASSWORD/UIN/UEN` env vars are
**deprecated and ignored** (leave blank).

---

## 5. The workflow (Steps 1–7)

1. **Agents** — one-click "Run All Agents", or run each stage's node manually.
2. **Collect Inputs** — paste requirements, upload docs, or import a Confluence FRD.
3. **Scenarios** — AI generates test scenarios (grounded by your Reference Library + App Flow Map).
4. **Test Cases** — AI expands scenarios into Jira-format test cases with steps + data.
   Put login/values in each TC's `test_data` here (see §4).
5. **Jira Publisher** — bulk-create the test cases in Jira (Xray steps if configured, else
   plain cards).
6. **Playwright** — the unified **Playwright Automation** panel (see §7).
7. **Pipeline & Scheduler** — trigger a GitLab pipeline / schedule runs (optional).

Anywhere generation runs, it's grounded by the **Reference Library** (📚 in the header):
Rules, App Flow Map, Sources, and Digital Twin.

### 5.1 The agents (what runs behind the pipeline)

"Run All Agents" is an orchestrator ([agents/orchestrator.js](agents/orchestrator.js)) that
chains sub-agents and **skips any stage it can't run** (missing input/config):

```
inputs → scenarios → test cases → Playwright → pipeline → Jira
```

Each agent extends a small base class ([agents/base-agent.js](agents/base-agent.js)) that
handles the `idle → running → done/error` lifecycle and live status updates; the agent only
implements `execute()`. All agents follow the **AI provider chosen in the header**.

| Agent | Does | You need |
|---|---|---|
| 📥 **Input Parser** | Turns your docs/requirements into normalized inputs | requirements or files |
| 🎯 **Scenario Generator** | AI writes test scenarios (grounded by Reference Library/Twin) | parsed inputs |
| 📋 **Test Case Generator** | Expands scenarios into Jira-format test cases with steps + `test_data` | scenarios; **put login in `test_data`** (§4) |
| 🎭 **Playwright Generator** | Generates POM specs following your linked repo's conventions | test cases + linked repo (§3.4) |
| 🚀 **Pipeline Trigger** | Fires a GitLab pipeline | `GITLAB_*` config |
| 🎫 **Jira Integration** | Creates test-case issues + uploads evidence | `JIRA_*` (and `XRAY_*` if used) |
| 🔍 **Coverage Verifier** | Checks requirement coverage / test-type spread | scenarios + test cases |
| ⚡ **PerfForge** | Standalone load/perf engine | — (runs on its own) |

To add or change an agent, edit the matching file in `agents/sub-agents/` (see the README's
"Agents" section for the definition pattern).

---

## 6. Playwright Automation panel (Step 6)

One panel, three modes. Link your repo first (**Codebase Path → Connect**).

- **Automate a Test Case** — pick a TC (Step 4 "Automation" button, or download from a Jira
  Test Execution / Test Set). Set the **Start URL**, edit the **AI instruction** if needed, then:
  - **🎭 Record Script** — opens a recorder on the app; perform the steps, close the browser to save.
  - **🤖 Agentic Automate** — the AI drives a headed browser through the test; on finish it
    converts + saves into your repo.
- **Free Prompt** — type a natural-language instruction; the AI drives the live browser.
- **Repo Scripts** — lists every spec in your linked repo with one-click **▶ Run** (headed,
  in the repo's own config/fixtures) and **⬆ Jira** to upload evidence.

Per recorded script you also get **🛠 Convert** — turns the recording into your repo's
structure (page object + spec + `data/<Module>.xlsx`), merging by module.

### 6.1 Your repo's conversion conventions
Create `PROMPT_FILE` (default `.github/CONVERSION_PROMPT.md`) in your automation repo. It
tells the converter how your framework is structured (imports, POM pattern, how specs read
the Excel data file, fixtures, etc.). The converter also reuses your `LOGIN_PAGE` selectors
and models specs on `SEED_SPEC`. Result files:
- `${PAGE_OBJECTS_DIR}/<Module>Page.js`
- `${SPECS_DIR}/<Module>.spec.js`
- `data/<Module>.xlsx` (one row per test case; includes a `loginType` column: `SINGPASS`/`CORPPASS` when applicable)

### 6.2 Evidence upload to Jira
After a repo spec runs, per-test PDF evidence is expected in `<repo>/Executionscreenshots`.
**⬆ Jira** uploads the **latest PDF whose name matches the test-case name**. If the test was
downloaded from a Jira Test Execution, the test/execution keys auto-fill; otherwise you're
prompted for the Jira test key.
> To use a different evidence folder, set `EXECUTION_EVIDENCE_DIR` in `.env`.

---

## 7. Reference Library (grounding for better generation)

Open 📚 **Reference Library** in the header:
- **Rules** — project-specific generation rules/preferences.
- **App Flow Map** — ordered, per-module flows. Recording a module (Digital Twin) adds one
  automatically. Test-case generation follows the **module-matched** flow's steps.
- **Sources** — TC library uploads, Confluence import.
- **Digital Twin** — see §8.

---

## 8. Digital Twin (optional, recommended)

A crawled, structured model of your app that grounds generation. Reference Library →
🧬 **Digital Twin**:
1. Enter the app URL + login identity (UIN/UEN/UUID or leave blank for the config's own
   values) — the crawler logs in like the agent does.
2. Optionally list known routes, or leave blank to auto-discover.
3. **Start Crawl** — streams progress; builds a page/element/API model.
4. **Source Extraction** — paste Confluence/PPT/requirements to enrich the twin via AI.

Persistence: crawled pages and recorded App Flows survive restarts; a re-crawl only
refreshes auto-crawled pages (recordings are kept). CI/CD can trigger a re-crawl via
`POST /api/twin/webhook/deploy` with the `TWIN_WEBHOOK_SECRET` header.

---

## 9. Per-project checklist (copy for each new app)

```
Project: ____________________     Jira key: ______     App URL: __________________________

[ ] .env: AI key(s), APP_BASE_URL, JIRA_*, (XRAY_* if used)
[ ] Automation repo linked (path, PAGE_OBJECTS_DIR, SPECS_DIR, SEED_SPEC, LOGIN_PAGE)
[ ] .github/CONVERSION_PROMPT.md written for this repo's conventions
[ ] Test cases carry their own login in test_data (username/password or uin/uen)
[ ] Evidence folder confirmed: <repo>/Executionscreenshots  (or EXECUTION_EVIDENCE_DIR)
[ ] Reference Library: seed Rules / App Flow Map (optional)
[ ] Digital Twin crawled (optional)
```

---

## 10. Troubleshooting

| Symptom | Fix |
|---|---|
| Startup crash — "Could not locate the bindings file" / "invalid ELF header" (`better-sqlite3`) | Native binary wasn't built during install. Run `npm rebuild better-sqlite3` (or `npm install --foreground-scripts` if scripts are blocked). Needs C/C++ build tools — see §2. |
| Can't zip — "db in use by Node.js" | Stop the server (`stop.command` / `stop.bat`) first; the SQLite DB is held open while running. Or use `npm run package`, which excludes the live DB. |
| Header shows wrong/no project name | Set `appName` in `project.config.json`, or check `JIRA_*` — the name can also come from the Jira connection. |
| "No automation repo connected" on generate/convert | Set **Codebase Path → Connect** (or `AUTOMATION_REPO_PATH`). |
| Agent asks for manual login | The test case has no credentials — add `username/password` or `uin/uen` to its `test_data`. |
| Record opens a blank page | Set the **Start URL** in the panel (defaults from `APP_BASE_URL`); it opens there directly. |
| Repo script runs headless | Run forces headed; if your framework launches its own browser, it also reads `HEADED=1`/`HEADLESS=false`. |
| Convert is slow | It's one AI code-gen call (30–90s). Uses the faster `CONVERSION_MODEL` (Sonnet for Claude); an `ANTHROPIC_API_KEY` (API vs CLI) is faster. |
| Xray steps not appearing | Set `XRAY_CLIENT_ID` / `XRAY_CLIENT_SECRET`; without them, steps go in the Jira description. |

---

## 11. Where things live

| Path | What |
|---|---|
| `.env` | All configuration (git-ignored) |
| `data/alchemist.db` | Local SQLite (history, sessions, twin, flows) — git-ignored |
| `public/` | The single-page UI (`index.html`, `js/app.js`, `css/styles.css`) |
| `routes/`, `lib/`, `agents/` | Backend (API routes, agent + twin logic, generation agents) |
| `<automation-repo>/.github/CONVERSION_PROMPT.md` | Your repo's script conventions |
| `<automation-repo>/Executionscreenshots` | Per-test PDF evidence for Jira upload |

See `README.md` for architecture and `PLAYWRIGHT_AGENT_CONTEXT.md` for a deep dive on the
Browser Agent.
