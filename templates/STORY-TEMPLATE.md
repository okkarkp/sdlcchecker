<!--
  USER STORY TEMPLATE — one story per file.
  Copy to docs/stories/<ID>-<slug>.md, fill every field, delete this comment.
  The requirements-analyst reads ALL fields (not just the ACs) — a blank relevant field is
  treated as an ambiguity to resolve, so fill them or write "n/a" deliberately.
  Then run:  @orchestrator deliver docs/stories/<ID>-<slug>.md
-->

# <ID> — <Short title>

| Field | Value |
|---|---|
| ID | `<e.g. HSA-1 / PROJ-123>` (stable; used as the ticket / branch / log key) |
| Epic / Module | `<grouping>` |
| Actor(s) | `<primary role; note secondary roles>` |
| Priority | `High / Medium / Low` |
| Status | `Draft / Ready / In progress / Done` |
| Dependencies | `<other story IDs, upstream APIs, feature flags, seed data — or "none">` |
| NFR / Compliance | `<perf budget, a11y target, security/PDPA/IM8 band — or "none">` |
| Spec link | `<link to the authoritative/detailed spec, if any — the AC summary is not the spec>` |

## Story
**As a** `<role>`
**I want** `<capability>`
**So that** `<benefit / why it matters>`

## Acceptance Criteria  (testable — Given / When / Then)
1. **Given** `<context>`, **when** `<action>`, **then** `<observable result>`.
2. **Given** … **when** … **then** …
3. …

> Rules for ACs: each must be testable and unambiguous. No "TBD", no undefined terms, no status
> described only in prose — use exact named constants (e.g. `ORDER_INFO_REQUESTED`). Every AC should
> be something a test can assert. If you can't write it as Given/When/Then, it isn't ready.

## Out of scope
- `<what this story deliberately does NOT do — your main defence against scope creep>`

## Notes / open questions
- `<anything the team already knows is uncertain — the analyst will tag these BLOCKING/NON-BLOCKING>`
