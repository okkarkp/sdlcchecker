# ⚗️ Test Alchemist

> Turn requirements into gold-standard test cases — AI-powered, human-guided.

A standalone, self-hosted web application that drives an entire QA workflow: ingest
requirements from any source, generate test scenarios and test cases, publish to Jira,
produce Playwright automation, trigger CI pipelines, and run native performance tests —
all from a single browser UI backed by a local Node.js server.

Designed as a **local developer tool**: it runs on your own machine, talks directly to
your Jira / GitLab / Figma / Confluence accounts, and keeps all state in a local SQLite
database. (It can also be deployed to AWS — see [`aws/cloudfront-setup.md`](aws/cloudfront-setup.md).)

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                        Web UI (Single-Page App)                     │
│  Agents · Inputs · Scenarios · Test Cases · Jira · Playwright       │
│  Pipeline/Scheduler · PerfForge · Chat · Knowledge · App Map        │
└──────────────────────────┬─────────────────────────────────────────┘
                           │ REST + WebSocket (live progress)
┌──────────────────────────▼─────────────────────────────────────────┐
│                    Express Server (Node.js)                         │
│  providers/  Unified AI: Claude · OpenAI · Gemini · Copilot         │
│  agents/     Orchestrator + 8 sub-agents (end-to-end automation)    │
│  routes/     19 API modules (see API Surface below)                 │
│  lib/        SQLite, crawlers, Figma/Confluence parsers, PerfForge  │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
   Jira REST v3 · GitLab API · Figma API · Confluence Cloud · Playwright
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Guided setup — writes project.config.json (project identity) + .env (secrets):
#    app name, port, one AI key, app-under-test URL, optional Jira/GitLab.
#    Re-runnable; keeps what's already set. Point at another project anytime by
#    re-running this or editing project.config.json.
npm run init

# 3. Start the server
npm start          # production
npm run dev        # with nodemon (auto-reload)

# Open → http://localhost:3000
```

Prefer manual setup? Copy [`project.config.example.json`](project.config.example.json) →
`project.config.json` (project identity) and `.env.example` → `.env` (secrets), then edit.

**Project-agnostic:** one copy of the tool targets any project. Which project a deployment
serves is defined by a single declarative [`project.config.json`](project.config.example.json)
(app name, base URL, Jira/GitLab identity) — no secrets, git-ignored per deployment. Point at
another project by editing that file (or re-running `npm run init`) and restarting. Config
precedence, highest first: **⚙ Settings modal** → **`.env`** → **`project.config.json`** →
built-in defaults.

On macOS you can also use [`start.command`](start.command) / [`stop.command`](stop.command)
(double-clickable in Finder); on Windows, [`start.bat`](start.bat) / [`stop.bat`](stop.bat).

Everything can also be configured live in the **⚙ Settings** modal without restarting —
API keys, model selection, and integration credentials are passed per-request.

## Environment Variables

All variables are optional; set only the integrations you use. See [`.env.example`](.env.example).

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (Anthropic) |
| `OPENAI_API_KEY` | OpenAI API key (ChatGPT) |
| `GEMINI_API_KEY` | Google Gemini API key |
| `PORT` | Server port (default `3000`) |
| `APP_NAME` | Display name (default `Test Alchemist`) |
| `GITLAB_URL` | GitLab instance (default `https://gitlab.com`) |
| `GITLAB_TOKEN` | Personal Access Token (`api` scope) — used for codebase reads |
| `GITLAB_PROJECT_ID` | Numeric project ID |
| `GITLAB_TRIGGER_TOKEN` | Pipeline trigger token (CI/CD → Triggers) |
| `GITLAB_DEFAULT_BRANCH` | Branch to trigger pipelines on (default `main`) |
| `JIRA_BASE_URL` | e.g. `https://yourorg.atlassian.net` |
| `JIRA_EMAIL` | Jira Cloud email |
| `JIRA_API_TOKEN` | Atlassian API token |
| `JIRA_PROJECT_KEY` | Default project key (e.g. `QA`) |
| `JIRA_TEST_ISSUE_TYPE` | Xray/Zephyr test issue type (e.g. `Test`) |
| `FIGMA_ACCESS_TOKEN` | Figma personal access token (for design ingestion) |
| `ALLOWED_IPS` | Comma-separated IP whitelist (also `ip-whitelist.txt`); empty = open |
| `ALLOWED_ORIGIN` | CORS origin (default `*`) |

