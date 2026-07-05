# org-memory scaffold

Starter layout for the **organization-memory repo** described in
[`docs/organization-memory.md`](../../docs/organization-memory.md). This folder is not loaded by
the plugin itself — copy it out to seed a **separate, dedicated git repo** that your org stands up
once and vendors into every project that uses `delivery-team`.

## Setting it up

1. Create a new repo (e.g. `<your-org>/agent-memory-org`) and copy this folder's contents into it.
2. In each consuming project, vendor a **read-only** copy at `.claude/org-memory/` — a git
   submodule, a scheduled `git subtree pull`, or a periodic CI sync job all work; use whatever your
   org already runs. Refresh it on a cadence that suits you (daily, on PR merge to the org-memory
   repo, or on-demand before a feature run).
3. Add `.claude/org-memory/` to each project's `.gitignore` if you sync it rather than submodule
   it, so the vendored copy doesn't get committed twice.

## Layout

| File | Read by | Holds |
|---|---|---|
| `MEMORY.md` | orchestrator (pre-brief) | Index of dated, provenance-tagged entries — the root file agents skim first |
| `conventions.md` | backend-developer, frontend-developer, solution-architect | Cross-project coding/API conventions that recurred often enough to generalize |
| `architecture-precedents.md` | solution-architect | Reusable ADR-style precedents — a decision + context that held up across more than one project |
| `security-findings.md` | security-reviewer, code-reviewer | Recurring vulnerability classes / anti-patterns, generalized past any one project's specifics |
| `review-anti-patterns.md` | code-reviewer | Recurring standards/reachability findings worth watching for on every future review |

Add more topic files as your org's needs grow (e.g. `test-strategy.md`, `design-tokens.md`) —
this starter set maps to the agents that already say "keep this in memory" in their instructions.

## Entry format (use in every file)

```
### <short title>
- **Date added:** YYYY-MM-DD
- **Source:** <project>/<ticket> (the feature run that surfaced this)
- **Status:** ACTIVE | SUPERSEDED by <entry> | RETIRED — <reason>

<the learning itself — generalized, no project-specific names/data>
```

Append-only, like every other log in this pipeline: don't delete a superseded entry, mark it
`SUPERSEDED` and point at what replaced it, so the history of *why* stays intact.

## The review gate

Nothing lands here except through a human-reviewed PR. An orchestrator run may **propose**
promotion candidates (see `docs/organization-memory.md`), but no agent has write access to this
repo, and no automated job should merge into it — a bad entry here is wrong for every project
that pulls it, not just one.
