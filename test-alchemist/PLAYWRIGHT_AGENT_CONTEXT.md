# Playwright Agent — Context for Claude

Paste this into a Claude chat (or keep it as a project reference) before asking for help with
the **Automate / Browser Agent** or the **Playwright script generation** in Test Alchemist.
It explains how the agent works, the app it drives, the conventions it must follow, and the
known constraints — so answers are grounded in how the system actually behaves.

---

## 1. What it is

Test Alchemist is a Node.js / Express + SQLite app that turns requirements → scenarios →
test cases → Playwright scripts, with a live **Automate (Browser) Agent** that executes a
test case in a real browser and converts the run into repo-structured Playwright scripts.

The Browser Agent is **provider-agnostic** and runs **Playwright in-process** (headed). It is
NOT the Claude CLI and NOT the Python `browser-use` library — it follows the AI provider
selected in the app header (Copilot / OpenAI / Gemini / Claude API). Design concepts are
ported from `browser-use` (see §3), but it stays in Node so there is no Python dependency
and credentials/provider follow the header.

Primary file: `lib/browser-agent.js`. Routes: `routes/browser-agent.js`
(`POST /api/browser-agent/automate` and `/execute`).

---

## 2. The agent loop (observe → plan → act)

Each turn:
1. **Observe** — capture URL, title, and a **shadow-DOM-aware** indexed list of visible
   interactive elements, each tagged `data-agent-idx` and reported WITH state
   (`value="…"`, `disabled`, `checked`).
2. **Plan** — send observation + task + recent history to the active provider. The model
   returns a **batch of actions** (browser-use style) as strict JSON.
3. **Act** — execute the batch in sequence (indices re-tagged shadow-aware before each
   action), **stopping early when the page navigates**, then re-observe.
4. Repeat until the model sets `done: true`, or `AGENT_MAX_TURNS` is hit, or the user stops.

Multi-action batching (e.g. fill all fields + click submit in one turn) is the main speed
lever — far fewer LLM round-trips than one-action-per-turn.

### Decision JSON schema
```json
{
  "evaluation": "Did my PREVIOUS action work? Success / Failure / Uncertain + why",
  "memory": "progress notes (which step, what's done/left)",
  "thought": "what I see now and what I'll do next",
  "actions": [
    { "type": "fill",  "index": 4, "value": "S1234567A" },
    { "type": "fill",  "index": 6, "value": "201912345A" },
    { "type": "click", "index": 8 }
  ],
  "done": false,
  "success": true,
  "summary": "when done: what happened / why finished"
}
```
Action types: `navigate` (needs `url`), `click` (`index`), `fill` (`index`+`value`),
`press` (`value`=key), `select` (`index`+`value`), `scroll`, `wait`, `request_login`.
Legacy single-`action` and `fill_form` shapes are still accepted and coerced.

---

## 3. Element detection (browser-use concepts, in Node)

`observe()` walks the DOM **including open shadow roots** (the target app is an Angular MFE
that renders forms inside shadow DOM — a plain `document.querySelectorAll` misses them).

An element is treated as interactive if it is: a known tag (`a, button, input, select,
textarea, summary, details, option`), has an interactive ARIA `role`, has `onclick` /
`tabindex` / `contenteditable`, **or is the outermost `cursor:pointer` element** in a chain
(so clickable `<div>`/`<li>`/cards/tiles are seen — this was the main reason navigation used
to stall). Capped at `MAX_ELEMENTS` (60).

Self-correction & change awareness (also from browser-use):
- The model self-evaluates the previous action each turn (`evaluation` field) and must not
  blindly repeat a failed action.
- Elements that appeared since the last action (same URL) are marked `*NEW*` so the model
  interacts with dropdowns/autocomplete/modals it just triggered.

---

## 4. Login handling — two-stage login apps

Target app URL is set via `APP_BASE_URL` in `.env` (e.g. `https://your-app.example.com`).
Some apps have **two login stages**, handled deterministically BEFORE the model acts (so
login never burns LLM turns):

