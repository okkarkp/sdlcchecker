# CLAUDE.md — Project Implementation Guideline

> **This is a template.** Copy it to your project root as `CLAUDE.md`, fill in §0, and delete
> this line. The delivery-team agents read the project `CLAUDE.md` to learn your stack,
> commands, and conventions — the more accurate §0 is, the sharper they are.

> **Purpose.** This file governs how you (Claude Code) turn **user stories** into production-grade software. You own the full loop: **Analyze → Plan → Design → Build → Verify → Validate**. You do not stop at "code compiles." You stop when the story's acceptance criteria are demonstrably met, all quality gates pass, and you can honestly report what is done versus deferred.
>
> **Non-negotiables.** Never overclaim. Never silently skip a gate. Never mark a story "done" without evidence. When uncertain, ask before assuming — a wrong assumption costs more than a clarifying question.

---

## 0. Project Facts (FILL THIS IN — agent must read first)

| Field | Value |
|---|---|
| Project name | `<fill>` |
| Primary language(s) | `<e.g. TypeScript, Python>` |
| Framework / runtime | `<e.g. Next.js 14, Spring Boot 3, FastAPI>` |
| Package manager | `<e.g. pnpm, uv, maven>` |
| Repo strategy | `<monorepo / polyrepo / hybrid>` |
| Branch model | `<trunk-based / GitFlow>` |
| Test stack | `<e.g. Vitest, Pytest, Playwright>` |
| Compliance bands | `<e.g. IM8, PDPA, WCAG 2.2 AA, SOC2 — or "none">` |
| Target environments | `<local / dev / staging / prod>` |

### Canonical commands (use these, do not invent)

```bash
# Install
<install cmd>
# Run dev
<dev cmd>
# Lint + format
<lint cmd>
# Type check
<typecheck cmd>
# Unit + integration tests
<test cmd>
# E2E tests
<e2e cmd>
# Build
<build cmd>
# Security / dependency scan
<scan cmd>
```

> If a command is missing here, **ask** rather than guessing. Do not run destructive commands (`db reset`, `force push`, `rm -rf`) without explicit confirmation.

---

## 1. Operating Principles

1. **Story is the source of truth.** Every line of code traces back to a story and its acceptance criteria. No scope creep, no "while I'm here" features without flagging.
2. **Evidence over assertion.** "It works" is meaningless without a passing test, a screenshot, or a reproducible command. Show the evidence.
3. **Plan before you build.** Produce a written plan and get implicit/explicit alignment before writing significant code. Surprise rewrites are a failure mode.
4. **Smallest correct change.** Prefer minimal, reversible diffs. Don't refactor unrelated code inside a feature change — raise it separately.
5. **Honest status.** Distinguish clearly between *built*, *built-but-untested*, *stubbed*, *planned*, and *blocked*. Never present a stub as a finished feature.
6. **Security and data safety are not optional gates** — they apply to every story, not just "security stories."
7. **Read before you write.** Inspect existing patterns, conventions, and abstractions in the codebase first. Match them. Consistency beats personal preference.

---

## 2. The End-to-End Workflow

Execute these phases **in order**. Each phase has an exit gate. Do not advance past a gate that hasn't been satisfied. Announce which phase you are entering.

### Phase 1 — ANALYZE (understand before acting)
- **Read every field/column of the story — not only the acceptance criteria.** Stories arrive with multiple attributes (title, description/narrative, acceptance criteria, priority/severity, dependencies/links, labels/tags, NFR or compliance fields, attachments/mockups, comments/clarifications, estimate, epic/feature parent). Each carries intent. A story understood from acceptance criteria alone is a misread story. Where a relevant field is blank, treat that gap as an ambiguity to resolve (§8), not as "nothing required."
- Parse each story into: **actor, goal, motivation, acceptance criteria, NFRs, dependencies, out-of-scope** — reconciling all columns. If two fields conflict (e.g. the description implies behavior the acceptance criteria omit), surface the conflict rather than silently picking one.
- Rewrite acceptance criteria as testable **Given / When / Then** scenarios. If the story lacks them, draft them from the full story context and surface for confirmation.
- Map the story against the **existing codebase**: which modules, services, data models, and APIs are touched? Identify reuse vs. net-new.
- Identify **dependencies and blockers**: upstream APIs, schema changes, secrets, feature flags, third-party services.
- Flag **ambiguities, contradictions, and hidden assumptions explicitly.** Ask targeted questions. Do not paper over gaps.

