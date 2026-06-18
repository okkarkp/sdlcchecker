# Standards (generic starters — adopt & customise)

A fresh project often has no standards docs for the agents to point at. These are stack-agnostic
**baselines** so coding-standards and security-compliance checks work out of the box. Adopt them:

1. Copy the ones you want into `<project>/docs/`:
   ```
   cp standards/coding-standards.md  <project>/docs/coding-standards.md
   cp standards/security-rules.md    <project>/docs/security-rules.md
   cp standards/api-standards.md     <project>/docs/api-standards.md
   ```
2. Customise to your stack/policy (these are a floor, not a ceiling).
3. Point your `rules/` and `CLAUDE.md` at them (the starters in `../rules/` already reference
   `docs/coding-standards.md`, `docs/api-standards.md`, `docs/security-rules.md`).

| File | Used by | Covers |
|---|---|---|
| `coding-standards.md` | code-reviewer, backend/frontend-developer | naming, no-magic-strings, error handling, logging, types, reuse, tests |
| `security-rules.md` | security-reviewer | OWASP Top 10 mapping, secrets, sessions/CSRF, deps, resource limits, **compliance-coverage output** |
| `api-standards.md` | solution-architect, code-reviewer | resource naming, versioning, error contract, pagination, backward compatibility, per-endpoint authz |

> Declare your **compliance bands** (PDPA / IM8 / GDPR / SOC2 / WCAG) in `CLAUDE.md` §0 — the
> security-reviewer maps controls to OWASP Top 10 **and** those bands, and reports covered / N-A / GAP.