## Multi-Provider AI

Test Alchemist is **not tied to a single LLM**. Every generation call routes through
[`providers/index.js`](providers/index.js), which auto-detects the provider from the
selected model and dispatches accordingly:

| Provider | Example models |
|---|---|
| **Claude** (Anthropic) | Opus 4.7, Sonnet 4.6, Haiku 4.5 |
| **OpenAI** | GPT-4o, GPT-4o Mini, o3-mini, o1-preview |
| **Gemini** (Google) | 2.0 Flash, 2.0 Flash Thinking, 1.5 Pro/Flash |
| **Copilot** | Claude / GPT / Gemini via Copilot proxy |

A local **Claude CLI** path is also supported for keyless operation where the CLI is
installed. Image-aware prompts (`callAIWithImages`) are used for Figma/design analysis.

---

## The Workflow

The UI is organised as a guided stepper. The first four steps are the core pipeline;
the rest are optional and can be run independently.

### 1 — 🤖 Agents
Run the full pipeline autonomously. The **Orchestrator**
([`agents/orchestrator.js`](agents/orchestrator.js)) chains the sub-agents
end-to-end (inputs → scenarios → test cases → Playwright → pipeline → Jira), emitting
live progress over WebSocket. Each sub-agent can also be invoked on its own.

### 2 — 📥 Collect Inputs
Upload any combination of:
- **PDF** — BRDs, PRDs, specifications
- **Excel / CSV** — requirements / test matrices
- **Word (.docx)** — functional specs, user stories
- **Plain text / Markdown** — user stories, rules
- **Figma** — design files via URL or uploaded export JSON/images
- **Confluence** — fetch pages and import as knowledge
- **Codebase** — pull file trees and source from a GitLab repo for context

Paste user stories, requirements, or business rules directly into the text tabs.

### 3 — 🎯 Test Scenarios
AI analyses all inputs and generates structured scenarios grouped by module, tagged
with priority and type (functional, regression, e2e, negative…). Filter, review, export
as JSON, or regenerate. Generations are persisted in history.

### 4 — 📋 Test Cases (Jira-ready)
Each scenario is expanded into detailed, automation-ready test cases with atomic numbered
steps, expected results, test-data placeholders, automation selector hints, and Jira
field mappings. Export as Jira CSV or publish via API.

### 5 — 🏷️ Jira Publisher *(optional)*
Bulk-upload test cases as Jira Test issues, auto-create Bug tickets for failed tests,
and attach result JSON to any issue key. Supports Xray/Zephyr test issue types.

### 6 — 🎭 Playwright *(optional)*
Convert test cases into a full **Page Object Model** Playwright project: `pages/` POM
classes, `tests/` spec files, `playwright.config.ts` (multi-browser), and shared fixtures.
Download as ZIP or save to the repo. A standalone **script library** (`pw-scripts`) can
also record scripts live via `playwright codegen` and run them on demand.

### 7 — 🚀 Pipeline & Scheduler *(optional)*
Trigger GitLab pipelines with optional variables and monitor status. The built-in
**scheduler** (node-cron) can run pipelines or generations on a recurring schedule.

### ⚡ PerfForge *(optional)*
A native performance-testing module ([`lib/perfforge/`](lib/perfforge/index.js)):
- **Load engine** — async HTTP load with concurrency, ramp-up, think-time, multi-step
  scenarios with `${var}` extraction, and live percentile snapshots streamed over WebSocket.
- **AI explorer** — drives Playwright to crawl an app, capture page/API timings, flag
  issues, and auto-build a load-test config. Runs heuristically (no key) or as an
  agentic Claude-driven loop.

### 💬 Always-on assistants
- **Chat** — a context-aware assistant that sees your current inputs, scenarios, app map,
  and Figma context.
- **Knowledge base** — a persistent, per-client store of approved facts/standards that
  enrich every generation (importable from Confluence).
