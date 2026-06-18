# Review — <ticket>

> Authors: db-migration-engineer, code-reviewer, security-reviewer (each appends its own section).
> Findings only — reviewers never edit source; developers fix.

## Schema review (db-migration-engineer)
Naming / index / constraint / rollback / cross-module findings.

## Code review (code-reviewer)
### Critical / Warning / Suggestion
- <file:line> — <issue> — <fix>
### Scanner output
Linter / static-analysis (e.g. SonarQube) / coverage results — scoped to the touched module.

## Security review (security-reviewer)
OWASP Top 10, token/session, CSRF, secrets, input validation, data-scope. Dependency-scan
output. DAST deferred — needs a deployed target.
