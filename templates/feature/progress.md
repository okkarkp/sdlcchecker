# <ticket> — <feature title>   (status: IN PROGRESS)

> Resumability anchor. Keep the `status:` marker as `IN PROGRESS` until the Definition of
> Done is fully met, then `DONE` (or `PARTIAL` if anything remains). The orchestrator greps
> for `IN PROGRESS` on resume, cats this file to reload state, and reconciles every ticked
> box against the artifact on disk before trusting it.

## Checklist

- [ ] Intake & normalization — orchestrator → 00-source/ (skip if source is plain text/md/csv)
- [ ] BA stories           — requirements-analyst → 00-stories.md
- [ ] Clarification        — requirements-analyst → 00-clarifications.md
- [ ] Assumptions logged   — requirements-analyst → 01-assumptions.md
- [ ] Blocking-question gate cleared — user answers all BLOCKING OQs before design
- [ ] Codebase pre-brief   — orchestrator → 02-prebrief.md
- [ ] System design        — solution-architect → 02-design.md (+ docs/decisions/ADR-NNNN-<slug>.md)
- [ ] UI flow              — frontend-designer → 03-ui-flow.md   (skip if no UI)
- [ ] Backend impl         — backend-developer → 04-implementation.md
- [ ] Frontend impl        — frontend-developer → 04-implementation.md
- [ ] Schema review        — db-migration-engineer → 05-review.md   (skip if no migration)
- [ ] Code + security review — code-reviewer, security-reviewer → 05-review.md
- [ ] Tests                — test-engineer → 06-test.md
- [ ] Build (touched module) — devops-engineer

## Gate ledger

> Each gate is GREEN (passed), RED (failed — pipeline must not advance), SKIPPED (+reason),
> or blank (not yet reached). The orchestrator runs a bounded remediation loop on RED (≤2
> re-spawns) and escalates to the user if still RED. Resume from the first RED/blank gate.

| Gate | Status | Attempts | Notes |
|---|---|---|---|
| Blocking-question gate | | | |
| Schema review | | | |
| Code review | | | |
| Security review | | | |
| Test | | | |
| Build | | | |

## Definition of Done (final gate)

- [ ] Every checklist item ticked or explicitly SKIPPED with a reason
- [ ] Every gate GREEN or SKIPPED (none RED or blank)
- [ ] No unresolved BLOCKING question in 00-clarifications.md
- [ ] Every acceptance criterion maps to covering evidence in 06-test.md
- [ ] No open Critical finding in 05-review.md
- [ ] Build GREEN for the touched module(s)

## Log
<!-- dated notes, one per step/attempt: YYYY-MM-DD <agent> — <what happened / gate outcome> -->