- **App Map** — crawl a live application (or ingest Figma) to record pages, elements, and
  flows used as grounding context.

---

## Agents

### How an agent is defined
Every agent extends [`agents/base-agent.js`](agents/base-agent.js): the base class owns the
status lifecycle (`idle → running → done/error`) and WebSocket broadcasting, and calls the
subclass's `execute()`. A concrete agent just declares its identity and implements `execute`:

```js
class ScenarioGenAgent extends BaseAgent {
  constructor() { super('scenario-gen', 'Scenario Generator', 'Generates test scenarios…', '🎯'); }
  async execute({ inputs, applicationName, applicationContext }, opts) {
    // build prompt → callAI(...) → return { scenarios, count }
  }
}
module.exports = new ScenarioGenAgent();   // singleton
```

- `run()` (base) wraps `execute()`, emitting `agent_status` so the UI nodes update live.
- `opts` carries the active **AI provider** (chosen in the header), so all agents use it.
- AI agents build a prompt and call `callAI(...)`; integration agents (Jira, pipeline) call REST APIs.

### The orchestrator
[`agents/orchestrator.js`](agents/orchestrator.js) powers **Run All Agents**. It chains the
sub-agents and **skips any stage it can't run** (missing input/config), feeding each stage's
output into the next:

```
inputs → scenarios → test cases → Playwright → pipeline → Jira
```

### The sub-agents

| Agent (`id`) | Icon | Responsibility | In → Out |
|---|---|---|---|
| Input Parser (`input-parser`) | 📥 | Parse PDF/Excel/Word/PPTX/CSV/text + user story into normalized inputs | files/requirements → `inputs[]` |
| Scenario Generator (`scenario-gen`) | 🎯 | AI generates test scenarios (grounded by Reference Library + App Flow Map + Digital Twin) | `inputs[]` → `scenarios[]` |
| Test Case Generator (`testcase-gen`) | 📋 | AI expands scenarios into Jira-format test cases with steps + `test_data`; injects the module-matched App Flow | `scenarios[]` → `testcases[]` |
| Playwright Generator (`playwright-gen`) | 🎭 | Generate POM-pattern specs following the linked repo's conventions | `testcases[]` → spec/page files |
| Pipeline Trigger (`pipeline`) | 🚀 | Trigger a GitLab CI/CD pipeline via trigger token | config → pipeline id/status |
| Jira Integration (`jira`) | 🎫 | Create test-case issues (Xray steps or plain cards) and upload results/evidence | `testcases[]` → Jira issues |
| Coverage Verifier (`verify`) | 🔍 | Cross-check requirement coverage and test-type distribution | inputs+scenarios+testcases → coverage report |
| PerfForge (`perfforge`) | ⚡ | Standalone load/performance engine + AI performance explorer | prompt/config → perf run |

**Standalone agents** (Playwright Builder, PerfForge) run independently of the first three.
Note: some individual UI steps (e.g. Step 4's `/generate-testcases`) run a batched/parallel
version of the same logic in [`routes/ai.js`](routes/ai.js) for speed + progress streaming;
the intent matches the corresponding agent.

---

## Quality Guardrails

Generations are grounded to reduce hallucination and drift:
- [`lib/hallucination-guard.js`](lib/hallucination-guard.js) — anti-hallucination prompt
  injection plus post-generation structural validation.
- [`lib/testing-standards.js`](lib/testing-standards.js) — a mandatory coverage checklist
  injected into every prompt (`data/testing-standards.json`).
- [`lib/reference-library.js`](lib/reference-library.js) + [`lib/auto-reference.js`](lib/auto-reference.js)
  — persist the AI's understanding of the existing suite (auto-loaded on startup from
  `data/reference-source/`) so output stays consistent and non-duplicate.

## API Surface

All routes are mounted under `/api/*` in [`server.js`](server.js):

