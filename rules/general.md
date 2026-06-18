---
paths:
  - "**/*"
---

# Engineering defaults (applies to all paths)

Stack-agnostic best practices that hold in any codebase. These are the generic core distilled
from the per-area rules — drop this one in (or apply it globally) to get sane defaults
everywhere, then add the backend / frontend / auth rules for area-specific guidance.

## Before you write
- **Read before you write** — mirror an existing similar file in the target area (naming,
  import/dependency ordering, error handling, logging, test layout) before introducing a new
  pattern. Consistency beats personal preference.
- **Reuse before inventing** — prefer existing components, utilities, helpers, and design
  tokens over new ones.
- **Code is the source of truth** — if a doc or comment contradicts the code, follow the code
  and flag the discrepancy rather than trusting the stale text.

## How you change things
- **Smallest correct change** — minimal, reversible diffs. Don't refactor unrelated code inside
  a feature change; raise it separately.
- **Discover commands, don't invent them** — use the project's documented build / test / lint
  commands (from `CLAUDE.md`), scoped to the touched module; never guess a command.
- **Persistence travels together** — when a persisted entity/model is added or altered, write
  the matching schema migration in the same change (projects that validate schema on startup
  fail otherwise).

## Correctness & safety
- **Handle the unhappy path** — validate inputs at boundaries; surface explicit errors. Never
  swallow exceptions or log-and-continue on a failure that should stop the flow.
- **Never log or commit secrets** — no credentials, tokens, API keys, or PII in code, logs, or
  output. Use the project's secret manager / env.
- **Auth/session discipline** — keep public/citizen paths and internal/privileged paths
  separate; preserve CSRF protection on state-changing endpoints; validate token/session expiry
  before acting on a request.

## Honesty
- **Evidence over assertion** — don't claim something works without a passing test or a
  reproducible check. Report status honestly: built / partial / deferred — never present a stub
  as finished.
