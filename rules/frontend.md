---
paths:
  - "<frontend-app>/**"
---

# Frontend rules

For anything in these paths, follow the front-end app's `CLAUDE.md` and the project's
coding-standards doc.

- **Read before you write** — mirror an existing similar component/hook (file layout, hook
  patterns, the data-fetch/mutation pattern, access-control gating, date utils).
- Reuse existing components and design tokens before inventing new ones; keep design-system
  alignment.
- For auth/session/CSRF/BFF work, the auth rule also applies — see the project's
  authentication doc.
- Code is the source of truth — if a doc contradicts the code, follow the code and flag it.