**Definition of Ready (gate to proceed):** actor/goal clear · acceptance criteria testable · NFRs identified · dependencies known · ambiguities resolved or explicitly noted.

### Phase 2 — PLAN (end-to-end, written)
- Produce an **implementation plan** covering: affected components, sequence of work, data/schema changes, API contract changes, test strategy, rollback strategy, and risks.
- Define the **traceability map**: `Story → Acceptance Criteria → Tasks → Files/Modules → Tests`. Keep this current.
- Break work into **vertical slices** that each deliver demonstrable behavior, not horizontal layers that can't be validated independently.
- Call out **NFR work** explicitly: performance budgets, security controls, accessibility, observability, error handling.
- State **what you will NOT do** and why (deferred items, assumptions).

**Gate:** plan reviewed (or no objection raised) · risks and rollback documented · traceability map exists.

### Phase 3 — DESIGN (make it sound before it's real)
- Define **interfaces and contracts first**: API schemas, function signatures, data models, events. Validate contracts against consumers.
- Respect **architectural boundaries** and layering already in the project (presentation / domain / data; or hexagonal/clean as applicable). No leaking concerns across layers.
- Design for **failure**: timeouts, retries with backoff, idempotency, graceful degradation, and explicit error types — not swallowed exceptions.
- Design **data changes safely**: backward-compatible migrations, expand-then-contract for breaking changes, no destructive migration without an approved backup/rollback path.
- Decide **observability up front**: what to log (structured, no secrets/PII), what metrics to emit, what to trace.
- Document non-trivial decisions as short **ADR-style notes** (context → decision → consequence).

**Gate:** contracts defined · boundaries respected · failure modes designed · migration safety confirmed.

### Phase 4 — BUILD (implement to standard)
- Follow the codebase's existing conventions, style, and idioms. Run the formatter/linter as you go.
- Write **typed, defensive code**: validate inputs at boundaries, handle the unhappy path, never trust external input.
- **No secrets in code or logs.** Use configuration/secret management. No hardcoded credentials, tokens, or endpoints.
- Implement **tests alongside code**, not after (see §3). Aim for behavior coverage of every acceptance criterion.
- Keep functions/modules cohesive and small; avoid speculative generality. Remove dead code you introduce.
- Make **atomic commits** with conventional messages (`feat:`, `fix:`, `refactor:`, `test:`, `chore:`) referencing the story ID.
- **Write the implementation log as you go** (§6.1): record the actor, processor/data flow, why you chose this approach, and every assumption *at the moment you make it* — not reconstructed afterward.

**Gate:** code complete for the slice · lint + type check clean · no secrets · commits clean and traceable · implementation log started with actor, processor, rationale, and assumptions captured.

### Phase 5 — VERIFY (prove technical correctness, end-to-end)
- Run the **full test suite**: unit → integration → contract → E2E. Do not cherry-pick.
- Enforce **quality gates** (see §4). If a gate fails, fix it — do not lower the bar or disable the check.
- Run the app and **exercise the real flow** end-to-end (UI path, API path, or both). Capture evidence (output, logs, screenshots).
- Run **security and dependency scans**; triage findings. No new high/critical vulnerabilities.
- Confirm **observability works**: logs are structured and PII-free, metrics emit, errors surface correctly.
- Verify **performance against budget** for the touched paths (latency, payload size, query count — watch for N+1).

**Gate:** all tests green · all quality gates pass · E2E flow verified with evidence · no new high/critical security findings.

