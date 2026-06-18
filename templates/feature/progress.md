# <ticket> — <feature title>   (status: IN PROGRESS)

> Resumability anchor. Keep the `status:` marker as `IN PROGRESS` until done, then `DONE`.
> The orchestrator greps for `IN PROGRESS` on resume and cats this file to reload state.

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
- [ ] Verify-and-iterate loop — gates green + real flow exercised with evidence (converge, max 3 cycles)
- [ ] AC cross-check (done gate) — independent reviewer confirms each AC vs the authoritative spec

## Log
<!-- dated notes, one per step: YYYY-MM-DD <agent> — <what happened> -->
<!-- Verify loop: iter k — <what failed> → <who fixed> → <result> -->