**Stage 1 — standard username/password page.** Credentials come from the test case's own
`test_data` (`username` / `password`). The `.env` `APP_USERNAME` / `APP_PASSWORD` vars are
deprecated — leave them blank; login is per test case.
- The agent **prefers the connected automation repo's OWN login selectors** (extracted from
  the repo's `loginPage` page-object: `page.locator('#id')`, `getByRole('button',{name})`,
  `getByLabel`, `getByPlaceholder`, `getByTestId`, raw `#id`/`[name=…]`). It classifies each
  as user/password/submit, fills + submits, then verifies it left the login page.
- Falls back to a heuristic deep-DOM auto-login if the repo selectors don't resolve.

**Stage 2 — SingPass / CorpPass MOCK** (test-environment mock, no password):
- The agent fills the identity field(s) from test data: **UIN/NRIC/FIN** (and **UEN** for
  CorpPass). UIN only ⇒ SingPass; UIN + UEN ⇒ CorpPass.
- If a chooser appears, it clicks the **MANUAL / "Password login" / "Singpass ID"** option
  (type a NRIC/UIN) and explicitly **avoids** "Scan QR" / "Singpass app" / mobile / biometric
  — those are the REAL device flow, not the mock.
- Any **UUID / GUID / correlation-id** field is auto-filled with `TEST_UUID` (or a generated
  v4). The model never types a UUID.

Identity sources: test case `test_data` (`singpass_uin`/`uin`/`nric`/`uen`), patterns in the
steps text, or `.env` `APP_UIN` / `APP_UEN`. If no identity value exists, the agent uses
`request_login` to let a human complete it in the headed browser.

Negative tests: a "not authorised / access denied / restricted" page is treated as **PASS**
when the step's expected result says the user should be blocked.

---

## 5. Visual highlighting (live, in the headed browser)

Like `browser-use`, the agent draws color-coded **dashed boxes + index labels** over every
interactive element each turn, and a **flash pulse** on the element being acted on
(red = click, teal = fill/type). Colors: button=red, input=teal, select=blue, link=green,
textarea=orange, other=purple. Overlay is `pointer-events:none` and excluded from the agent's
own element scan. Toggle with `AGENT_HIGHLIGHT=0`.

---

## 6. Recording → repo-structured Playwright scripts

After a run, `convertRecordingToRepoScripts()` converts the recorded actions into the
connected repo's structure, **merging per MODULE** so multiple test cases accumulate in the
same files:
- Page object: `<pagesDir>/<Module>Page.js`
- Spec:        `<specsDir>/<Module>.spec.js`
- Data:        `data/<Module>.xlsx` (one row per `TestCaseName`)