### Phase 6 — VALIDATE (prove the story is satisfied)
- For **each acceptance criterion**, demonstrate it is met with a mapped test or reproducible evidence. Walk the Given/When/Then.
- Confirm **NFRs** are satisfied (security controls present, accessibility checks pass, performance within budget).
- Update the **traceability map** to show every criterion → covering test → status.
- Finalize the **implementation log** (§6.1): the "how validated" section maps every acceptance criterion and NFR to its proving evidence, and all assumptions are recorded with their rationale and risk.
- Produce a **completion report** (§6.2): what was built, evidence per criterion, what was deferred/assumed, residual risks, and rollback notes.
- Confirm **definition of done** in full before declaring the story complete.

**Definition of Done (final gate):** every acceptance criterion demonstrably met · all gates passed · docs updated · traceability complete · implementation log finalized (actor, processor, validation, assumptions, rationale) · honest completion report delivered.

---

## 3. Testing Standards (test pyramid + layered promotion)

- **Unit** — fast, isolated, cover logic and edge cases. The broad base.
- **Integration** — real module/service/DB interactions; verify contracts hold.
- **Contract** — consumer/provider contracts for APIs and events; prevent breaking changes.
- **E2E** — critical user journeys through the real stack; the narrow top.
- **Every acceptance criterion maps to at least one test.** No criterion is "validated" by inspection alone.
- Tests are **deterministic and independent** — no order dependence, no flakiness, no reliance on prod data.
- Cover the **unhappy paths**: invalid input, auth failure, timeout, empty/large datasets, concurrency.
- Coverage is a signal, not a target to game; meaningful assertions over line count.

---

## 4. Quality Gates (must all pass before VALIDATE completes)

| Gate | Requirement |
|---|---|
| Formatting | Code passes the project formatter with no diffs |
| Linting | Zero lint errors (warnings triaged) |
| Types | Type checker clean — no `any`-escapes hiding errors |
| Tests | 100% of suite passing; new code covered by behavior tests |
| Security (SAST) | No new high/critical findings; secrets scan clean |
| Dependencies | No new high/critical CVEs; lockfile updated |
| Build | Production build succeeds |
| Accessibility | WCAG target met on touched UI (if applicable) |
| Performance | Touched paths within defined budgets; no N+1 / obvious regressions |

> If you cannot make a gate pass, **stop and report** with the specific failure and options — do not disable or weaken the gate.

---

## 5. Security, Privacy & Data Handling

- Treat all external input as hostile: validate, sanitize, parameterize (no SQL/command/template injection).
- **AuthN/AuthZ**: enforce on every protected path; least privilege; never trust client-side checks alone.
- **Secrets**: only via secret manager / env; never committed, logged, or echoed.
- **PII / sensitive data**: minimize collection, never log it, mask in outputs, comply with applicable bands (e.g. PDPA). Confirm data residency requirements for regulated/sovereign environments.
- **Dependencies**: prefer maintained, reputable packages; pin versions; scan before adding.
- **Defense in depth**: rate limiting, input size limits, safe defaults, fail-closed on errors.
- Map controls to applicable frameworks (OWASP Top 10, and project compliance bands) and note coverage in the completion report.

---

## 6. Implementation Log & Completion Report

You produce **two written artifacts per story**: a running **implementation log** (the detailed record of *how and why*) and a final **completion report** (the end-of-story summary). Both live in the repo (e.g. `docs/implementation-log/<story-id>.md`) so they survive the session and are reviewable.

### 6.1 Implementation Log — write it as you build, not after

The log explains the implementation to a future reader (reviewer, maintainer, auditor) who wasn't present. It is **append-only**: when a decision changes, add a dated entry explaining the change — do not erase history. It must answer, for each story, *who*, *what*, *how validated*, *what was assumed*, and *why this way*.

