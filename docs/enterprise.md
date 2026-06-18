# Enterprise hardening

What makes this pipeline suitable for production/regulated delivery, what is enforced vs.
conventional, and what is still owed. Honest by design — do not read more assurance into this
than the table grants.

## The enterprise principles, woven into the agents
These are stack-agnostic and are embedded in the relevant agent definitions (not just docs):

- **Authoritative spec governs** — the most detailed governing spec outranks a coarse AC
  summary, which outranks the code. Conflicts are flagged for human reconciliation, never
  silently resolved. Only a *recorded human decision* overrides the literal AC.
  *(requirements-analyst, solution-architect, orchestrator)*
- **Operational sense-check** — an AC describing a state that cannot physically occur yet is a
  misread, not a feature. *(requirements-analyst, frontend-designer)*
- **Gate-green ≠ requirement-complete** — passing lint/types/tests/scan is necessary, not
  sufficient. *(orchestrator done-gate, code-reviewer)*
- **Independent adversarial AC cross-check** — before "done", a reviewer that is *not* the
  implementer verifies each AC against the spec and tries to break the claim. This is a
  mandatory orchestrator step (step 10). *(orchestrator, code-reviewer)*
- **Shared-primitive prerequisite** — confirm a shared/platform primitive supports the need
  before building on it; if not, raise a prerequisite and stop. *(solution-architect,
  requirements-analyst)*
- **Honesty about tooling** — an absent/unconfigured gate is reported "N/A — not configured",
  never faked. *(all review/test/build agents)*
- **Greenfield fallback** — "read before you write" falls back to CLAUDE.md conventions when
  no sibling file exists. *(backend-developer, frontend-developer, frontend-designer)*

## Write-scope enforcement — what is hard vs. soft
| Tier | Agents | Guarantee |
|---|---|---|
| 1 — hard | requirements-analyst, solution-architect, frontend-designer | **Enforced** by the `tools:` allow-list (no write/shell tools). Survives plugin packaging. |
| 2 — soft → hard | code-reviewer, security-reviewer, db-migration-engineer | Convention by default; **enforce** it by running reviewers in a session that loads [`settings/settings.reviewer.json`](../settings/) (deny source writes). |

## Evidence (how it was tested)
- **Static validation:** 11 agents, valid frontmatter, valid tools, Tier-1 read-only proven, 0 problems.
- **Live advisory run** (requirements-analyst on a real story): grounded in real code, escalated
  blocking questions, applied the operational sense-check.
- **Live delivery run** in a sandbox project (implement → test → review → build): code built,
  35 spec-derived tests green, reviewers held read-only and reported absent tools honestly, the
  security reviewer caught a real latent numeric-validation bug. All five write-tier agents passed.

## Still owed before "certified enterprise-grade"
The pieces above were validated by running each agent's instructions; the following are not yet done:

1. An **in-harness run** with the actually-installed plugin agents (not instruction-replays).
2. One **complex, multi-file feature with a DB migration** driven end-to-end (exercises
   db-migration-engineer, the frontend pair, and orchestrator resume).
3. Wider trials across stacks beyond the Python sandbox + the AISLE Spring/React workspace.

Treat the implement→review→test→build half as **pilot-ready with a human gate**, not
unattended-autonomous, until 1–3 are complete.