| Route | Purpose |
|---|---|
| `ai` | Parse inputs → scenarios → test cases → Playwright generation |
| `agents` | Orchestrator + individual sub-agent runs |
| `gitlab` | Pipeline trigger / status / jobs |
| `jira` | Bulk TC upload, bug creation, attachments |
| `playwright` | ZIP download + local save of generated projects |
| `pw-scripts` | Standalone Playwright script library (codegen + run) |
| `browser-agent` | Claude CLI + Playwright MCP browser automation |
| `perfforge` | Load engine + AI performance explorer |
| `scheduler` | node-cron scheduled pipelines/generations |
| `flows` | Figma-derived flows and design ingestion |
| `confluence` | Fetch/search Confluence pages, import as knowledge |
| `codebase` | Browse/search a GitLab repo for context |
| `app-map` | Crawl a live app or ingest Figma into an app map |
| `twin` | Digital Twin — crawl/extract/query a structured app model |
| `chat` | Context-aware chat assistant |
| `knowledge` | Per-client knowledge base CRUD + approval |
| `history` | Persisted generations, scenarios, test cases |
| `session` | Save/restore per-client session state |
| `config` | Non-secret `.env` defaults for the frontend |
| `health` | Health check |

## Digital Twin Setup

The **Digital Twin** builds a structured, queryable model of the target application and
uses it as *grounded context* for every scenario/test-case generation — so the AI
references real pages, fields, validations and APIs instead of inventing them.

It has three layers: **static structure** (DOM element registry, route graph, API
contracts), **behavioural model** (state transitions, validation rules, role variants),
and **semantic context** (business rules, personas, requirement traceability).

### Where it lives

| Piece | File |
|---|---|
| Schema (8 `twin_*` tables) | [`lib/db.js`](lib/db.js) |
| Authenticated Playwright crawler | [`lib/twin/crawler.js`](lib/twin/crawler.js) |
| LLM extraction (docs → structured) | [`lib/twin/extractor.js`](lib/twin/extractor.js) |
| Context assembler + prompt block | [`lib/twin/context.js`](lib/twin/context.js) |
| HTTP API | [`routes/twin.js`](routes/twin.js) |
| UI | Reference Library → **🧬 Digital Twin** tab |

The crawler reuses the Browser Agent's login (deep-DOM walk, shadow-root aware), so an
authenticated Angular/MFE app crawls the same way the agent drives it.

### Step-by-step

1. **Open the tab** — header → 📚 Reference Library → **🧬 Digital Twin**.
2. **Configure the crawl** (Section B — Crawl Config):
   - **Base URL** (required) — e.g. `https://your-app.example.com`.
   - **Login route** — leave blank to use the base URL.
   - **Login identity** — enter `UIN` / `UEN` / `UUID` for SSO mock login, or leave blank
     for apps using username/password (add those to test case `test_data` instead).
     Credentials are never logged; stored in the local SQLite DB.
   - **Known routes** — one per line. Leave blank to **auto-discover** by BFS from the
     base URL (follows internal links, depth 4, excludes logout/external/downloads).
   - **Save Config** persists it (sensitive values are masked when read back).
3. **Start Crawl** — progress streams live into the feed (routes visited, elements found,
   APIs captured). On completion the Twin Status strip and Explorer refresh.
4. **Explore** (Section C) — click any route to see its full context: elements (with
   locators), business rules, validation rules, transitions, API contracts, neighbours.
4b. **Or record a module yourself** (Section B2 — Record a Module) — when you'd rather
   capture one flow exactly, give it a **Module name** (optional) and an optional
   **Start route**, then **Start Recording**. The crawler logs in and hands you the
   browser — navigate the module start-to-end manually. Every page you land on is
   captured (elements + APIs), tagged with the module name, and the path between them
   is saved as transitions. Click **Stop Recording** (or just close the browser) when
   done. This is additive — it enriches the twin without wiping existing pages, and the
   module name then drives the generation match (Section "Generate" below). Recorded
   pages show a 🧩 module badge in the Explorer. The walked path is **also added to the
   App Flow Map tab automatically** as a flow named after the module (one step per page,
   `source: twin-recording`), so you get a visual flow without drawing it by hand.
5. **Enrich from docs** (Section D — Source Extraction) — paste a Confluence HTML export,
   PPT text, or requirement doc and **Extract & Merge**. The AI pulls business rules,
   personas, acceptance criteria and flow steps, then merges them into the twin (matched
   to crawled routes by fuzzy name). Uses whichever AI provider is selected in the header.
