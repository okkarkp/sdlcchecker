# delivery-team — architecture briefing

Higher-level overview of this multi-agent feature-delivery pipeline. The authoritative
configuration is the files in this repo — see [Reference](#reference).

## Purpose

Take a feature requirement and carry it through **clarification → system design → UI-flow
design → implementation → review → test → build**, running over days or weeks, while
**logging every decision, assumption, and implementation detail** to durable files that
survive session restarts and are auditable later.

Stack-agnostic: the specialists learn each project's stack, build commands, and conventions
from that project's `CLAUDE.md` and `.claude/rules/` rather than hardcoding them.

## Two enterprise constraints shaped the design

- **MCP allowlist only.** Only org-allowlisted MCP servers may be used. A design-tool MCP
  (e.g. Figma) is optional and gated — configure it at project level if allowed; the
  frontend-designer falls back to markdown specs otherwise.
- **No hooks.** Every job a hook would normally do (surface in-progress work on resume,
  checkpoint logs, enforce write-scope) is instead handled by **agent instructions** — the
  orchestrator runs the equivalent steps as ordinary tool calls.

## The pipeline

```
        ┌──────────────┐
        │ ORCHESTRATOR │  receives the requirement, spawns specialists in
        └──────┬───────┘  sequence, owns the per-feature audit log
               │
  CLARIFY/PLAN │ IMPLEMENT          QUALITY GATE
  ─────────────┼──────────────────────────────────
  requirements │ backend-developer   code-reviewer
  -analyst     │ frontend-developer  security-reviewer
  solution     │ db-migration        test-engineer
  -architect   │ -engineer (review)
  frontend     │ devops-engineer
  -designer    │
```

**Sequence:** Clarify → Pre-brief → Design → UI flow → Implement → Schema review → Review →
Test → Build. Agents are **never auto-triggered** — work is routed through `@orchestrator`,
which decides which specialists to spawn (or `@`-mention a specialist for a one-off).

## Write-scope enforcement (hybrid, hook-free)

With no hooks, no single rule is both per-agent and per-path, so enforcement is split:

- **Tier 1 — hard read-only.** `requirements-analyst`, `solution-architect`,
  `frontend-designer` have **no write/shell tools at all** (enforced by their `tools:`
  allow-list, which survives plugin packaging). They *return* their deliverable as their
  final message and the **orchestrator persists it** to the artifact file.
- **Tier 2 — soft read-only.** `code-reviewer`, `security-reviewer`, `db-migration-engineer`
  need `Bash` to run real scanners, so "never edits source" is enforced by **convention**.
  Back it with a project-level `settings.json` deny rule when running reviewers in a
  dedicated session (a plugin cannot ship one — see the README).

## The audit log (resumability)

The orchestrator copies `templates/feature/` to `artifacts/feature/<ticket>/` in the
consuming project, then runs the pipeline, updating `progress.md` and staging only that
ticket's logs after each step (no auto-commit). If a session dies mid-feature, the next
`@orchestrator resume <ticket>` greps for the `IN PROGRESS` marker, reloads `progress.md`,
and continues from the first unchecked item — rationale and assumptions are all on disk.

For genuinely parallel features, run each ticket in its own git worktree/branch so concurrent
runs can't race on a shared index.

## Maturity

The advisory trio (requirements-analyst, solution-architect, frontend-designer) and the
orchestrator-as-router have been exercised in practice. The implementation/review/test/build
half has **not** been run end-to-end yet — treat it as untested until trialled. A useful first
trial: drive one small, low-risk feature all the way through on a worktree and watch where the
hand-offs and the template/permission wiring need adjusting.

## Reference

| What | Location |
|---|---|
| Agent definitions | [`agents/`](../agents/) — 11 `*.md` files |
| Slash command | [`commands/self-review.md`](../commands/self-review.md) |
| Feature-log scaffold | [`templates/feature/`](../templates/feature/) |
| ADR template | [`templates/ADR-TEMPLATE.md`](../templates/ADR-TEMPLATE.md) |
| Generic rule starters | [`rules/`](../rules/) |
| Plugin + marketplace manifest | [`.claude-plugin/`](../.claude-plugin/) |

## Docs the agents expect in a consuming project (discovered via CLAUDE.md)

Coding standards · API standards · security rules · authentication · testing guide ·
architectural principles · a dev/while-coding checklist · build methodology. None are
required, but the more the project documents (and points to from its `CLAUDE.md`), the
sharper the agents are.
