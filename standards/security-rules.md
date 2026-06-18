# Security rules (generic starter, OWASP-mapped)

> Stack-agnostic baseline mapped to the OWASP Top 10. Copy to `<project>/docs/security-rules.md`
> and adapt; declare your compliance bands in `CLAUDE.md` §0 (e.g. PDPA, IM8, GDPR, SOC2, WCAG).
> The `security-reviewer` checks against this and reports coverage.

## Controls (with OWASP Top 10 mapping)
- **Input is hostile** — validate, sanitize, parameterize. No SQL/command/template injection; encode
  output to prevent XSS. *(A03 Injection)*
- **AuthN/AuthZ on every protected path** — enforce server-side, least privilege; never trust a
  client-side check alone; deny by default. *(A01 Broken Access Control, A07 Auth Failures)*
- **Sessions & tokens** — validate expiry before acting; CSRF protection on state-changing endpoints;
  secure/HttpOnly cookies; rotate on privilege change. *(A07)*
- **Secrets** — only via secret manager / env; never committed, logged, or echoed. *(A05)*
- **Cryptography** — vetted libraries only; no home-grown crypto; strong defaults. *(A02 Crypto Failures)*
- **Dependencies** — pinned, maintained, scanned; no new high/critical CVEs; lockfile updated. *(A06)*
- **Secure configuration** — safe defaults, fail-closed, no debug/stack traces in prod, least-exposed
  surface. *(A05 Security Misconfiguration)*
- **Resource limits** — rate limiting, request/payload size caps, pagination limits, bounded
  recursion/allocation. *(DoS / resource exhaustion — applies to non-web/library code too)*
- **Numeric integrity** — guard integer overflow, `NaN`/`inf`, float-precision loss on any computation.
- **SSRF / outbound** — validate and allowlist outbound URLs; no fetching attacker-controlled hosts. *(A10)*
- **Logging & monitoring** — log security-relevant events (without secrets/PII); make failures visible. *(A09)*
- **Integrity** — verify the integrity of code/data from external sources (signatures, checksums). *(A08)*

## Privacy & data handling
- Minimize PII collection; never log it; mask in outputs.
- Comply with the project's declared bands (PDPA / IM8 / GDPR / …) and confirm **data residency** for
  sovereign/regulated environments.

## Compliance coverage (what the reviewer must produce)
For every change touching auth, endpoints, sessions, data access, or external input, the
security-reviewer outputs a coverage table: each applicable OWASP item and each declared compliance
band → **covered / N-A (with reason) / GAP**. A GAP on a high/critical control is a merge blocker.
DAST is deferred (needs a deployed target). Absent scanners are reported "N/A — not configured", never faked.