6. **Generate** — scenario and test-case generation automatically inject the twin context
   for the matched module/route. No match → generation proceeds unguided (zero-risk).

### Persistence

The twin and recorded App Flows live in the SQLite DB (`data/alchemist.db`, WAL mode,
durable writes) — they **survive server restarts**. Data is only removed when you
explicitly act:

- **Reset Twin** button — wipes all twin pages/elements/rules/APIs (does *not* delete
  recorded App Flows; those have their own delete in the Flow Map tab).
- **Re-crawl / Start Crawl** — refreshes only auto-crawled pages (`source: crawler`).
  Pages you captured via **Record a Module** (`source: guided`) and their App Flows are
  **kept**, so a re-crawl never destroys your manual recordings.
- Deleting a flow in the **App Flow Map** tab — removes that flow only.

### Keeping it current (Section E — Sync Settings)

- **Webhook secret** — set a shared secret, then have CI/CD re-crawl post-deploy:
  ```bash
  curl -X POST http://localhost:3000/api/twin/webhook/deploy \
    -H "X-Webhook-Secret: <secret>"
  ```
  Returns `202 Accepted` immediately and runs the crawl in the background.
  (The secret may also be set via the `TWIN_WEBHOOK_SECRET` env var.)
- **Auto re-crawl on deploy** toggle and an **every-N-hours** field are saved with the config.

### API quick reference

| Method · Route | Purpose |
|---|---|
| `POST /api/twin/crawl` | Start a crawl (auto BFS, or `mode:"guided"` + `moduleName` to record); streams via WebSocket |
| `POST /api/twin/stop` | Finish a running guided recording and persist captured pages |
| `GET  /api/twin/status` | Twin summary (routes/elements/apis/last-crawled) |
| `GET  /api/twin/pages` | List crawled routes with counts |
| `GET  /api/twin/pages/:route` | Full context object for a route (URL-encode the route) |
| `POST /api/twin/extract` | Extract a document and merge into the twin |
| `POST/GET /api/twin/config` | Save / read crawl config (passwords masked on read) |
| `POST /api/twin/reset` | Soft-delete all twin rows |
| `POST /api/twin/webhook/deploy` | CI/CD trigger (validates `X-Webhook-Secret`) |

### Optional env vars

```bash
TWIN_WEBHOOK_SECRET=    # CI/CD webhook secret (or set it in the UI)
TWIN_MAX_DEPTH=5        # auto-discovery BFS depth
TWIN_MAX_ROUTES=200     # safety cap on routes per crawl
TWIN_PAGE_TIMEOUT=25000 # per-page navigation timeout (ms)
TWIN_API_WAIT_MS=3000   # how long to observe XHR/fetch per page (ms)
TWIN_MAX_CLICKS=40      # max nav elements clicked per page (SPA route discovery)
TWIN_BUDGET_MS=900000   # overall crawl wall-clock budget (ms, default 15 min)
```

> **SPA crawling.** The app's navigation is router/button-driven (Angular MFE), not
> `<a href>`. The crawler therefore **clicks** navigation-intent elements (nav/sidebar/
> tabs/`role=link`/`role=menuitem`) to discover routes, follows hash routes (`#/path`),
> and re-logs-in automatically if a click bounces it to the login page. Destructive
> labels (logout, delete, submit, pay, save, confirm…) are never clicked. Same-route
> interactions (tabs, accordions, lazy loads) are captured so each module records the
> full set of APIs it actually calls. If discovery still misses a deep flow, list those
> routes explicitly in **Known routes**.

## Project Structure

