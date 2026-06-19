---
description: Deliver a user story end-to-end through the delivery pipeline (clarify → design → implement → review → test → build → verify), writing an audit trail.
mode: agent
---

# Deliver

Drive the requirement the user names through the full delivery pipeline, **in a single agent
session**, role-shifting through each specialist stage in order and writing an audit trail
under `artifacts/feature/<ticket>/`.

> **Port note.** GitHub Copilot runs one agent session at a time — it does not spawn parallel
> sub-agents the way the Claude `delivery-team` plugin does. So you yourself walk the stages
> sequentially, adopting each persona in `.github/chatmodes/` in turn. The gates, the
> verify-loop, and the honesty rules are identical; only the execution model differs. For a
> deeper single-role pass (e.g. an adversarial security review), the user can switch to that
> chat mode directly.

## Inputs
- `${input:story:Path to the story / spec (or paste the requirement)}`
- `${input:ticket:Ticket id (e.g. ABC-123); leave blank to derive one}`

## Pre-flight (report each in one line, then proceed)
1. **Resolve the source.** If no story path/text was given, ask which document/section to work
   from — never assume a default.
2. **Resume check.** If `artifacts/feature/<ticket>/progress.md` exists and is IN PROGRESS,
   resume it instead of starting fresh.
3. **Safe branch.** If on `main`/`master`/`develop`, suggest
   `git checkout -b feature/<ticket>-<slug>` first — the pipeline writes code.

## Pipeline — run in order, skip-with-a-reason, never silently drop a stage

0. **Intake** — if the source is a binary office format (`.xlsx`/`.docx`) or a link, normalize
   it to markdown/CSV under `artifacts/feature/<ticket>/00-source/` first, preserving the
   original. Record the conversion command used.
1. **Clarify** *(persona: requirements-analyst)* — extract user stories + acceptance criteria;
   list open questions and tag each **BLOCKING** or **NON-BLOCKING**; self-resolve the
   non-blocking ones with a logged assumption. Write `00-stories.md`, `00-clarifications.md`,
   `01-assumptions.md`.
   - **Blocking-question gate (HARD STOP):** if any BLOCKING question remains, stop and ask the
     user. Do not design or implement until every blocking item is cleared. Record their
     answers (tag firm decisions `[Human decided]`) before resuming.
2. **Pre-brief** *(orchestrator-owned)* — record the baseline (`git rev-parse HEAD`), verify
   every doc link in the stories resolves, learn the stack/build/test/migration commands from
   the project, read a representative existing file per touched area, and flag any spec-vs-code
   drift. Write `02-prebrief.md`.
3. **Design** *(persona: solution-architect)* — component/data design + one ADR per real
   decision under `docs/decisions/ADR-NNNN-<slug>.md`. Write `02-design.md`.
4. **UI flow** *(persona: frontend-designer — only if the feature has UI)* — write
   `03-ui-flow.md`.
5. **Implement** *(persona: backend-developer / frontend-developer)* — write the code AND, for
   any persisted-model change, the matching migration in the same step. Write
   `04-implementation.md`.
6. **Schema review** *(persona: db-migration-engineer — only if a migration was written)* —
   adversarially probe the migration (constraints, NULLs, idempotency, rollback). Write
   findings to `05-review.md`.
7. **Review** *(persona: code-reviewer, then security-reviewer)* — run the project's real
   lint/static-analysis/scanner commands scoped to the touched module; attach the actual
   output; classify findings critical/warning/suggestion. Append to `05-review.md`.
8. **Test** *(persona: test-engineer)* — write spec-derived tests (not implementation-derived),
   run them, and record results in `06-test.md`.
9. **Build + VERIFY** *(persona: devops-engineer)* — run the build for the touched module, then
   run the app/endpoint and exercise the real flow, capturing evidence. A build that compiles
   but drops a required config key is a failed build.
10. **AC cross-check (mandatory done gate)** — do an INDEPENDENT adversarial pass (a reviewer
    persona that is NOT the implementer) confirming **each** acceptance criterion in
    `00-stories.md` is demonstrably met against the authoritative spec, actively trying to
    break the "done" claim. Record the verdict in `06-test.md`.

## Build–verify–validate loop (converge — don't single-pass)
Steps 5–10 are a loop, not a line:
1. Run the gates for the touched module (discovered commands, never invented) AND verify the
   real flow with captured evidence.
2. On any failure, route the SPECIFIC failure back to the owning persona and re-run only what's
   affected.
3. Re-run gates + verify. Repeat.
4. **Exit only when** all gates are green AND step 10 confirms every AC.

**Bounds & integrity:** cap at **3 cycles** — if it hasn't converged, or the same failure
recurs twice, STOP and escalate with evidence and options. Never weaken the loop to force
green: don't skip a gate, don't edit a test to pass, don't swallow an error. Record each
iteration in `progress.md` (`Verify loop: iter k — <what failed> → <fix> → <result>`).

## Report
State where it stopped — a gate, DONE, or escalated — and point to
`artifacts/feature/<ticket>/`. A feature is done only when the gates are green AND the AC
cross-check confirms every acceptance criterion. Report built / partial / blocked truthfully.
