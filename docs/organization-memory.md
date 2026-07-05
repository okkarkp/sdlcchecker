# Organization memory (three-tier memory model)

What the agents remember, at what scope, and how a learning moves from one feature run to
the whole organization. This is the design doc for the tier Claude Code does **not** provide
natively — read this before assuming "memory" means the same thing everywhere in this repo.

## The three tiers

| Tier | Scope | Mechanism | Survives |
|---|---|---|---|
| **1 — Session** | one conversation | ordinary chat context | that session only |
| **2 — Project memory** | one project checkout | Claude Code native, `memory: project` frontmatter → `.claude/agent-memory/<agent>/MEMORY.md`, committed to *that project's* repo | across sessions, **one project** |
| **3 — Organization memory** | every project in the org | **not** a Claude Code feature — a vendored, human-curated repo (see below) | across sessions **and** projects |

Tiers 1–2 are what Claude Code ships out of the box (see `agents/*.md` frontmatter — every
agent in this plugin declares `memory: project`). Tier 3 is this repo's addition, because nothing
built-in shares learnings across repos or across the people working in them.

### Why tier 3 can't just be `memory: user`

Claude Code's `memory:` field accepts exactly three values: `user`, `project`, `local`.
`user` lives at `~/.claude/agent-memory/<agent>/` — durable across projects, but tied to
**one person's machine**. It is not shared with a teammate, and this plugin's validator
(`scripts/validate_plugin.py`) deliberately restricts agent frontmatter to `project`/`local`
for exactly this reason: a plugin distributed to many users can't assume — or want — every
user's local memory to silently diverge into the shared pipeline. There is no `org` scope.
Organization-wide sharing has to be built the same way any other cross-repo shared asset in
this plugin is built: a **separate repo, vendored in** (the same pattern `rules/` and
`standards/` already use).

## What lives at each tier

| Tier | Example content | Example NOT to put there |
|---|---|---|
| Project memory | This project's per-module quirks, this codebase's naming exceptions, flaky tests specific to this repo | Anything true of every project (belongs in org memory instead — don't duplicate it project-by-project) |
| Org memory | A security anti-pattern that recurred across 3+ projects; an architecture precedent (ADR pattern) worth reusing; a review finding that turned out to be a systemic gap, not a one-off | Secrets, tenant/customer-specific data, PII, anything specific to one project's business logic, unconfirmed/unreviewed hunches |

A learning promoted to org memory should read as true **regardless of which project** an
agent is currently working in. If it needs a project name to make sense, it belongs in that
project's own memory or its `artifacts/feature/<ticket>/` log, not here.

## The org-memory repo (tier 3, mechanics)

1. **Stand it up once**, as its own git repo (e.g. `<your-org>/agent-memory-org`), seeded from
   [`templates/org-memory/`](../templates/org-memory/) in this repo. See that folder's `README.md`
   for the exact layout and starter files.
2. **Vendor a read-only copy** into each consuming project at `.claude/org-memory/` (a
   `git submodule`, a scheduled `git subtree pull`, or a plain periodic `rsync`/CI job — pick
   whatever your org's tooling already supports; this repo doesn't prescribe one because it ships
   no infrastructure of its own). Treat that copy as **read-only** from inside any single
   project — no agent commits to it directly.
3. **Agents read it.** The orchestrator's pre-brief (step 2 in `agents/orchestrator.md`) checks
   for `.claude/org-memory/MEMORY.md` and, if present, folds relevant entries into the pre-brief
   alongside the project's own `CLAUDE.md`/`.claude/rules/` — same tier as "discovered conventions,"
   just sourced from across the org instead of from this one repo.
4. **Agents propose, humans promote.** No agent ever writes directly to `.claude/org-memory/`.
   At a feature's Definition-of-Done, the orchestrator lists **Org-memory promotion candidates**
   in that feature's `progress.md` (durable, project-agnostic learnings surfaced during the run).
   A human reviews the list, and — if it holds up — opens a PR against the org-memory repo itself.
   Merging that PR is the only way tier 3 changes; the next project to vendor-pull it picks up the
   update. This mirrors the gate discipline already used everywhere else in this pipeline
   (`docs/enterprise.md`): nothing gets promoted on an agent's own authority.

## Relationship to the per-feature implementation log

Org memory is **generalized knowledge** ("this class of finding recurs — watch for it").
The per-feature implementation log (`artifacts/feature/<ticket>/04-implementation.md`, or
`docs/implementation-log/<story-id>.md` if you're using the standalone `templates/CLAUDE.md`
methodology without this plugin's orchestrator) is the **specific, project-level record** of
what was actually built, why, and how it was validated for one feature. Implementation logs
are always project-scoped and stay in that project's repo; only a *distillation* of a
recurring pattern across several such logs is a promotion candidate for org memory. See
[`docs/architecture.md`](architecture.md#the-audit-log-resumability) for the implementation-log
mechanics and [`templates/CLAUDE.md`](../templates/CLAUDE.md) §6 for the standalone methodology.

## Summary — where a learning goes

```
Learned this feature only?            → progress.md Log (this ticket)
Learned about this project generally? → memory: project (.claude/agent-memory/<agent>/)
True across every project in the org? → propose it → org-memory repo (human-reviewed PR)
```