Rules the conversion follows:
- Reuse the repo's existing login page-object/method — do not hand-roll login selectors.
- Emit the login steps explicitly (the live run was auto-logged-in by the harness, so the
  recording doesn't contain them).
- Each Jira/Xray step `action` → navigation; each step `expected_result` → a Playwright
  assertion. Negative tests assert the error/denied message is shown.
- Data row always carries `TestCaseName`, `Username`, `Password`, `UIN` (when used), and a
  camelCase `loginType` column whose value is `SINGPASS` or `CORPPASS` (derived from login
  steps: UIN only = SINGPASS, UIN+UEN = CORPPASS).
- Conversion runs on a faster model (`CONVERSION_MODEL`, defaults to `claude-sonnet-4-6` for
  Claude) using a lean repo context (prompt file + seed + login page).

Repo conventions come from (configurable, see §8): the repo's `PROMPT_FILE`
(e.g. `.github/CONVERSION_PROMPT.md`), `SEED_SPEC`, `LOGIN_PAGE`, `PAGE_OBJECTS_DIR`,
`SPECS_DIR`. The page-objects dir is auto-detected if not configured.

---

## 7. App Flow Map & Digital Twin → generation context

- **App Flow Map** (`app_flow` table, per client): ordered, human-readable step sequences per
  module. The **recording a module** feature auto-creates a flow named after the module.
  Test-case generation (`generateTcBatch` in `routes/ai.js`) injects the **module-matched**
  flow as the authoritative step sequence: a flow is included only when its module matches
  the scenario's module (exact match preferred; no unrelated flows are dumped). The TC steps
  for that module must follow the flow's order.
- **Digital Twin** (`twin_*` tables): a crawled/structured model of the app (DOM registry,
  routes, API contracts, rules). `lib/twin/context.js#twinPromptForHint(module)` injects a
  grounded context block for the matched route into generation. Recorded/guided twin pages
  and App Flows persist across restarts and are only removed by explicit user actions
  (Reset Twin / delete flow); an auto re-crawl refreshes only `source='crawler'` pages.

---

## 8. Configuration (`.env`)

```
APP_BASE_URL=https://your-app.example.com
APP_USERNAME=                # deprecated — leave blank; login comes from test case test_data
APP_PASSWORD=                # deprecated — leave blank
APP_UIN=                 # SingPass/CorpPass mock identity (fallback)
APP_UEN=                 # set for CorpPass
TEST_UUID=               # UUID for UUID fields ("generate" = fresh v4 each run)

AGENT_MAX_TURNS=30       # max plan/act turns
AGENT_MAX_ACTIONS=8      # max actions per turn (batch)
AGENT_HIGHLIGHT=1        # 0 to disable the visual overlay
CHROME_PATH=             # real Chrome path; else bundled Chromium

CONVERSION_MODEL=        # model for recording→script conversion (default Sonnet for Claude)

# Automation repo (conventions the agent + Step 6 generation follow). Usually set per-run
# from the UI (Codebase Path), or here:
AUTOMATION_REPO_PATH=
PAGE_OBJECTS_DIR=pages
SPECS_DIR=tests
PROMPT_FILE=.github/CONVERSION_PROMPT.md
SEED_SPEC=seed.spec.js
LOGIN_PAGE=loginPage.js
```

The repo path can be passed per request (`repoPath` in the body) for both the Automate flow
and Step 6 Playwright generation — both call `repoCtx.setRepoPath()` so scripts follow the
repo's conventions instead of a generic fallback.

---

## 9. Key files

| File | Role |
|---|---|
| `lib/browser-agent.js` | The agentic Browser Agent (loop, login fast-paths, highlighting, recording→conversion) |
| `routes/browser-agent.js` | `/api/browser-agent/automate` + `/execute` |
| `lib/repo-context.js` | Reads repo conventions; `getLoginHints()` extracts the repo's login selectors |
| `agents/sub-agents/playwright-gen.js` & `routes/ai.js` | Step 6 Playwright generation (uses repo context when connected) |
| `lib/twin/*` & `routes/twin.js` | Digital Twin crawler / extractor / context / API |
| `routes/flows.js`, `app_flow` table | App Flow Map storage + API |

---

## 10. Known constraints / gotchas

- **Shadow DOM is mandatory.** Any element logic must pierce open shadow roots (`deep()`),
  or the Angular-MFE login/mock forms are invisible.
- The **mock SP/CP** is reached via the manual/password/Singpass-ID option, never QR/app.
  If labels differ in your environment, the manual/avoid regexes in `browser-agent.js`
  (`MANUAL_LOGIN_RE` / `AVOID_LOGIN_RE`) may need tuning.
- The agent runs its **own headed Chrome window** on the host machine — separate from the
  Test Alchemist web UI, so its highlight overlay is only visible in that window.
- App Flow → TC injection keys off the scenario's `module` matching the flow's module name;
  if those differ, the flow won't attach.
- Login uses the repo's selectors only if a `loginPage` file is found in the connected repo;
  otherwise it falls back to the heuristic deep-DOM login.
- A SPA that swaps content **without changing the URL** limits route-based crawling/recording
  (each "view" can't be distinguished by URL).

---

## 11. When asking Claude for help

Useful things to share alongside this file: the connected repo's `loginPage`/SP-CP login file
and `seed.spec.js`, the failing run's live feed lines (look for `⮑ eval:` and per-page element
counts), and the exact label text on any login chooser that's being mis-clicked.
