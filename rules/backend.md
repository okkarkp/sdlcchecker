---
paths:
  - "<backend-module>/**"
---

# Backend rules

For anything in these paths, follow the project's coding-standards and api-standards docs
and the touched module's own `CLAUDE.md`.

- **Read before you write** — mirror an existing similar file in the target package
  (annotation/decorator ordering, import grouping, helper usage, exception handling, logging).
- **Build scope** — run the project's build/test scoped to the touched module; do not invent
  commands and do not fan a build across the whole repo unless the tooling expects it.
- **Entity + schema migration go together** — when a persisted entity is added or altered,
  write the matching schema migration in the same change (projects that validate schema on
  startup fail the build otherwise).
- Code is the source of truth — if a doc contradicts the code, follow the code and flag it.
