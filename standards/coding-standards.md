# Coding standards (generic starter)

> Stack-agnostic baseline. Copy to `<project>/docs/coding-standards.md` and adapt — the rules
> in `rules/` and the `code-reviewer` point here. Where this conflicts with the project's own
> doc, the project's doc wins; where it conflicts with the code, the code wins (flag the drift).

## Naming & structure
- Intention-revealing names; match the surrounding module's conventions.
- **No magic strings/numbers** — use named constants or enums. A status, code, or key that
  appears in more than one place must be a constant.
- Small, cohesive units; one responsibility each. Remove dead/commented-out code you introduce.
- No `TODO`/`FIXME` without a tracked reference.

## Types & contracts
- Fully typed public surfaces; no unsafe casts or `any`-escapes that hide errors.
- Versioned DTOs / API contracts per the project's convention; don't break a contract in place.
- Doc comments on new public types and methods.

## Error handling (the unhappy path is not optional)
- Validate inputs at boundaries; reject invalid input with explicit, typed errors.
- **Never swallow exceptions**; never log-and-continue on a failure that should stop the flow.
- Fail closed: on an unexpected error, deny/abort rather than proceed in an unknown state.

## Logging
- Structured logs at appropriate levels. **No secrets, tokens, credentials, or PII in logs.**
- Log enough to debug and to satisfy the project's audit needs — no more.

## Persistence & data
- A persisted entity/model change ships **with its schema migration in the same change**
  (the db-migration-engineer reviews it; it doesn't author it).
- Backward-compatible / expand-then-contract for breaking schema changes.

## Reuse & consistency
- **Read before you write** — mirror an existing similar file before introducing a new pattern.
- Reuse existing utilities, components, and design tokens before inventing new ones.
- Prefer maintained, pinned dependencies; justify any new dependency.

## Tests
- Tests alongside code; cover the unhappy paths (invalid input, auth failure, empty/large data,
  concurrency). Coverage is a signal, not a target to game.
