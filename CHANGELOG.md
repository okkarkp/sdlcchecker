# Changelog

All notable changes to the `delivery-team` plugin are recorded here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] — 2026-07-05

Closes coverage gaps identified in a full read-through of all 11 agents: non-functional
requirements had no capture point, and performance, observability, license compliance,
rollback drills, and i18n/l10n were never explicitly owned by any stage. All fixes are made
to the **existing 11-agent roster** — no new specialist added.

### Added
- **`requirements-analyst`** gains a new deliverable section, **§7 Non-Functional
  Requirements** (performance / observability / i18n-locale / availability), persisted to a
  new `## 7. Non-Functional Requirements` section in `00-stories.md`. Every row must be
  `STATED` / `ASSUMED-DEFAULT` / `N/A` — never blank. Renumbers the deliverable to 11 sections
  (was 10); orchestrator's persist/validate instructions and handover self-check updated to
  match.
- **`solution-architect`** gains a 9th required design-note section, **"Observability &
  operational readiness"** (logging, metrics/alerting, rollback trigger) — designed against
  the new NFR table instead of being implicit/easy to skip.
- **`test-engineer`** gains a 4th test layer, **Performance / load**, run only when the NFR
  table states a budget, scoped to the touched flow, using the project's own perf tool — "N/A"
  honestly when no budget or tool exists.
- **`security-reviewer`** gains a **license-compliance** check alongside the existing CVE scan
  (flagging copyleft/restricted licenses on new dependencies), with a Compliance-coverage row.
- **`devops-engineer`** gains **observability-wiring verification** (confirms the design's
  logging/metrics/alerts are actually present, not just designed), a **rollback drill** for
  migrations/changes `db-migration-engineer` flags HIGH-RISK (actually exercises the down-path
  in a scratch environment, or records why it couldn't), and a **release record** (what
  changed, version, rollback pointer) — a minimal change-management artifact.
- **`db-migration-engineer`** now explicitly flags destructive/breaking migrations
  **HIGH-RISK — requires a rollback drill**, handing off the actual drill to
  `devops-engineer` rather than leaving rollback rigor only reviewed on paper.
- **`frontend-designer`** / **`frontend-developer`** gain **internationalization/locale**
  guidance tied to the new NFR row — translatable strings and locale-aware formatting when
  multi-locale/RTL is stated, explicit "N/A — single-locale" otherwise.
- **Definition-of-Done** (orchestrator + `progress.md` template) now requires every NFR row to
  be satisfied-with-evidence or explicitly N/A, and a HIGH-RISK build's rollback drill to have
  run (or be recorded as not-drillable).
- Fixed a pre-existing miscount in `orchestrator.md` ("Three things carry it" listing four).

## [0.3.0] — 2026-07-05

Three-tier memory model: durable, auditable knowledge at project scope **and** organization
scope, on top of the existing per-feature implementation log.

### Added
- **`docs/organization-memory.md`** — the design doc for a memory tier Claude Code doesn't ship
  natively. Session context → project memory (native `memory: project`) → **organization
  memory** (a separate, vendored, human-curated repo shared across every project). Explains why
  a plain `memory: user` scope can't substitute (single-machine, not org-shared) and why this
  plugin's validator restricts agent frontmatter to `project`/`local`.
- **`templates/org-memory/`** — a starter scaffold to seed a *separate* org-memory repo:
  `MEMORY.md` index plus topic files (`conventions.md`, `architecture-precedents.md`,
  `security-findings.md`, `review-anti-patterns.md`), a dated/provenance-tagged entry format,
  and the human-PR review gate that governs every promotion.
- **Orchestrator reads + proposes, never writes.** The pre-brief now checks for a vendored
  `.claude/org-memory/` and folds it into discovered conventions; a new wrap-up step (11)
  reviews the feature for anything that generalizes past this one project and lists it as an
  **org-memory promotion candidate** in `progress.md` — a proposal a human reviews and PRs into
  the org-memory repo themselves. The orchestrator never has write access to that repo.
- **Specialist agents flag promotion candidates.** Every agent that already said "keep this in
  your memory" (code-reviewer, backend/frontend-developer, solution-architect,
  security-reviewer, db-migration-engineer, test-engineer, frontend-designer,
  requirements-analyst, devops-engineer) now also flags durable, cross-project learnings to the
  orchestrator instead of only keeping them project-local.
- **Cross-referenced the two implementation-log systems.** `templates/CLAUDE.md` §6 now points
  out that its standalone implementation-log/completion-report shape and the orchestrator
  plugin's `artifacts/feature/<ticket>/` log are equivalents for the same job — use one, not
  both, for the same story.

## [0.2.0] — 2026-06-18

Enterprise-robustness pass: deterministic gates, failure handling, verifiable artifact.

### Added
- **Pipeline quality gates & failure handling.** Every stage is now an explicit gate
  (GREEN/RED/SKIPPED). RED gates trigger a bounded remediation loop (≤2 re-spawns with the
  specific findings) and escalate to the user if still failing. The orchestrator never
  advances past, or silently weakens, a RED gate.
- **Definition-of-Done gate.** `progress.md` cannot flip to `DONE` until every gate is
  GREEN/SKIPPED, every acceptance criterion maps to evidence, no Critical review finding is
  open, and the touched-module build is GREEN. Otherwise the feature is reported `PARTIAL`.
- **Requirement intake & normalization.** The orchestrator now normalizes non-text sources
  (`.xlsx`/`.docx`/table-heavy PDFs) to markdown/CSV under `00-source/` with full provenance,
  then hands the analyst the normalized artifact. PDFs/CSV/images are read directly.
- **Output validation before persist.** Advisory-agent returns are checked for completeness
  against each agent's contract before being written; incomplete returns are re-spawned, never
  persisted partial.
- **Resume integrity check.** On resume, ticked checklist items are reconciled against the
  artifacts on disk — a ticked step with a missing/empty artifact is treated as not done.
- **Build stage now consumes the design.** `@devops-engineer` reads `02-design.md` and
  `04-implementation.md` to verify config keys, dependencies, infra, and NFRs — not just that
  code compiles.
- **Gate ledger + DoD checklist** added to the `progress.md` template.
- **Plugin self-validation.** `scripts/validate_plugin.py` validates manifests, agent
  frontmatter, the tool allowlist, cross-references, and template consistency; wired into CI
  via `.github/workflows/validate.yml`.

### Fixed
- Stale local install path and an agent-count wording mismatch in the docs/manifest.
