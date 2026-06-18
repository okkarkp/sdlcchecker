# delivery-team — a multi-agent feature-delivery pipeline (Claude Code plugin)

Take a feature requirement — a story, an epic, a spec — and carry it through
**clarification → system design → UI-flow design → implementation → review → test → build**,
logging every decision, assumption, and implementation detail to durable files that survive
session restarts and are auditable later.

This is a packaged, **stack-agnostic** delivery pipeline. The specialists don't hardcode a
stack — they learn each project's language, build commands, and conventions from that
project's `CLAUDE.md` and `.claude/rules/`. To tune it for a specific project, add an
**overlay**: a `CLAUDE.md` plus path-scoped `.claude/rules/` in the consuming project (see
[`rules/`](rules/) for starters). Project-specific overlays live in the consuming project,
not in this repo.

> **Maturity.** Of the 11 agents, the *advisory* trio (requirements-analyst,
> solution-architect, frontend-designer) plus the orchestrator-as-router have been exercised
> in practice; the *implementation/review/test/build* half has not been run end-to-end yet.
> Treat that half as untested until you've trialled it. See [`docs/architecture.md`](docs/architecture.md).

## The roster (11 agents)

| Agent | Stage | Responsibility | Tools |
|---|---|---|---|
| **orchestrator** | all | Breaks the requirement into tasks, spawns specialists, owns the feature log, runs resume/checkpoint logic | Agent, Read, Edit, Write, Bash, Grep, Glob, WebSearch |
| **requirements-analyst** | clarify | Clarification questions + explicit assumptions register before any design | **read-only** (Read, Grep, Glob) |
| **solution-architect** | design | Architectural decisions, ADRs, cross-module design | **read-only** (Read, Grep, Glob, WebSearch) |
| **frontend-designer** | design | UI-flow, screen specs, design tokens | **read-only** (Read, Glob, Grep) |
| **backend-developer** | implement | Server-side code; authors an entity **and** its schema migration together | Read, Edit, Write, Bash, Grep, Glob |
| **frontend-developer** | implement | Client-side code and any BFF/middleware | Read, Edit, Write, Bash, Grep, Glob |
| **db-migration-engineer** | review | Schema-review gate over the migrations the backend authored | Read, Grep, Glob, Bash, Write |
| **code-reviewer** | review | Coding-standards review + runs the project's real linters/scanners | Read, Grep, Glob, Bash, Write |
| **security-reviewer** | review | OWASP Top 10, auth, secrets + dependency scan | Read, Grep, Glob, Bash, Write |
| **test-engineer** | test | Unit + integration tests; E2E when the stack is up | Read, Edit, Write, Bash, Grep, Glob |
| **devops-engineer** | build | Build, container, CI/CD for the touched module(s) | Bash, Read, Edit, Write |

## Write-scope tiering (hook-free)

- **Tier 1 — hard read-only.** requirements-analyst, solution-architect, frontend-designer
  have **no write/shell tools at all** — they cannot touch the repo. They *return* their
  deliverable as their final message and the **orchestrator persists it** to the artifact file.
  This is the strongest guarantee available without hooks, and it survives plugin packaging
  because it comes from the `tools:` allow-list, not from `permissionMode`.
- **Tier 2 — soft read-only.** code-reviewer, security-reviewer, db-migration-engineer need
  `Bash` to run real scanners, so "never edits source" is enforced by **convention** plus an
  optional project-level `settings.json` deny rule (see [Permissions](#permissions)). They
  write only their own `05-review.md`.

## Install

```bash
# 1. Add this repo as a marketplace (local path, a git URL, or owner/repo on GitHub)
/plugin marketplace add /Users/o.kyu.pe/aisle/aisle-agents
#   or:  /plugin marketplace add your-org/aisle-agents

# 2. Install the plugin from it
/plugin install delivery-team@aisle-agents
```

Once installed, start a feature by routing the requirement through the orchestrator:

```
@orchestrator deliver the feature described in docs/specs/my-feature.md
```

## Usage notes

- **The orchestrator is the entry point.** Agents are never auto-triggered — invoke
  `@orchestrator` (or an individual specialist by `@name` for a one-off).
- **Per-feature audit log.** The orchestrator copies `templates/feature/` to
  `artifacts/feature/<ticket>/` and maintains `progress.md` + `00`–`06` there.
- **Resume.** `@orchestrator resume <ticket>` greps for the `IN PROGRESS` marker, reloads
  `progress.md`, and continues from the first unchecked item.
- **Per-project tuning.** Drop a `CLAUDE.md` and (optionally) path-scoped `.claude/rules/`
  into the consuming project so the specialists pick up your stack, build commands, and
  conventions. Generic starter rules are in [`rules/`](rules/) — copy and edit the globs.

## Permissions

A plugin **cannot ship a tool-permission allowlist** — permissions are project/user level.
Add the following to the consuming project's `.claude/settings.json` (or `settings.local.json`)
so the orchestrator and Tier-2 reviewers work smoothly. The first block lets the orchestrator
persist the audit log; the optional deny block hardens the "reviewers never edit source"
convention when you run reviewers in a dedicated session.

```json
{
  "permissions": {
    "allow": [
      "Write(artifacts/feature/**)",
      "Edit(artifacts/feature/**)",
      "Write(docs/decisions/**)",
      "Edit(docs/decisions/**)"
    ]
  }
}
```

For a dedicated reviewer session you can additionally **deny** writes to your source paths,
turning the Tier-2 "soft read-only" convention into a hard guarantee.

## Caveats when running as a plugin

- **`permissionMode` and `mcpServers` in agent frontmatter are ignored** for plugin-loaded
  agents. The implementer agents therefore prompt for edit approval unless you grant
  permissions as above. If you want a design-tool MCP (e.g. Figma) for the frontend-designer,
  configure it at project/user level — it won't auto-attach from the plugin.
- **Tier-1 read-only is unaffected** — it relies on `tools:`, which plugins honour.
- **`${CLAUDE_PLUGIN_ROOT}`** is how the orchestrator locates the shipped `templates/`.
  If your environment doesn't expose it to the agent shell, vendor `templates/feature/`
  into the project at `.claude/templates/feature/` (the orchestrator falls back to that path).

## Tuning for a specific project

The agents are generic. To make them sharp for a given project, give that project:

1. A root `CLAUDE.md` stating the stack, build/test commands, and where the standards docs
   live (coding standards, API standards, security rules, testing guide, etc.).
2. Path-scoped `.claude/rules/` (copy from [`rules/`](rules/) and edit the globs) that point
   the agents at those docs for the relevant directories.

The orchestrator reads all of this in its pre-brief and passes it downstream, so the
specialists behave as if purpose-built for that stack — while the same plugin still works in
any other project.

## Layout

```
.claude-plugin/{plugin.json, marketplace.json}
agents/            11 specialist + orchestrator definitions (stack-agnostic)
commands/          /self-review slash command
templates/feature/ the audit-log scaffold (progress.md + 00–06) + ADR-TEMPLATE.md
rules/             generic path-scoped rule starters to copy into a project
docs/architecture.md  design rationale (the briefing)
```