```
test-alchemist/
├── server.js                  # Express + WebSocket server, IP guard, route mounts
├── providers/index.js         # Unified multi-provider AI interface
├── agents/
│   ├── orchestrator.js        # Chains sub-agents end-to-end
│   └── sub-agents/            # input-parser, scenario-gen, testcase-gen,
│                              #   playwright-gen, pipeline, jira, verify, perfforge
├── routes/                    # 19 Express route modules (see API Surface)
├── lib/
│   ├── db.js                  # SQLite (better-sqlite3) persistence
│   ├── app-crawler.js         # Live-app flow recorder
│   ├── figma-parser.js        # Figma export → app structure
│   ├── hallucination-guard.js # Anti-hallucination prompt + validation
│   ├── testing-standards.js   # Mandatory coverage checklist
│   ├── reference-library.js   # Persisted suite understanding
│   ├── session-store.js       # Per-client session files
│   ├── twin/                  # Digital Twin: crawler, extractor, context assembler
│   └── perfforge/             # Load engine + AI explorer
├── parsers/index.js           # PDF / Excel / Word / CSV parsers
├── public/
│   ├── index.html             # Single-page application
│   ├── css/                   # styles.css, perfforge.css
│   └── js/                    # app.js, perfforge.js, exec-pane.js
├── playwright-tests/          # POM base, fixtures, config + generated tests
├── scripts/                   # S3/EB build & deploy, DB & deploy checks
├── aws/                       # CloudFront + S3 deployment guide & policy
├── data/                      # SQLite DB, sessions, schedules, reference source
├── templates/                 # jira-testcase-template.json
└── Dockerfile                 # Container build
```

## Running Playwright Tests

```bash
# Install browsers (first time only)
npm run install:playwright

npm test               # run all generated tests
npm run test:headed    # run headed (see browser)
npm run test:report    # view HTML report
```

## Deployment

Two models — **local per-user** (recommended) or a **central shared instance** when
local install isn't possible. Full guide: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

```bash
# Local (Node)                     # Local or central (Docker)
npm install                        docker compose up -d
npm run init                       #  → http://localhost:3000
npm start                          #  (SQLite persists in ./data)
```

> ⚠ The app has **no user login** (only an IP allowlist, open by default). Before
> exposing a central instance, restrict `ALLOWED_IPS` or put it behind a VPN/SSO — see
> [DEPLOYMENT.md](DEPLOYMENT.md) § Central.

### Reuse on a new project (handoff asset)

Test Alchemist is designed to be stood up fresh per engagement. Build a clean,
shareable zip — source + `.env.example`, **without** secrets, `data/`, or `node_modules`:

```bash
npm run package        # -> test-alchemist-handoff.zip (cross-platform: Mac/Win/Linux)
```

The recipient then runs: `npm install` → `npm run init` → `npm start`. Each deployment
keeps its own local SQLite DB, so projects stay isolated.

> Windows-only alternative: [`scripts/make-handoff-zip.ps1`](scripts/make-handoff-zip.ps1)
> (superseded by `npm run package`, which runs everywhere).

### Other targets

- **Docker** — [`Dockerfile`](Dockerfile) + [`docker-compose.yml`](docker-compose.yml)
  (Chromium bundled for the browser agent; `./data` volume for persistence).
- **AWS (S3 + CloudFront + Elastic Beanstalk)** — helper scripts in `scripts/`
  (`build:s3`, `upload:s3`, `package:eb`, `check:deploy`) and the setup guide in
  [`aws/cloudfront-setup.md`](aws/cloudfront-setup.md). Mind the guardrails in
  [DEPLOYMENT.md](DEPLOYMENT.md) § Central (no auth, persistence, reachability).

### GitLab CI Integration

Add this to your `.gitlab-ci.yml` to run the generated tests:

```yaml
playwright:
  image: mcr.microsoft.com/playwright:v1.40.0-jammy
  stage: test
  script:
    - cd playwright-tests
    - npm ci
    - npx playwright test
  artifacts:
    when: always
    paths:
      - playwright-report/
      - test-results/
    reports:
      junit: test-results/junit.xml
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| AI generation | Claude · OpenAI · Gemini · Copilot (unified provider) |
| Backend | Node.js + Express |
| Frontend | Vanilla JS + CSS (no framework) |
| Persistence | SQLite (better-sqlite3) + JSON session files |
| File parsing | pdf-parse, pdf-to-img, xlsx, mammoth |
| Real-time | WebSocket (ws) |
| Test automation | Playwright + TypeScript |
| Performance | PerfForge native load engine + Playwright explorer |
| Scheduling | node-cron |
| Integrations | Jira (REST v3), GitLab, Figma, Confluence |
| CI/CD | GitLab Pipelines |
| Deployment | Docker, AWS S3 + CloudFront + Elastic Beanstalk |
```
