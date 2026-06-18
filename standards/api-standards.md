# API standards (generic starter)

> Stack-agnostic baseline. Copy to `<project>/docs/api-standards.md` and adapt; the rules and the
> `code-reviewer` / `solution-architect` point here.

- **Consistent resource naming & versioning** — stable, predictable paths; version the contract
  (URL or header per project convention). Never change a contract's meaning in place.
- **Status codes & error contract** — correct HTTP (or transport) codes; a consistent error shape
  (e.g. problem-details: code, message, field errors). Don't leak stack traces or internals.
- **Validation at the boundary** — reject malformed/oversized input with a 4xx and a clear message;
  enforce a max payload size.
- **Envelope consistency** — responses follow one envelope shape across the API; match what real
  consumers already expect (validate the contract against actual callers, don't redesign blindly).
- **Pagination / filtering / sorting** — consistent params and limits; cap page size.
- **Idempotency** — unsafe operations that may be retried are idempotent or guarded against dupes.
- **Backward compatibility** — additive/expand-then-contract changes; breaking changes require a new
  version and a migration path for consumers.
- **AuthZ per endpoint** — every endpoint declares its access requirement; document it
  (OpenAPI/schema). Public vs internal/privileged paths stay separate.