```
## Story <ID> — <title>
Author: Claude Code · Date: <date> · Status: IN PROGRESS | DONE | BLOCKED

### Actor
Who the behavior serves and who/what triggers it (end user role, calling service,
scheduled job, event source). Reference the relevant story columns it was drawn from.

### Trigger / entry point
How the flow starts — UI action, API endpoint, event/message, cron — and the
preconditions required.

### Processor
The component(s) that do the work: the modules/services/functions involved and the
data flow through them (input → processing steps → output). Name the key files.

### Inputs → Outputs → Side effects
What goes in, what comes out, and any persisted state, emitted events, or external
calls (with idempotency notes).

### How it was implemented
The approach actually taken, the patterns/abstractions reused, and the key files
changed.

### Why it was implemented this way
The rationale. Alternatives considered and why they were rejected. Trade-offs accepted
(performance vs. simplicity, build vs. reuse, etc.). Tie back to NFRs and constraints.

### Assumptions taken
Each assumption + WHY it was made (missing field, ambiguous criterion, absent
stakeholder) + the RISK if the assumption is wrong + how to confirm it. Every
assumption here must also appear in the completion report.

### How it is validated
How each acceptance criterion and NFR is proven — the specific tests, commands, or
evidence, mapped criterion-by-criterion. Include the unhappy paths / edge cases
covered.

### Edge cases & failure handling
What can go wrong and how the code responds (validation, retries, timeouts, graceful
degradation).

### Deferred / follow-ups
What was intentionally left out and why; technical debt raised.

### Change history (append-only)
- <date>: <what changed and why>
```

> The log is mandatory and must be **honest and specific**. "Validated via tests" is not acceptable — name them. An assumption left undocumented here is a defect.

### 6.2 Completion Report (use at the end of every story)

```
## Story: <ID> — <title>
Status: DONE | PARTIAL | BLOCKED

### Acceptance Criteria
- [✓] AC1 — <criterion>  → evidence: <test name / command / screenshot>
- [✓] AC2 — <criterion>  → evidence: ...
- [ ] AC3 — <criterion>  → DEFERRED: <reason>

### Quality Gates
lint ✓ · types ✓ · unit ✓ · integration ✓ · e2e ✓ · security ✓ · build ✓ · a11y ✓ · perf ✓

### Built
<what was implemented, plainly>

### NOT done / assumed / deferred
<honest list — stubs, assumptions, out-of-scope, follow-ups>

### Risks & rollback
<residual risks; how to revert this change>

### Files changed
<paths>
```

> The "NOT done / assumed / deferred" section is **mandatory and must be honest.** A clean-looking report that hides a stub is a failure.

---

## 7. Git & Collaboration Conventions

- **Branch:** `feature/<story-id>-<slug>` · `fix/<story-id>-<slug>`.
- **Commits:** Conventional Commits, imperative mood, reference story ID. Small and atomic.
- **PRs:** include the completion report; link the story; note migrations, breaking changes, and rollback. Keep PRs reviewable in size.
- **Never force-push shared branches.** Never commit secrets, generated artifacts, or large binaries.

---

## 8. Escalate / Ask — don't guess

Stop and ask the human when:
- Acceptance criteria are ambiguous, contradictory, or missing and you'd otherwise have to assume.
- A change requires a destructive migration, breaking API change, or touching auth/payments/PII handling.
- A required command, credential, environment, or dependency is unavailable.
- The "smallest correct change" turns out to require a large refactor or architectural shift.
- A quality or security gate cannot be satisfied.

A clarifying question is cheap. A confidently wrong implementation is expensive. Default to asking.

---

## 9. Anti-Patterns (do not do these)

- Marking a story done with failing/skipped tests or disabled gates.
- Presenting stubs, mocks, or `TODO`s as completed functionality.
- Refactoring unrelated code inside a feature change.
- Swallowing exceptions or logging-and-continuing on errors that should fail.
- Hardcoding secrets, endpoints, or environment-specific values.
- Inventing commands, file paths, APIs, or library behavior instead of verifying.
- Expanding scope beyond the story without flagging it.
- Claiming verification without running the actual end-to-end flow.
